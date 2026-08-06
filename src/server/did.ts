// Hardened DID → DID-document resolution, shared by service-auth JWT
// verification (signing keys) and comic-record verification (PDS endpoints).
// Every code path that turns an untrusted DID into an outbound fetch MUST go
// through this module: the DID syntax and resulting host are validated before
// any network access (SSRF), redirects are never followed, and the fetch is
// bounded by a timeout and a response-size cap.

const DID_DOC_CACHE_TTL_MS = 5 * 60 * 1000
export const DID_DOC_CACHE_MAX = 100
const DID_FETCH_TIMEOUT_MS = 5000
const DID_DOC_MAX_BYTES = 64 * 1024

export type VerificationMethod = {
  id?: string
  type?: string
  controller?: string
  publicKeyMultibase?: string
}

export type DidService = {
  id?: string
  type?: string
  serviceEndpoint?: unknown
}

export type DidDocument = {
  id?: string
  verificationMethod?: VerificationMethod[]
  service?: DidService[]
}

const didDocCache = new Map<string, { doc: DidDocument; expires: number }>()

// The DID is attacker-controlled at this point (a JWT `iss` before signature
// verification, or a record URI), so the syntax and the resulting host are
// validated up front to prevent SSRF.

const PLC_DID_PATTERN = /^did:plc:[a-z2-7]{24}$/
const WEB_DID_PATTERN = /^did:web:[a-zA-Z0-9._%-]+$/
const HOSTNAME_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/

// TLDs that atproto handles (and therefore did:web hosts) must never use:
// https://atproto.com/specs/handle#additional-non-syntax-restrictions
const FORBIDDEN_TLDS = new Set([
  'alt',
  'arpa',
  'example',
  'internal',
  'invalid',
  'local',
  'localhost',
  'onion',
  'test',
])

const isForbiddenHost = (hostname: string) => {
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    return true
  }
  // IPv4 literal (any) and IPv6 literal (bracketed) are never valid did:web hosts.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.includes(':')) {
    return true
  }
  if (hostname.length > 253) {
    return true
  }
  const labels = hostname.split('.')
  if (labels.some((label) => label.length > 63)) {
    return true
  }
  const tld = labels[labels.length - 1]
  // The final label must be a real, letter-initial TLD.
  if (FORBIDDEN_TLDS.has(tld) || !/^[a-z]/.test(tld)) {
    return true
  }
  return false
}

// Whether a hostname is acceptable as an outbound-fetch target for
// attacker-influencable URLs (did:web hosts, PDS endpoints read from DID
// documents): well-formed lowercase DNS name, no IP literals, no localhost,
// no reserved TLDs.
export const isPublicHostname = (hostname: string) =>
  HOSTNAME_PATTERN.test(hostname) && !isForbiddenHost(hostname)

// Reads a response body while enforcing a hard cap on the actual bytes
// received (content-length is attacker-declared and may be absent). The
// caller's AbortController is aborted on overflow so the transfer stops; on
// a declared-oversize early reject the unread body is released (Workers
// otherwise keeps the stream and its memory alive).
export const readBodyCapped = async (
  response: Response,
  controller: AbortController,
  maxBytes: number,
  oversizeMessage: string,
): Promise<string> => {
  const declaredLength = Number(response.headers.get('content-length') ?? 0)
  if (declaredLength > maxBytes) {
    await response.body?.cancel().catch(() => {})
    throw new Error(oversizeMessage)
  }
  if (!response.body) {
    const text = await response.text()
    if (text.length > maxBytes) {
      throw new Error(oversizeMessage)
    }
    return text
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      total += value.byteLength
      if (total > maxBytes) {
        controller.abort()
        throw new Error(oversizeMessage)
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(merged)
}

export const didToDocumentUrl = (did: string): string => {
  // DIDs are case-sensitive identifiers; per the spec, incorrectly-cased
  // protocol input is rejected rather than normalized.
  if (did !== did.toLowerCase()) {
    throw new Error('未対応のDID形式です。')
  }
  if (PLC_DID_PATTERN.test(did)) {
    return `https://plc.directory/${did}`
  }
  if (!WEB_DID_PATTERN.test(did)) {
    throw new Error('未対応のDID形式です。')
  }
  // did:web with path segments (host:path:parts) is not used by atproto PDSes.
  const encodedHost = did.slice('did:web:'.length)
  let host: string
  try {
    host = decodeURIComponent(encodedHost)
  } catch {
    throw new Error('未対応のDID形式です。')
  }
  // Percent-encoding could smuggle uppercase past the DID-level check.
  if (host !== host.toLowerCase()) {
    throw new Error('未対応のDID形式です。')
  }
  // Re-validate AFTER decoding: percent-encoding can smuggle userinfo ("@"),
  // ports, paths, queries and fragments past the raw pattern.
  if (!HOSTNAME_PATTERN.test(host) || isForbiddenHost(host)) {
    throw new Error('未対応のDID形式です。')
  }
  const url = new URL(`https://${host}/.well-known/did.json`)
  if (url.hostname !== host || url.port || url.username || url.password) {
    throw new Error('未対応のDID形式です。')
  }
  return url.toString()
}

export const fetchDidDocument = async (
  did: string,
  options?: { force?: boolean },
): Promise<{ doc: DidDocument; fromCache: boolean }> => {
  if (!options?.force) {
    const cached = didDocCache.get(did)
    if (cached && cached.expires > Date.now()) {
      return { doc: cached.doc, fromCache: true }
    }
  }

  const docUrl = didToDocumentUrl(did)
  const controller = new AbortController()
  // The timer must cover the BODY too: an attacker-owned did:web could send
  // headers instantly and then drip-feed (or flood) the body.
  const timer = setTimeout(() => controller.abort(), DID_FETCH_TIMEOUT_MS)
  let body: string
  try {
    const response = await fetch(docUrl, {
      headers: { Accept: 'application/json' },
      // Never chase a redirect: it could point at an internal address.
      redirect: 'manual',
      signal: controller.signal,
    })
    // Early rejects must release the unread body (Workers otherwise keeps
    // the stream and its memory alive).
    if (!response.ok) {
      await response.body?.cancel().catch(() => {})
      throw new Error(`DIDの解決に失敗しました。(${response.status})`)
    }
    body = await readBodyCapped(
      response,
      controller,
      DID_DOC_MAX_BYTES,
      'DIDドキュメントが大きすぎます。',
    )
  } finally {
    clearTimeout(timer)
  }
  const doc = JSON.parse(body) as DidDocument
  if (doc.id !== did) {
    throw new Error('DIDドキュメントが不正です。')
  }

  if (didDocCache.size >= DID_DOC_CACHE_MAX) {
    const oldest = didDocCache.keys().next().value
    if (oldest) {
      didDocCache.delete(oldest)
    }
  }
  didDocCache.set(did, { doc, expires: Date.now() + DID_DOC_CACHE_TTL_MS })
  return { doc, fromCache: false }
}
