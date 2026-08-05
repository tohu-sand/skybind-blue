// Adversarial regression tests for src/server/serviceAuth.ts.
// Run with: npm run test:auth
// (bundles the module with esbuild first — no Workers runtime needed; DID
// resolution and D1 are mocked.)
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { base58 } from '@scure/base'
import { createHash } from 'node:crypto'

const { verifyServiceJwt, requireServiceAuth } = await import(
  '../.test-bundle/serviceAuth.mjs'
)

const AUD = 'did:web:skybind.blue#skybind_api'
const LXM = 'blue.skybind.manageLink'
const ISS = 'did:plc:abcdefghijklmnopqrstuvwx'

const priv = secp256k1.utils.randomSecretKey()
const pub = secp256k1.getPublicKey(priv)
const toMultikey = (publicKey) =>
  'z' + base58.encode(new Uint8Array([0xe7, 0x01, ...publicKey]))

const didDoc = {
  id: ISS,
  verificationMethod: [
    {
      id: `${ISS}#atproto`,
      type: 'Multikey',
      controller: ISS,
      publicKeyMultibase: toMultikey(pub),
    },
  ],
}

let fetchCount = 0
const fetchedUrls = []
let fetchOverride = null
globalThis.fetch = async (url, init) => {
  fetchCount += 1
  fetchedUrls.push(String(url))
  if (fetchOverride) {
    return fetchOverride(url, init)
  }
  if (String(url).includes('plc.directory')) {
    return new Response(JSON.stringify(didDoc), { status: 200 })
  }
  return new Response('nope', { status: 404 })
}

const b64url = (bytes) =>
  Buffer.from(bytes)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
const enc = (obj) => b64url(new TextEncoder().encode(JSON.stringify(obj)))
const now = () => Math.floor(Date.now() / 1000)

const signWith = (privateKey, h, p) => {
  const hash = new Uint8Array(
    createHash('sha256').update(new TextEncoder().encode(`${h}.${p}`)).digest(),
  )
  let sig = secp256k1.sign(hash, privateKey, { prehash: false })
  return sig instanceof Uint8Array ? sig : sig.toBytes('compact')
}

const makeJwt = (headerOverrides = {}, payloadOverrides = {}, opts = {}) => {
  const header = { typ: 'JWT', alg: 'ES256K', ...headerOverrides }
  for (const key of Object.keys(header)) {
    if (header[key] === undefined) delete header[key]
  }
  const payload = {
    iss: ISS,
    aud: AUD,
    lxm: LXM,
    iat: now(),
    exp: now() + 60,
    jti: 'nonce-' + Math.random().toString(36).slice(2),
    ...payloadOverrides,
  }
  const h = enc(header)
  const p = enc(payload)
  let sig = signWith(opts.priv ?? priv, h, p)
  if (opts.highS) {
    const n = secp256k1.Point.Fn.ORDER
    const r = sig.slice(0, 32)
    let s = BigInt('0x' + Buffer.from(sig.slice(32)).toString('hex'))
    s = n - s
    sig = new Uint8Array([...r, ...Buffer.from(s.toString(16).padStart(64, '0'), 'hex')])
  }
  return `${h}.${p}.${b64url(sig)}`
}

let pass = 0
let fail = 0
// shouldPass=false may pin the EXACT rejection via errorPattern, so an
// unrelated exception (or `throw undefined`) cannot masquerade as the
// expected refusal.
const check = async (name, fn, shouldPass, errorPattern) => {
  let ok
  let detail = ''
  try {
    await fn()
    ok = shouldPass
    if (!ok) detail = 'resolved but rejection expected'
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (shouldPass) {
      ok = false
      detail = message
    } else if (errorPattern && !errorPattern.test(message)) {
      ok = false
      detail = `rejected with wrong error: ${message}`
    } else {
      ok = true
    }
    if (process.env.VERBOSE) console.log(`   (${name}: ${message})`)
  }
  if (ok) {
    pass += 1
    console.log(`ok   ${name}`)
  } else {
    fail += 1
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}
const verify = (token) => verifyServiceJwt(token, { lxm: LXM })

console.log('--- JWT claim validation ---')
await check('valid token accepted', () => verify(makeJwt()), true)
await check('missing typ rejected', () => verify(makeJwt({ typ: undefined })), false)
await check('typ=at+jwt rejected', () => verify(makeJwt({ typ: 'at+jwt' })), false)
await check('missing jti rejected', () => verify(makeJwt({}, { jti: undefined })), false)
await check('missing iat rejected', () => verify(makeJwt({}, { iat: undefined })), false)
await check('exp=1e309 (Infinity) rejected', () => verify(makeJwt({}, { exp: 1e309 })), false)
await check('exp 1 year out rejected', () => verify(makeJwt({}, { exp: now() + 31536000 })), false)
await check('future iat rejected', () => verify(makeJwt({}, { iat: now() + 600 })), false)
await check('expired token rejected', () => verify(makeJwt({}, { iat: now() - 600, exp: now() - 300 })), false)
await check('exp <= iat rejected', () => verify(makeJwt({}, { iat: now(), exp: now() })), false)
await check('wrong aud rejected', () => verify(makeJwt({}, { aud: 'did:web:evil.example' })), false)
await check('bare-DID aud rejected', () => verify(makeJwt({}, { aud: 'did:web:skybind.blue' })), false)
await check('wrong lxm rejected', () => verify(makeJwt({}, { lxm: 'com.atproto.repo.createRecord' })), false)
await check('kid=#atproto accepted', () => verify(makeJwt({ kid: '#atproto' })), true)
await check('fully-qualified kid rejected', () => verify(makeJwt({ kid: `${ISS}#atproto` })), false)
await check('bad kid rejected', () => verify(makeJwt({ kid: '#evil' })), false)
await check('alg=none rejected', () => verify(makeJwt({ alg: 'none' })), false)
await check('alg=ES256 with k256 key rejected', () => verify(makeJwt({ alg: 'ES256' })), false)
await check('tampered payload rejected', () => {
  const t = makeJwt()
  const [h, , s] = t.split('.')
  return verify(`${h}.${enc({ iss: ISS, aud: AUD, lxm: LXM, iat: now(), exp: now() + 60, jti: 'x' })}.${s}`)
}, false)
await check('high-S signature rejected (malleability)', () => verify(makeJwt({}, {}, { highS: true })), false)

console.log('--- DID document constraints (uncached DIDs) ---')
// A dedicated DID per case: mutating the shared doc would be masked by the
// module's cache, which still holds the valid copy.
const constraintCase = async (name, mutate) => {
  const iss = `did:plc:${name.padEnd(24, 'x').slice(0, 24)}`
  const doc = {
    id: iss,
    verificationMethod: [
      {
        id: `${iss}#atproto`,
        type: 'Multikey',
        controller: iss,
        publicKeyMultibase: toMultikey(pub),
      },
    ],
  }
  mutate(doc.verificationMethod[0])
  fetchOverride = () => new Response(JSON.stringify(doc), { status: 200 })
  try {
    await verify(makeJwt({}, { iss, jti: name + Math.random() }))
  } finally {
    fetchOverride = null
  }
}
await check(
  'missing controller rejected',
  () => constraintCase('noctl', (m) => delete m.controller),
  false,
)
await check(
  'wrong controller rejected',
  () => constraintCase('badctl', (m) => (m.controller = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa')),
  false,
)
await check(
  'non-Multikey type rejected',
  () => constraintCase('badtype', (m) => (m.type = 'EcdsaSecp256k1VerificationKey2019')),
  false,
)

console.log('--- SSRF guards (no network call may escape) ---')
const ssrfCases = [
  'did:web:127.0.0.1',
  'did:web:localhost',
  'did:web:example.com%40169.254.169.254',
  'did:web:192.168.0.1',
  'did:web:skybind.blue%3A8080',
  'did:web:example.com%2Fpath',
  'did:web:example.com%3Fq%3D1',
  'did:web:example.com%23frag',
  'did:web:user%40evil.example',
  'did:web:foo.arpa',
  'did:web:foo.local',
  'did:web:foo.internal',
  'did:web:metadata.google.internal',
  'did:web:foo.onion',
  'did:web:foo.example',
  'did:web:foo.test',
  'did:web:Example.COM',
  'did:web:%41bc.example.com',
  `did:web:${'a'.repeat(64)}.example.com`,
  `did:web:${('a'.repeat(60) + '.').repeat(5)}example.com`,
  'did:web:example.123',
  'did:plc:tooshort',
  'did:plc:ABCDEFGHIJKLMNOPQRSTUVWX',
  'did:evil:whatever',
]
for (const badIss of ssrfCases) {
  const before = fetchCount
  await check(`iss=${badIss.slice(0, 60)} rejected`, () => verify(makeJwt({}, { iss: badIss })), false)
  if (fetchCount !== before) {
    console.log(`   !! NETWORK CALL ESCAPED: ${fetchedUrls[fetchedUrls.length - 1]}`)
    fail += 1
  }
}

console.log('--- response body limits (attacker-owned did:web) ---')
const WEB_ISS = 'did:web:evil-pds.example.com'
{
  let enqueued = 0
  fetchOverride = () => {
    const stream = new ReadableStream({
      pull(controller) {
        // 16 KiB per pull, endless supply: only reads consume it.
        enqueued += 16384
        controller.enqueue(new Uint8Array(16384))
      },
    })
    return new Response(stream, { status: 200 })
  }
  await check(
    'oversized body without content-length rejected with size error',
    () => verify(makeJwt({}, { iss: WEB_ISS, jti: 'big-' + Math.random() })),
    false,
    /大きすぎ/,
  )
  fetchOverride = null
  // Independent assertion: the reader must stop within two chunks of the cap
  // (one read that crosses the cap + one chunk of stream readahead).
  console.log(`   bytes served before cutoff: ${enqueued}`)
  if (enqueued > 64 * 1024 + 2 * 16384) {
    fail += 1
    console.log(`FAIL body read exceeded cap before rejecting (${enqueued} bytes)`)
  } else {
    pass += 1
    console.log('ok   body read stopped within two chunks of the 64KiB cap')
  }
}
{
  // Declared-oversize responses must have their unread body cancelled.
  let cancelled = false
  fetchOverride = () => {
    const stream = new ReadableStream({
      pull(controller) {
        controller.enqueue(new Uint8Array(1024))
      },
      cancel() {
        cancelled = true
      },
    })
    return new Response(stream, {
      status: 200,
      headers: { 'content-length': String(70 * 1024) },
    })
  }
  await check(
    'declared 70KB content-length rejected with size error',
    () => verify(makeJwt({}, { iss: WEB_ISS, jti: 'cl-' + Math.random() })),
    false,
    /大きすぎ/,
  )
  fetchOverride = null
  if (cancelled) {
    pass += 1
    console.log('ok   unread body cancelled on early reject')
  } else {
    fail += 1
    console.log('FAIL unread body was not cancelled on early reject')
  }
}
await check('slow body aborted by timeout (~5s)', async () => {
  fetchOverride = (url, init) => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{'))
        // never closes; the fetch timeout must abort the read
        init?.signal?.addEventListener('abort', () => {
          try {
            controller.error(new Error('aborted'))
          } catch {}
        })
      },
    })
    return new Response(stream, { status: 200 })
  }
  try {
    await verify(makeJwt({}, { iss: WEB_ISS, jti: 'slow-' + Math.random() }))
  } finally {
    fetchOverride = null
  }
}, false)

console.log('--- replay prevention ---')
const seen = new Set()
const db = {
  prepare(sql) {
    return {
      bind(...args) {
        return {
          async run() {
            if (sql.startsWith('INSERT OR IGNORE')) {
              if (seen.has(args[0])) return { meta: { changes: 0 } }
              seen.add(args[0])
              return { meta: { changes: 1 } }
            }
            return { meta: { changes: 0 } }
          },
        }
      },
    }
  },
}
const token = makeJwt()
await check('first use accepted', async () => {
  const did = await requireServiceAuth(`Bearer ${token}`, LXM, db)
  if (did !== ISS) throw new Error('wrong did')
}, true)
await check('replay of same token rejected', () => requireServiceAuth(`Bearer ${token}`, LXM, db), false, /再利用/)
await check('missing Authorization rejected', () => requireServiceAuth(undefined, LXM, db), false)

console.log('--- key rotation (dedicated DID: earlier bad-signature cases')
console.log('    already consumed the shared DID\'s refetch-cooldown slot) ---')
const ROT_ISS = 'did:plc:ccdefghijklmnopqrstuvwxy'.slice(0, 32)
const priv2 = secp256k1.utils.randomSecretKey()
const rotDoc = {
  id: ROT_ISS,
  verificationMethod: [
    {
      id: `${ROT_ISS}#atproto`,
      type: 'Multikey',
      controller: ROT_ISS,
      publicKeyMultibase: toMultikey(pub),
    },
  ],
}
fetchOverride = () => new Response(JSON.stringify(rotDoc), { status: 200 })
const rotJwt = (privateKey, jti) => {
  const h = enc({ typ: 'JWT', alg: 'ES256K' })
  const p = enc({ iss: ROT_ISS, aud: AUD, lxm: LXM, iat: now(), exp: now() + 60, jti })
  return `${h}.${p}.${b64url(signWith(privateKey, h, p))}`
}
await check('pre-rotation token accepted (caches old key)', () => verify(rotJwt(priv, 'rot-a')), true)
rotDoc.verificationMethod[0].publicKeyMultibase = toMultikey(secp256k1.getPublicKey(priv2))
await check('OLD-key token still valid while cache is fresh', () => verify(rotJwt(priv, 'rot-b')), true)
await check('NEW-key token accepted via cache bypass', () => verify(rotJwt(priv2, 'rot-c')), true)
// The forced refetch consumed ROT_ISS's cooldown slot and cached the NEW key.
// An old-key token must now be rejected WITHOUT another fetch.
{
  const before = fetchCount
  await check(
    'OLD-key token during cooldown rejected without network',
    () => verify(rotJwt(priv, 'rot-d')),
    false,
    /署名の検証に失敗/,
  )
  if (fetchCount === before) {
    pass += 1
    console.log('ok   no refetch during cooldown')
  } else {
    fail += 1
    console.log('FAIL cooldown did not prevent refetch')
  }
}
fetchOverride = null

// Uncached DID + wrong key: exactly one fetch, no forced-refetch amplification.
const ISS2 = 'did:plc:bbcdefghijklmnopqrstuvwx'
const doc2 = {
  ...didDoc,
  id: ISS2,
  verificationMethod: [
    { ...didDoc.verificationMethod[0], id: `${ISS2}#atproto`, controller: ISS2 },
  ],
}
fetchOverride = (url) =>
  new Response(JSON.stringify(String(url).includes(ISS2) ? doc2 : didDoc), { status: 200 })
const beforeUncached = fetchCount
await check('uncached DID: wrong-key signature rejected', () => {
  const h = enc({ typ: 'JWT', alg: 'ES256K' })
  const p = enc({ iss: ISS2, aud: AUD, lxm: LXM, iat: now(), exp: now() + 60, jti: 'stale-1' })
  // Signed with priv2, but doc2 publishes the ORIGINAL pub — wrong key.
  return verify(`${h}.${p}.${b64url(signWith(priv2, h, p))}`)
}, false, /署名の検証に失敗/)
fetchOverride = null
const used = fetchCount - beforeUncached
console.log(`   fetches for uncached bad signature: ${used}`)
if (used > 1) {
  console.log('   !! outbound amplification: more than one fetch')
  fail += 1
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
