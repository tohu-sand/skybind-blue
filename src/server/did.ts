// Resolve untrusted DIDs here so auth and record verification share SSRF guards.

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

const PLC_DID_PATTERN = /^did:plc:[a-z2-7]{24}$/
const WEB_DID_PATTERN = /^did:web:[a-zA-Z0-9._%-]+$/
const HOSTNAME_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/

// Reserved TLDs for atproto handles and did:web hosts:
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
  // did:web hosts must be DNS names, not IP literals.
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
  if (FORBIDDEN_TLDS.has(tld) || !/^[a-z]/.test(tld)) {
    return true
  }
  return false
}

export const isPublicHostname = (hostname: string) =>
  HOSTNAME_PATTERN.test(hostname) && !isForbiddenHost(hostname)

// Count actual bytes; Content-Length may be missing or incorrect.
// Cancel rejected bodies to release the stream and its memory in Workers.
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
  // DIDs are case-sensitive; reject invalid casing rather than normalize it.
  if (did !== did.toLowerCase()) {
    throw new Error('未対応のDID形式です。')
  }
  if (PLC_DID_PATTERN.test(did)) {
    return `https://plc.directory/${did}`
  }
  if (!WEB_DID_PATTERN.test(did)) {
    throw new Error('未対応のDID形式です。')
  }
  // atproto supports did:web hosts without path segments.
  const encodedHost = did.slice('did:web:'.length)
  let host: string
  try {
    host = decodeURIComponent(encodedHost)
  } catch {
    throw new Error('未対応のDID形式です。')
  }
  // Decoding may reveal uppercase characters hidden from the DID-level check.
  if (host !== host.toLowerCase()) {
    throw new Error('未対応のDID形式です。')
  }
  // Decoding may also reveal userinfo, ports, paths, queries or fragments.
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
  // Include the body read in the timeout to bound slow or oversized responses.
  const timer = setTimeout(() => controller.abort(), DID_FETCH_TIMEOUT_MS)
  let body: string
  try {
    const response = await fetch(docUrl, {
      headers: { Accept: 'application/json' },
      // Redirects could point to internal addresses.
      redirect: 'manual',
      signal: controller.signal,
    })
    // Release the unread body on early rejection.
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
