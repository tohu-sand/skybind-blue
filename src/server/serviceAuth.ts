// Verify PDS-issued JWTs against the account's DID signing key.
// https://atproto.com/specs/xrpc#inter-service-authentication-jwt

import { p256 } from '@noble/curves/nist.js'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { base58 } from '@scure/base'
import { HTTPException } from 'hono/http-exception'
import { SERVICE_AUTH_AUD } from '../shared/comicRecord'
import { DID_DOC_CACHE_MAX, fetchDidDocument, type DidDocument } from './did'

const CLOCK_SKEW_SECONDS = 60
// Allow headroom beyond the spec's recommended 60 seconds for slow uploads.
const MAX_TOKEN_LIFETIME_SECONDS = 15 * 60
// Retain consumed nonces until their tokens are outside the accepted lifetime.
const JTI_RETENTION_SECONDS = MAX_TOKEN_LIFETIME_SECONDS + CLOCK_SKEW_SECONDS

// Limit forced DID fetches triggered by invalid signatures.
const FORCE_REFETCH_COOLDOWN_MS = 60 * 1000
const forcedRefetchAt = new Map<string, number>()

const b64urlToBytes = (value: string): Uint8Array => {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) {
    throw new Error('JWTセグメントが不正です。')
  }
  const b64 = value.replace(/-/g, '+').replace(/_/g, '/')
  const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4))
  const bin = atob(b64 + pad)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i += 1) {
    bytes[i] = bin.charCodeAt(i)
  }
  return bytes
}

const decodeJsonSegment = (segment: string): Record<string, unknown> => {
  const parsed: unknown = JSON.parse(new TextDecoder().decode(b64urlToBytes(segment)))
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('JWTセグメントが不正です。')
  }
  return parsed as Record<string, unknown>
}

// did:key-style multibase: 'z' + base58btc(multicodec varint + compressed key)
const parseSigningKey = (
  multibase: string,
): { curve: 'ES256K' | 'ES256'; key: Uint8Array } => {
  if (!multibase.startsWith('z')) {
    throw new Error('署名鍵の形式が不正です。')
  }
  const bytes = base58.decode(multibase.slice(1))
  if (bytes.length === 35 && bytes[0] === 0xe7 && bytes[1] === 0x01) {
    return { curve: 'ES256K', key: bytes.slice(2) }
  }
  if (bytes.length === 35 && bytes[0] === 0x80 && bytes[1] === 0x24) {
    return { curve: 'ES256', key: bytes.slice(2) }
  }
  throw new Error('未対応の署名鍵です。')
}

const getAtprotoSigningKey = (doc: DidDocument, did: string) => {
  const method = doc.verificationMethod?.find(
    (entry) => entry?.id === '#atproto' || entry?.id === `${did}#atproto`,
  )
  if (!method?.publicKeyMultibase) {
    throw new Error('署名鍵が見つかりませんでした。')
  }
  if (method.type !== 'Multikey') {
    throw new Error('署名鍵の型が不正です。')
  }
  if (method.controller !== did) {
    throw new Error('署名鍵のcontrollerが一致しません。')
  }
  return parseSigningKey(method.publicKeyMultibase)
}

const isSecondsTimestamp = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0

const verifySignature = (
  doc: DidDocument,
  did: string,
  alg: string,
  msgHash: Uint8Array,
  signature: Uint8Array,
) => {
  const { curve, key } = getAtprotoSigningKey(doc, did)
  if (curve !== alg) {
    throw new Error('署名アルゴリズムが鍵と一致しません。')
  }
  const verifier = curve === 'ES256K' ? secp256k1 : p256
  // Keep the default lowS: true; atproto requires low-S signatures.
  return verifier.verify(signature, msgHash, key, { prehash: false })
}

export type VerifiedServiceJwt = {
  did: string
  jti: string
  expiresAt: number
}

export const verifyServiceJwt = async (
  token: string,
  expected: { lxm: string },
): Promise<VerifiedServiceJwt> => {
  const segments = token.split('.')
  if (segments.length !== 3) {
    throw new Error('JWTの形式が不正です。')
  }
  const [headerSeg, payloadSeg, sigSeg] = segments

  const header = decodeJsonSegment(headerSeg)
  if (header.typ !== 'JWT') {
    throw new Error('typが不正です。')
  }
  if (header.alg !== 'ES256K' && header.alg !== 'ES256') {
    throw new Error('未対応の署名アルゴリズムです。')
  }
  if (header.crit !== undefined) {
    throw new Error('未対応のJWTヘッダーです。')
  }
  // The spec requires kid to be omitted or a fragment-only key ID.
  if (header.kid !== undefined && header.kid !== '#atproto') {
    throw new Error('kidが不正です。')
  }

  const payload = decodeJsonSegment(payloadSeg)
  const iss = typeof payload.iss === 'string' ? payload.iss : ''
  if (!iss.startsWith('did:')) {
    throw new Error('issが不正です。')
  }
  if (payload.aud !== SERVICE_AUTH_AUD) {
    throw new Error('audが一致しません。')
  }
  if (payload.lxm !== expected.lxm) {
    throw new Error('lxmが一致しません。')
  }

  // JSON numbers such as 1e309 parse as Infinity and must not bypass expiry.
  if (!isSecondsTimestamp(payload.exp) || !isSecondsTimestamp(payload.iat)) {
    throw new Error('exp/iatが不正です。')
  }
  const exp = payload.exp
  const iat = payload.iat
  const nowSeconds = Math.floor(Date.now() / 1000)
  if (exp <= iat) {
    throw new Error('expがiatより後ではありません。')
  }
  if (exp - iat > MAX_TOKEN_LIFETIME_SECONDS) {
    throw new Error('トークンの有効期間が長すぎます。')
  }
  if (iat > nowSeconds + CLOCK_SKEW_SECONDS) {
    throw new Error('iatが未来です。')
  }
  if (exp < nowSeconds - CLOCK_SKEW_SECONDS) {
    throw new Error('トークンの有効期限が切れています。')
  }

  // The caller must consume this nonce to prevent replay.
  const jti = typeof payload.jti === 'string' ? payload.jti : ''
  if (!jti || jti.length > 128) {
    throw new Error('jtiが不正です。')
  }

  const signingInput = new TextEncoder().encode(`${headerSeg}.${payloadSeg}`)
  const msgHash = new Uint8Array(await crypto.subtle.digest('SHA-256', signingInput))
  const signature = b64urlToBytes(sigSeg)
  if (signature.length !== 64) {
    throw new Error('署名の形式が不正です。')
  }

  const { doc, fromCache } = await fetchDidDocument(iss)
  let valid = false
  try {
    valid = verifySignature(doc, iss, header.alg, msgHash, signature)
  } catch (err) {
    if (!fromCache) {
      throw err
    }
    console.error('signature check against cached DID document failed:', err)
  }
  // A cached key may predate rotation; refresh at most once per cooldown.
  if (!valid && fromCache) {
    const lastForced = forcedRefetchAt.get(iss) ?? 0
    if (Date.now() - lastForced > FORCE_REFETCH_COOLDOWN_MS) {
      if (forcedRefetchAt.size >= DID_DOC_CACHE_MAX) {
        const oldest = forcedRefetchAt.keys().next().value
        if (oldest) {
          forcedRefetchAt.delete(oldest)
        }
      }
      forcedRefetchAt.set(iss, Date.now())
      const fresh = await fetchDidDocument(iss, { force: true })
      valid = verifySignature(fresh.doc, iss, header.alg, msgHash, signature)
    }
  }
  if (!valid) {
    throw new Error('署名の検証に失敗しました。')
  }

  return { did: iss, jti, expiresAt: exp }
}

// Consume (iss, jti) atomically; false indicates replay.
const consumeJti = async (
  db: D1Database,
  did: string,
  jti: string,
  expiresAt: number,
): Promise<boolean> => {
  const result = await db
    .prepare(
      'INSERT OR IGNORE INTO service_auth_jti (jti, author_did, expires_at) VALUES (?, ?, ?)',
    )
    .bind(`${did}|${jti}`, did, expiresAt)
    .run()
  return Boolean(result.meta.changes && result.meta.changes > 0)
}

export const purgeExpiredJti = (db: D1Database) =>
  db
    .prepare('DELETE FROM service_auth_jti WHERE expires_at < ?')
    .bind(Math.floor(Date.now() / 1000) - JTI_RETENTION_SECONDS)
    .run()

export const requireServiceAuth = async (
  authorization: string | undefined,
  lxm: string,
  db: D1Database,
): Promise<string> => {
  if (!authorization?.startsWith('Bearer ')) {
    throw new HTTPException(401, {
      message: '認証が必要です。ログインし直してください。',
    })
  }

  let verified: VerifiedServiceJwt
  try {
    verified = await verifyServiceJwt(
      authorization.slice('Bearer '.length).trim(),
      { lxm },
    )
  } catch (err) {
    console.error('service auth verification failed:', err)
    throw new HTTPException(401, {
      message: '認証に失敗しました。ログインし直してください。',
    })
  }

  let fresh: boolean
  try {
    fresh = await consumeJti(db, verified.did, verified.jti, verified.expiresAt)
  } catch (err) {
    console.error('jti consumption failed:', err)
    throw new HTTPException(500, { message: '認証処理に失敗しました。' })
  }
  if (!fresh) {
    throw new HTTPException(401, {
      message: '認証トークンが再利用されました。操作をやり直してください。',
    })
  }

  return verified.did
}
