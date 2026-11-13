import { secp256k1 } from '@noble/curves/secp256k1.js'
import { base58 } from '@scure/base'
import { createHash } from 'node:crypto'

const { app } = await import('../.test-bundle/serverApi.mjs')
const { resolvePdsEndpoint, fetchRepoRecord } = await import(
  '../.test-bundle/manga.mjs'
)

const AUD = 'did:web:skybind.blue#skybind_api'
const LXM = 'blue.skybind.manageLink'
const AUTHOR = 'did:plc:abcdefghijklmnopqrstuvwx'
const OTHER = `did:plc:${'otherauthor'.padEnd(24, 'a')}`
const SUBJECT_CID = 'bafyreisubjectaaaaaaaaaa'
const RECORD_CID = 'bafyreirecordaaaaaaaaaaa'
const WRONG_CID = 'bafyreiwrongaaaaaaaaaaaa'
const COLLECTION = 'blue.skybind.comic'
const PDS = 'https://pds.example.com'

const plcDid = (name) => `did:plc:${name.padEnd(24, 'x').slice(0, 24)}`
const postUri = (rkey, did = AUTHOR) => `at://${did}/app.bsky.feed.post/${rkey}`
const recUri = (rkey, did = AUTHOR) => `at://${did}/${COLLECTION}/${rkey}`
const viewer = (id) => `https://skybind.blue/v/${id}`

const priv = secp256k1.utils.randomSecretKey()
const pub = secp256k1.getPublicKey(priv)
const privOther = secp256k1.utils.randomSecretKey()
const pubOther = secp256k1.getPublicKey(privOther)
const toMultikey = (publicKey) =>
  'z' + base58.encode(new Uint8Array([0xe7, 0x01, ...publicKey]))

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
  const sig = secp256k1.sign(hash, privateKey, { prehash: false })
  return sig instanceof Uint8Array ? sig : sig.toBytes('compact')
}
const makeJwt = (iss = AUTHOR, privateKey = priv) => {
  const h = enc({ typ: 'JWT', alg: 'ES256K' })
  const p = enc({
    iss,
    aud: AUD,
    lxm: LXM,
    iat: now(),
    exp: now() + 60,
    jti: 'nonce-' + Math.random().toString(36).slice(2),
  })
  return `${h}.${p}.${b64url(signWith(privateKey, h, p))}`
}

const didDocs = new Map() // DID -> DID document
const records = new Map() // `${repo}|${collection}|${rkey}` -> getRecord response
const threads = new Map() // Post URI -> post view
const feeds = new Map() // DID -> getAuthorFeed items (single page, no cursor)
const fetchLog = []
let lastDidFetchInit = null
let fetchOverride = null

didDocs.set(AUTHOR, {
  id: AUTHOR,
  verificationMethod: [
    {
      id: `${AUTHOR}#atproto`,
      type: 'Multikey',
      controller: AUTHOR,
      publicKeyMultibase: toMultikey(pub),
    },
  ],
  service: [
    {
      id: '#atproto_pds',
      type: 'AtprotoPersonalDataServer',
      serviceEndpoint: PDS,
    },
  ],
})
didDocs.set(OTHER, {
  id: OTHER,
  verificationMethod: [
    {
      id: `${OTHER}#atproto`,
      type: 'Multikey',
      controller: OTHER,
      publicKeyMultibase: toMultikey(pubOther),
    },
  ],
  service: [
    {
      id: '#atproto_pds',
      type: 'AtprotoPersonalDataServer',
      serviceEndpoint: PDS,
    },
  ],
})

globalThis.fetch = async (input, init) => {
  const url = new URL(String(input))
  fetchLog.push(url.toString())
  if (fetchOverride) {
    const forced = fetchOverride(url, init)
    if (forced) {
      return forced
    }
  }
  if (url.hostname === 'plc.directory') {
    lastDidFetchInit = init ?? null
    const doc = didDocs.get(url.pathname.slice(1))
    return doc
      ? Response.json(doc)
      : new Response('not found', { status: 404 })
  }
  if (url.pathname === '/.well-known/did.json') {
    lastDidFetchInit = init ?? null
    const doc = didDocs.get(`did:web:${url.hostname}`)
    return doc
      ? Response.json(doc)
      : new Response('not found', { status: 404 })
  }
  if (url.pathname === '/xrpc/com.atproto.repo.getRecord') {
    const key = `${url.searchParams.get('repo')}|${url.searchParams.get('collection')}|${url.searchParams.get('rkey')}`
    const rec = records.get(key)
    return rec
      ? Response.json(rec)
      : Response.json(
          { error: 'RecordNotFound', message: 'Could not locate record' },
          { status: 400 },
        )
  }
  if (url.pathname === '/xrpc/app.bsky.feed.getAuthorFeed') {
    const actor = url.searchParams.get('actor')
    return Response.json({ feed: feeds.get(actor) ?? [] })
  }
  if (url.pathname === '/xrpc/app.bsky.feed.getPostThread') {
    const post = threads.get(url.searchParams.get('uri'))
    return post
      ? Response.json({
          thread: {
            $type: 'app.bsky.feed.defs#threadViewPost',
            post,
            replies: [],
          },
        })
      : Response.json(
          { error: 'NotFound', message: 'Post not found' },
          { status: 400 },
        )
  }
  return new Response(`unexpected fetch: ${url}`, { status: 500 })
}

const makeDb = () => {
  const rows = new Map()
  const jtiSeen = new Set()
  // Match the quota SQL: pending links older than 24 hours do not count.
  const freshCount = (author) => {
    const cutoff = Math.floor(Date.now() / 1000) - 24 * 60 * 60
    let count = 0
    for (const row of rows.values()) {
      if (
        row.author_did === author &&
        !(row.state === 'pending' && (row.created_at ?? 0) < cutoff)
      ) {
        count += 1
      }
    }
    return count
  }
  return {
    rows,
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async first() {
              if (sql.startsWith('SELECT COUNT(1) as count FROM manga_links')) {
                return { count: freshCount(args[0]) }
              }
              if (sql.startsWith('SELECT id, author_did')) {
                // Copy D1's SELECT snapshot so concurrent mutations stay isolated.
                const row = rows.get(args[0])
                return row ? { ...row } : null
              }
              if (sql.startsWith('SELECT id FROM manga_links')) {
                for (const row of rows.values()) {
                  if (
                    row.author_did === args[0] &&
                    row.original_post_uri === args[1] &&
                    row.state === 'active'
                  ) {
                    return { id: row.id }
                  }
                }
                return null
              }
              throw new Error(`unexpected first(): ${sql}`)
            },
            async all() {
              if (sql.startsWith('SELECT id, title, start_side')) {
                const results = [...rows.values()]
                  .filter((row) => row.author_did === args[0])
                  .sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0))
                  .map((row) => ({
                    id: row.id,
                    title: row.title,
                    start_side: row.start_side,
                    original_post_uri: row.original_post_uri,
                    record_cid: row.record_cid,
                    state: row.state,
                    created_at: row.created_at ?? null,
                  }))
                  .slice(0, 200)
                return { results }
              }
              throw new Error(`unexpected all(): ${sql}`)
            },
            async run() {
              if (sql.startsWith('INSERT OR IGNORE INTO service_auth_jti')) {
                if (jtiSeen.has(args[0])) {
                  return { meta: { changes: 0 } }
                }
                jtiSeen.add(args[0])
                return { meta: { changes: 1 } }
              }
              if (sql.startsWith('DELETE FROM service_auth_jti')) {
                return { meta: { changes: 0 } }
              }
              if (
                sql.startsWith(
                  'UPDATE manga_links SET original_post_uri = ?, record_cid',
                )
              ) {
                // CAS: WHERE id = ? AND original_post_uri = ? AND record_cid IS ?
                const [uri, cid, title, startSide, id, prevUri, prevCid] = args
                const row = rows.get(id)
                if (
                  !row ||
                  row.original_post_uri !== prevUri ||
                  row.record_cid !== prevCid
                ) {
                  return { meta: { changes: 0 } }
                }
                Object.assign(row, {
                  original_post_uri: uri,
                  record_cid: cid,
                  title,
                  start_side: startSide,
                  state: 'active',
                })
                return { meta: { changes: 1 } }
              }
              if (sql.startsWith('UPDATE manga_links SET original_post_uri')) {
                // CAS: WHERE id = ? AND original_post_uri = 'pending'
                const [uri, id] = args
                const row = rows.get(id)
                if (!row || row.original_post_uri !== 'pending') {
                  return { meta: { changes: 0 } }
                }
                Object.assign(row, { original_post_uri: uri, state: 'active' })
                return { meta: { changes: 1 } }
              }
              if (sql.startsWith('UPDATE manga_links SET record_cid = NULL')) {
                // CAS: WHERE id = ? AND author_did = ? AND record_cid = ?
                const [id, author, cid] = args
                const row = rows.get(id)
                if (
                  !row ||
                  row.author_did !== author ||
                  row.record_cid !== cid
                ) {
                  return { meta: { changes: 0 } }
                }
                row.record_cid = null
                return { meta: { changes: 1 } }
              }
              if (sql.startsWith('DELETE FROM manga_links WHERE author_did')) {
                // Match the 180-day SQL cutoff; quota expiry is 24 hours.
                const [author] = args
                const cutoff = Math.floor(Date.now() / 1000) - 180 * 24 * 60 * 60
                let changes = 0
                for (const [key, row] of [...rows]) {
                  if (
                    row.author_did === author &&
                    row.state === 'pending' &&
                    (row.created_at ?? 0) < cutoff
                  ) {
                    rows.delete(key)
                    changes += 1
                  }
                }
                return { meta: { changes } }
              }
              if (sql.startsWith('DELETE FROM manga_links')) {
                const [id, author] = args
                const row = rows.get(id)
                if (!row || row.author_did !== author) {
                  return { meta: { changes: 0 } }
                }
                rows.delete(id)
                return { meta: { changes: 1 } }
              }
              if (sql.startsWith('INSERT INTO manga_links')) {
                // Enforce the quota within each insert, as the SQL does.
                if (sql.includes('WHERE NOT EXISTS')) {
                  const [id, author, title, pagesJson, startSide, uri] = args
                  for (const row of rows.values()) {
                    if (
                      row.author_did === author &&
                      row.original_post_uri === uri &&
                      row.state === 'active'
                    ) {
                      return { meta: { changes: 0 } }
                    }
                  }
                  if (freshCount(author) >= 100) {
                    return { meta: { changes: 0 } }
                  }
                  rows.set(id, {
                    id,
                    author_did: author,
                    title,
                    pages_json: pagesJson,
                    start_side: startSide,
                    original_post_uri: uri,
                    state: 'active',
                    record_cid: null,
                    created_at: Math.floor(Date.now() / 1000),
                  })
                  return { meta: { changes: 1 } }
                }
                const [id, author, title, pagesJson, startSide, uri, state] = args
                if (freshCount(author) >= 100) {
                  return { meta: { changes: 0 } }
                }
                rows.set(id, {
                  id,
                  author_did: author,
                  title,
                  pages_json: pagesJson,
                  start_side: startSide,
                  original_post_uri: uri,
                  state,
                  record_cid: null,
                  created_at: Math.floor(Date.now() / 1000),
                })
                return { meta: { changes: 1 } }
              }
              throw new Error(`unexpected run(): ${sql}`)
            },
          }
        },
      }
    },
  }
}

const db = makeDb()
const env = {
  DB: db,
  APP_URL: 'https://skybind.blue',
  BSKY_PUBLIC_API: 'https://public.api.bsky.app',
}
const ctx = {
  waitUntil(promise) {
    Promise.resolve(promise).catch(() => {})
  },
  passThroughOnException() {},
}

// Skip edge caching so viewer tests always exercise the request handler.
globalThis.caches = {
  default: {
    async match() {
      return undefined
    },
    async put() {},
  },
}

// Use a fresh IP per request to isolate rate limits between tests.
let ipCounter = 0
const nextIp = () => `203.0.113.${(ipCounter += 1)}`
const post = (path, body, opts = {}) =>
  app.request(
    path,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'CF-Connecting-IP': opts.ip ?? nextIp(),
        ...(opts.auth ? { Authorization: `Bearer ${opts.auth}` } : {}),
      },
      body: opts.rawBody ?? JSON.stringify(body),
    },
    env,
    ctx,
  )

const send = (path, method, opts = {}) =>
  app.request(
    path,
    {
      method,
      headers: {
        'CF-Connecting-IP': opts.ip ?? nextIp(),
        ...(opts.auth ? { Authorization: `Bearer ${opts.auth}` } : {}),
      },
    },
    env,
    ctx,
  )

const addRow = (id, overrides = {}) => {
  db.rows.set(id, {
    id,
    author_did: AUTHOR,
    title: null,
    start_side: null,
    original_post_uri: 'pending',
    state: 'pending',
    record_cid: null,
    ...overrides,
  })
}
const setRecord = (rkey, value, cid = RECORD_CID) => {
  records.set(`${AUTHOR}|${COLLECTION}|${rkey}`, {
    uri: recUri(rkey),
    cid,
    value,
  })
}
const comicValue = (linkId, rkey, overrides = {}) => ({
  $type: COLLECTION,
  subject: { uri: postUri(rkey), cid: SUBJECT_CID },
  url: viewer(linkId),
  createdAt: '2026-08-01T00:00:00.000Z',
  ...overrides,
})
const feedPost = (rkey, text, opts = {}) => ({
  post: {
    uri: postUri(rkey, opts.did ?? AUTHOR),
    cid: SUBJECT_CID,
    author: { did: opts.did ?? AUTHOR },
    record: {
      text,
      createdAt: opts.createdAt ?? '2026-08-01T00:00:00.000Z',
      ...(opts.reply ? { reply: {} } : {}),
    },
    embed: opts.noImage
      ? undefined
      : {
          $type: 'app.bsky.embed.images#view',
          images: [{ fullsize: 'https://cdn.example.com/feed.jpg' }],
        },
  },
  ...(opts.reason ? { reason: { $type: 'app.bsky.feed.defs#reasonRepost' } } : {}),
})
const isoAt = (epochSec) => new Date(epochSec * 1000).toISOString()

const setThreadPost = (rkey, overrides = {}) => {
  threads.set(postUri(rkey), {
    uri: postUri(rkey),
    cid: SUBJECT_CID,
    author: { did: AUTHOR },
    record: { createdAt: '2026-08-01T00:00:00.000Z', text: '' },
    replyCount: 0,
    ...overrides,
  })
}

let pass = 0
let fail = 0
const ok = (name, cond, detail = '') => {
  if (cond) {
    pass += 1
    console.log(`ok   ${name}`)
  } else {
    fail += 1
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}
// Match the expected error so unrelated failures cannot pass rejection tests.
const expectResponse = async (name, res, status, fragment) => {
  const body = await res.json().catch(() => ({}))
  const message = typeof body.error === 'string' ? body.error : ''
  ok(
    name,
    res.status === status && (!fragment || message.includes(fragment)),
    `status=${res.status} body=${JSON.stringify(body)}`,
  )
  return body
}

console.log('--- resolvePdsEndpoint: SSRF guards (no network call may escape) ---')
const ssrfDids = [
  'did:web:localhost%3A8080',
  'did:web:127.0.0.1',
  'did:web:169.254.169.254',
  'did:web:example.com%2Fpath',
  'did:web:user%40evil.example.com',
  'did:web:foo.internal',
  'did:web:foo.local',
  'did:web:Example.COM',
  'did:evil:whatever',
  'did:plc:tooshort',
]
for (const bad of ssrfDids) {
  const before = fetchLog.length
  let rejected = false
  try {
    await resolvePdsEndpoint(bad)
  } catch {
    rejected = true
  }
  ok(
    `resolve ${bad.slice(0, 48)} rejected without network`,
    rejected && fetchLog.length === before,
    rejected ? `fetched: ${fetchLog[fetchLog.length - 1]}` : 'resolved',
  )
}

console.log('--- resolvePdsEndpoint: document handling ---')
{
  const did = plcDid('pdshappyaaaa')
  didDocs.set(did, { ...didDocs.get(AUTHOR), id: did })
  const endpoint = await resolvePdsEndpoint(did)
  ok('valid DID resolves to PDS origin', endpoint === PDS, endpoint)
  ok(
    'DID doc fetched with redirect:manual',
    lastDidFetchInit?.redirect === 'manual',
    JSON.stringify(lastDidFetchInit),
  )
  const before = fetchLog.length
  await resolvePdsEndpoint(did)
  ok('repeat resolve served from cache (no refetch)', fetchLog.length === before)
}
{
  const did = plcDid('pdsredirect2')
  fetchOverride = () =>
    new Response(null, {
      status: 301,
      headers: { Location: 'http://169.254.169.254/latest/meta-data' },
    })
  let rejected = false
  try {
    await resolvePdsEndpoint(did)
  } catch {
    rejected = true
  }
  fetchOverride = null
  const followed = fetchLog.some((u) => u.includes('169.254.169.254'))
  ok('redirect response rejected, target never fetched', rejected && !followed)
}
{
  const did = plcDid('pdsbigdoc222')
  fetchOverride = () =>
    new Response(new ReadableStream({ pull() {} }), {
      status: 200,
      headers: { 'content-length': String(70 * 1024) },
    })
  let message = ''
  try {
    await resolvePdsEndpoint(did)
  } catch (err) {
    message = err instanceof Error ? err.message : String(err)
  }
  fetchOverride = null
  ok('oversized DID doc rejected', /大きすぎ/.test(message), message)
}
{
  const did = plcDid('pdswrongid22')
  didDocs.set(did, { id: plcDid('someoneelse2'), service: didDocs.get(AUTHOR).service })
  let rejected = false
  try {
    await resolvePdsEndpoint(did)
  } catch {
    rejected = true
  }
  ok('DID doc id mismatch rejected', rejected)
}
const badEndpoints = [
  ['httpendpoint', 'http://pds.example.com'],
  ['pathendpoint', 'https://pds.example.com/base'],
  ['userendpoint', 'https://user@pds.example.com'],
  ['numendpoint2', 42],
  ['metaendpoint', 'https://169.254.169.254'],
  ['loopendpoint', 'https://127.0.0.1'],
  ['lhostendpoin', 'https://localhost'],
  ['rfcendpointa', 'https://10.0.0.5'],
  ['vsixendpoint', 'https://[::1]'],
  ['tldendpointa', 'https://internal-pds.internal'],
]
for (const [name, endpoint] of badEndpoints) {
  const did = plcDid(name)
  didDocs.set(did, {
    id: did,
    service: [
      { id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: endpoint },
    ],
  })
  let rejected = false
  try {
    await resolvePdsEndpoint(did)
  } catch {
    rejected = true
  }
  ok(`invalid PDS endpoint ${JSON.stringify(endpoint)} rejected`, rejected)
}
{
  // PDS service endpoints may include an explicit port.
  const did = plcDid('portendpoint')
  didDocs.set(did, {
    id: did,
    service: [
      {
        id: '#atproto_pds',
        type: 'AtprotoPersonalDataServer',
        serviceEndpoint: 'https://pds.example.com:8443',
      },
    ],
  })
  const endpoint = await resolvePdsEndpoint(did)
  ok(
    'custom-port PDS endpoint accepted',
    endpoint === 'https://pds.example.com:8443',
    endpoint,
  )
}
{
  const did = 'did:web:pds-host.example.org'
  didDocs.set(did, {
    id: did,
    service: [
      { id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: PDS },
    ],
  })
  const endpoint = await resolvePdsEndpoint(did)
  ok('valid did:web resolves to its PDS', endpoint === PDS, endpoint)
}

console.log('--- PDS record fetch: response handling ---')
{
  let redirectInit = null
  fetchOverride = (url, init) => {
    if (url.pathname === '/xrpc/com.atproto.repo.getRecord') {
      redirectInit = init
      return new Response(null, {
        status: 302,
        headers: { Location: 'https://internal-target.example.org/steal' },
      })
    }
    return null
  }
  let rejected = false
  try {
    await fetchRepoRecord(PDS, AUTHOR, COLLECTION, 'rkredirbody')
  } catch {
    rejected = true
  }
  fetchOverride = null
  ok(
    'redirecting PDS response rejected with redirect:manual',
    rejected && redirectInit?.redirect === 'manual',
    JSON.stringify(redirectInit),
  )
  ok(
    'PDS redirect target never fetched',
    !fetchLog.some((u) => u.includes('internal-target.example.org')),
  )
}
{
  let served = 0
  fetchOverride = (url) => {
    if (url.pathname === '/xrpc/com.atproto.repo.getRecord') {
      const stream = new ReadableStream({
        pull(controller) {
          served += 65536
          controller.enqueue(new Uint8Array(65536))
        },
      })
      return new Response(stream, { status: 200 })
    }
    return null
  }
  let message = ''
  try {
    await fetchRepoRecord(PDS, AUTHOR, COLLECTION, 'rkbigbody')
  } catch (err) {
    message = err instanceof Error ? err.message : String(err)
  }
  fetchOverride = null
  ok('oversized record body rejected', /大きすぎ/.test(message), message)
  ok(
    'body read stopped near the 5MB cap',
    served <= 5 * 1024 * 1024 + 2 * 65536,
    `${served} bytes served`,
  )
}
{
  const started = Date.now()
  fetchOverride = (url, init) => {
    if (url.pathname === '/xrpc/com.atproto.repo.getRecord') {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{'))
          // Keep the stream open until the fetch timeout aborts it.
          init?.signal?.addEventListener('abort', () => {
            try {
              controller.error(new Error('aborted'))
            } catch {}
          })
        },
      })
      return new Response(stream, { status: 200 })
    }
    return null
  }
  let rejected = false
  try {
    await fetchRepoRecord(PDS, AUTHOR, COLLECTION, 'rkslowbody')
  } catch {
    rejected = true
  }
  fetchOverride = null
  const elapsed = Date.now() - started
  ok(
    'slow record body aborted by timeout (~10s)',
    rejected && elapsed >= 9000 && elapsed < 20000,
    `${elapsed}ms`,
  )
}

console.log('--- /api/manga/complete (record mode) ---')
{
  const id = 'lnkhappy01'
  const rkey = 'rkhappy'
  addRow(id)
  setRecord(
    rkey,
    comicValue(id, rkey, {
      title: 'テスト漫画',
      startSide: 'left',
      posts: [{ uri: postUri(rkey), cid: SUBJECT_CID }],
    }),
  )
  setThreadPost(rkey)
  const res = await post('/api/manga/complete', {
    id,
    recordUri: recUri(rkey),
    recordCid: RECORD_CID,
  })
  const body = await expectResponse('pending link completed by record', res, 200)
  ok('response carries recordCid + pending', body.recordCid === RECORD_CID && body.pending === true)
  const row = db.rows.get(id)
  ok(
    'row activated with record metadata',
    row.state === 'active' &&
      row.original_post_uri === postUri(rkey) &&
      row.record_cid === RECORD_CID &&
      row.title === 'テスト漫画' &&
      row.start_side === 'left',
    JSON.stringify(row),
  )
}
{
  const res = await post('/api/manga/complete', {
    id: 'lnkmissing',
    recordUri: recUri('rkmissing'),
    recordCid: RECORD_CID,
  })
  await expectResponse('unknown link id -> 404', res, 404)
}
{
  const id = 'lnkbaduri1'
  addRow(id)
  const res = await post('/api/manga/complete', {
    id,
    recordUri: `at://${AUTHOR}/wrong.collection/rk`,
    recordCid: RECORD_CID,
  })
  await expectResponse('malformed recordUri -> 400', res, 400, 'recordUri')
}
{
  const id = 'lnkforeign'
  addRow(id)
  const res = await post('/api/manga/complete', {
    id,
    recordUri: recUri('rkforeign', OTHER),
    recordCid: RECORD_CID,
  })
  await expectResponse(
    "record in someone else's repo -> 403",
    res,
    403,
    '作者本人のレコード',
  )
}
{
  const id = 'lnknorec01'
  const rkey = 'rknorec'
  addRow(id)
  const res = await post('/api/manga/complete', {
    id,
    recordUri: recUri(rkey),
    recordCid: RECORD_CID,
  })
  await expectResponse('record not found on PDS -> 502', res, 502)
}
{
  const id = 'lnkcid0001'
  const rkey = 'rkcid'
  addRow(id)
  setRecord(rkey, comicValue(id, rkey))
  const res = await post('/api/manga/complete', {
    id,
    recordUri: recUri(rkey),
    recordCid: WRONG_CID,
  })
  await expectResponse('recordCid mismatch (TOCTOU) -> 409', res, 409, '変更され')
}
{
  const id = 'lnktype001'
  const rkey = 'rktype'
  addRow(id)
  setRecord(rkey, { ...comicValue(id, rkey), $type: 'app.bsky.feed.post' })
  const res = await post('/api/manga/complete', {
    id,
    recordUri: recUri(rkey),
    recordCid: RECORD_CID,
  })
  await expectResponse('wrong $type -> 400', res, 400, '$type')
}
{
  const id = 'lnkurl0001'
  const rkey = 'rkurl'
  addRow(id)
  setRecord(rkey, comicValue('someOtherLink', rkey))
  const res = await post('/api/manga/complete', {
    id,
    recordUri: recUri(rkey),
    recordCid: RECORD_CID,
  })
  await expectResponse('record bound to another link -> 400', res, 400, 'url')
}
{
  const id = 'lnkrkey001'
  const rkey = 'rkmis'
  addRow(id)
  setRecord(rkey, comicValue(id, 'rkdifferent'))
  const res = await post('/api/manga/complete', {
    id,
    recordUri: recUri(rkey),
    recordCid: RECORD_CID,
  })
  await expectResponse('record rkey != subject rkey -> 400', res, 400, 'rkey')
}
{
  const id = 'lnkdup0001'
  const rkey = 'rkdup'
  addRow(id)
  setRecord(
    rkey,
    comicValue(id, rkey, {
      posts: [
        { uri: postUri(rkey), cid: SUBJECT_CID },
        { uri: postUri(rkey), cid: SUBJECT_CID },
      ],
    }),
  )
  const res = await post('/api/manga/complete', {
    id,
    recordUri: recUri(rkey),
    recordCid: RECORD_CID,
  })
  await expectResponse('duplicate posts entries -> 400', res, 400, 'posts')
}
{
  const id = 'lnkmix0001'
  const rkey = 'rkmix'
  addRow(id)
  setRecord(
    rkey,
    comicValue(id, rkey, {
      posts: [
        { uri: postUri(rkey), cid: SUBJECT_CID },
        { uri: postUri('rkmix2', OTHER), cid: SUBJECT_CID },
      ],
    }),
  )
  const res = await post('/api/manga/complete', {
    id,
    recordUri: recUri(rkey),
    recordCid: RECORD_CID,
  })
  await expectResponse("foreign author's post in posts -> 400", res, 400, 'posts')
}
{
  const id = 'lnkfirst01'
  const rkey = 'rkfirst'
  addRow(id)
  setRecord(
    rkey,
    comicValue(id, rkey, {
      posts: [{ uri: postUri('rkfirstother'), cid: SUBJECT_CID }],
    }),
  )
  const res = await post('/api/manga/complete', {
    id,
    recordUri: recUri(rkey),
    recordCid: RECORD_CID,
  })
  await expectResponse('posts[0] != subject -> 400', res, 400, 'subject')
}
{
  const id = 'lnklive001'
  const rkey = 'rklive'
  addRow(id)
  setRecord(rkey, comicValue(id, rkey))
  setThreadPost(rkey, { cid: WRONG_CID })
  const res = await post('/api/manga/complete', {
    id,
    recordUri: recUri(rkey),
    recordCid: RECORD_CID,
  })
  await expectResponse('subject CID != live post CID -> 400', res, 400, 'CID')
}
{
  const id = 'lnkimp0001'
  const rkey = 'rkimp'
  addRow(id)
  setRecord(rkey, comicValue(id, rkey))
  setThreadPost(rkey, { author: { did: OTHER } })
  const res = await post('/api/manga/complete', {
    id,
    recordUri: recUri(rkey),
    recordCid: RECORD_CID,
  })
  await expectResponse('live post author mismatch -> 400', res, 400, 'ポスト作者')
}
{
  const id = 'lnkgone001'
  const rkey = 'rkgone'
  addRow(id)
  setRecord(rkey, comicValue(id, rkey))
  // No thread entry: the subject post does not exist.
  const res = await post('/api/manga/complete', {
    id,
    recordUri: recUri(rkey),
    recordCid: RECORD_CID,
  })
  await expectResponse('subject post unavailable -> 502', res, 502)
}
{
  const id = 'lnkswap001'
  const rkey = 'rkswap'
  addRow(id, { original_post_uri: postUri('rkoriginal'), state: 'active' })
  setRecord(rkey, comicValue(id, rkey))
  setThreadPost(rkey)
  const res = await post('/api/manga/complete', {
    id,
    recordUri: recUri(rkey),
    recordCid: RECORD_CID,
  })
  await expectResponse(
    'active link cannot be re-pointed at another thread -> 409',
    res,
    409,
    '異なるスレッド',
  )
}

console.log('--- request body / id limits (memory-DoS guards) ---')
{
  const res = await post('/api/manga/complete', {
    id: 'lnkbig0001',
    recordUri: 'x'.repeat(20 * 1024),
    recordCid: RECORD_CID,
  })
  await expectResponse('oversized JSON body -> 413', res, 413)
}
{
  const res = await post('/api/manga/complete', null, {
    rawBody: `{"id":"a","filler":"${'x'.repeat(20 * 1024)}`,
  })
  await expectResponse('oversized truncated raw body -> 413', res, 413)
}
{
  const res = await post('/api/manga/complete', {
    id: 'x'.repeat(100),
    recordUri: recUri('rkhugeid'),
    recordCid: RECORD_CID,
  })
  await expectResponse('over-long id -> 400', res, 400, 'id')
}
{
  const res = await post('/api/manga/complete', {
    id: 'abc/../def',
    recordUri: recUri('rkbadid'),
    recordCid: RECORD_CID,
  })
  await expectResponse('id with invalid characters -> 400', res, 400, 'id')
}
{
  // Malformed requests must consume the IP rate limit before body parsing.
  const ip = '198.51.100.88'
  const statuses = []
  for (let i = 0; i < 35; i += 1) {
    const res = await post('/api/manga/complete', null, { ip, rawBody: '{invalid' })
    statuses.push(res.status)
    await res.body?.cancel?.()
  }
  ok(
    'malformed bodies within the window -> 400',
    statuses.slice(0, 30).every((s) => s === 400),
    statuses.slice(0, 30).join(','),
  )
  ok(
    'malformed bodies beyond the window -> 429 (pre-parse IP limit)',
    statuses.slice(30).every((s) => s === 429),
    statuses.slice(30).join(','),
  )
}

console.log('--- /api/manga/complete concurrency (CAS) ---')
{
  // Hold both record fetches until both requests read the pending row.
  // This forces the compare-and-swap updates to compete for the same version.
  const id = 'lnkrace001'
  const rkA = 'rkracea'
  const rkB = 'rkraceb'
  addRow(id)
  setRecord(rkA, comicValue(id, rkA))
  setRecord(rkB, comicValue(id, rkB))
  setThreadPost(rkA)
  setThreadPost(rkB)
  const release = []
  fetchOverride = (url) => {
    if (url.pathname === '/xrpc/com.atproto.repo.getRecord') {
      const key = `${url.searchParams.get('repo')}|${url.searchParams.get('collection')}|${url.searchParams.get('rkey')}`
      return new Promise((resolve) => {
        release.push(() => resolve(Response.json(records.get(key))))
        if (release.length === 2) {
          for (const fn of release) {
            fn()
          }
        }
      })
    }
    return null
  }
  const [resA, resB] = await Promise.all([
    post('/api/manga/complete', { id, recordUri: recUri(rkA), recordCid: RECORD_CID }),
    post('/api/manga/complete', { id, recordUri: recUri(rkB), recordCid: RECORD_CID }),
  ])
  fetchOverride = null
  const statuses = [resA.status, resB.status].sort()
  ok(
    'concurrent completes: exactly one wins, one conflicts',
    statuses[0] === 200 && statuses[1] === 409,
    `${resA.status},${resB.status}`,
  )
  const loser = resA.status === 409 ? resA : resB
  const loserBody = await loser.json().catch(() => ({}))
  ok(
    'loser reports a conflict, not silent success',
    typeof loserBody.error === 'string' && loserBody.error.includes('競合'),
    JSON.stringify(loserBody),
  )
  const winnerRkey = resA.status === 200 ? rkA : rkB
  const row = db.rows.get(id)
  ok(
    'row bound to the winning subject only',
    row.state === 'active' && row.original_post_uri === postUri(winnerRkey),
    JSON.stringify(row),
  )
}

console.log('--- /api/manga/complete (legacy fallback) ---')
{
  const id = 'lnkleg0001'
  addRow(id)
  const res = await post('/api/manga/complete', { id, postUrl: postUri('rkleg1') })
  await expectResponse('legacy without service auth -> 401', res, 401)
}
{
  const id = 'lnkleg0002'
  addRow(id, { author_did: OTHER })
  const res = await post(
    '/api/manga/complete',
    { id, postUrl: postUri('rkleg2') },
    { auth: makeJwt() },
  )
  await expectResponse('legacy JWT for another author -> 403', res, 403, '作者本人')
}
{
  const id = 'lnkleg0003'
  const rkey = 'rkleg3'
  addRow(id)
  setThreadPost(rkey, { record: { text: '本文にリンクなし' } })
  const res = await post(
    '/api/manga/complete',
    { id, postUrl: postUri(rkey) },
    { auth: makeJwt() },
  )
  await expectResponse('pending + post text lacks viewer URL -> 403', res, 403, 'ポスト本文')
}
{
  const id = 'lnkleg0004'
  const rkey = 'rkleg4'
  addRow(id)
  setThreadPost(rkey, { record: { text: `読む: ${viewer(id)}` } })
  const res = await post(
    '/api/manga/complete',
    { id, postUrl: postUri(rkey) },
    { auth: makeJwt() },
  )
  const body = await expectResponse('legacy pending completion succeeds', res, 200)
  const row = db.rows.get(id)
  ok(
    'legacy row activated without record_cid',
    body.pending === true &&
      row.state === 'active' &&
      row.original_post_uri === postUri(rkey) &&
      row.record_cid === null,
    JSON.stringify(row),
  )
}

console.log('--- /api/manga/generate (existing-link reuse) ---')
{
  const rkey = 'rkgen1'
  setThreadPost(rkey, {
    embed: {
      $type: 'app.bsky.embed.images#view',
      images: [{ fullsize: 'https://cdn.example.com/img1.jpg' }],
    },
  })
  const first = await post(
    '/api/manga/generate',
    { postUrl: postUri(rkey), startSide: 'right' },
    { auth: makeJwt() },
  )
  const firstBody = await expectResponse('generate creates a link', first, 200)
  ok(
    'generate returns record facts',
    typeof firstBody.id === 'string' &&
      firstBody.rootUri === postUri(rkey) &&
      Array.isArray(firstBody.posts) &&
      firstBody.posts.length === 1 &&
      !firstBody.reused,
    JSON.stringify(firstBody),
  )
  const second = await post(
    '/api/manga/generate',
    { postUrl: postUri(rkey), startSide: 'right' },
    { auth: makeJwt() },
  )
  const secondBody = await expectResponse('regenerate reuses the row', second, 200)
  ok(
    'same id returned with reused flag',
    secondBody.id === firstBody.id && secondBody.reused === true,
    JSON.stringify(secondBody),
  )
}
{
  const rkey = 'rkgen2'
  setThreadPost(rkey, {
    embed: {
      $type: 'app.bsky.embed.images#view',
      images: [{ fullsize: 'https://cdn.example.com/img2.jpg' }],
    },
  })
  const res = await post(
    '/api/manga/generate',
    { postUrl: postUri(rkey), startSide: 'right' },
    { auth: makeJwt(OTHER, privOther) },
  )
  await expectResponse("generate for someone else's thread -> 403", res, 403, '作者本人')
}
{
  // No thread entry simulates a deleted or private root post.
  const res = await post(
    '/api/manga/generate',
    { postUrl: postUri('rkgengone'), startSide: 'right' },
    { auth: makeJwt() },
  )
  await expectResponse(
    'generate for deleted/private post -> 404',
    res,
    404,
    '削除されたか非公開',
  )
}

console.log('--- /api/manga/generate (canonical post URI) ---')
{
  // The AppView resolves handle-form at:// URIs; only its DID-form URI may be stored.
  const rkey = 'rkgenh1'
  const handleUri = `at://alice.example.com/app.bsky.feed.post/${rkey}`
  setThreadPost(rkey, {
    embed: {
      $type: 'app.bsky.embed.images#view',
      images: [{ fullsize: 'https://cdn.example.com/imgh1.jpg' }],
    },
  })
  threads.set(handleUri, threads.get(postUri(rkey)))
  const first = await post(
    '/api/manga/generate',
    { postUrl: handleUri, startSide: 'right' },
    { auth: makeJwt() },
  )
  const firstBody = await expectResponse(
    'generate accepts a handle-form at:// URI',
    first,
    200,
  )
  const row = db.rows.get(firstBody.id)
  ok(
    'DID-form URI stored and returned for a handle-form input',
    row?.original_post_uri === postUri(rkey) &&
      firstBody.rootUri === postUri(rkey) &&
      firstBody.rootCid === SUBJECT_CID,
    JSON.stringify({ body: firstBody, row }),
  )
  const second = await post(
    '/api/manga/generate',
    { postUrl: postUri(rkey), startSide: 'right' },
    { auth: makeJwt() },
  )
  const secondBody = await expectResponse(
    'DID-form request for the same post',
    second,
    200,
  )
  ok(
    'URI spellings share one link',
    secondBody.id === firstBody.id && secondBody.reused === true,
    JSON.stringify(secondBody),
  )
}
{
  // A canonical URI outside the caller's repo must never be stored.
  const rkey = 'rkgenh2'
  const handleUri = `at://alice.example.com/app.bsky.feed.post/${rkey}`
  threads.set(handleUri, {
    uri: postUri(rkey, OTHER),
    cid: SUBJECT_CID,
    author: { did: AUTHOR },
    record: { createdAt: '2026-08-01T00:00:00.000Z', text: '' },
    replyCount: 0,
    embed: {
      $type: 'app.bsky.embed.images#view',
      images: [{ fullsize: 'https://cdn.example.com/imgh2.jpg' }],
    },
  })
  const before = db.rows.size
  const res = await post(
    '/api/manga/generate',
    { postUrl: handleUri, startSide: 'right' },
    { auth: makeJwt() },
  )
  await expectResponse('canonical URI in another repo -> 403', res, 403, '作者本人')
  ok('no row stored for a foreign canonical URI', db.rows.size === before)
}

console.log('--- /api/manga/complete rate limiting ---')
{
  const ip = '198.51.100.77'
  const statuses = []
  for (let i = 0; i < 35; i += 1) {
    const res = await post(
      '/api/manga/complete',
      { id: 'lnkratelim', recordUri: recUri('rkratelim'), recordCid: RECORD_CID },
      { ip },
    )
    statuses.push(res.status)
    await res.body?.cancel?.()
  }
  const first30 = statuses.slice(0, 30)
  const rest = statuses.slice(30)
  ok(
    'first 30 attempts not rate limited',
    first30.every((s) => s !== 429),
    first30.join(','),
  )
  ok(
    'attempts beyond the window limit -> 429',
    rest.every((s) => s === 429),
    rest.join(','),
  )
  // IP and link limits must apply independently.
  const freshIpSameLink = await post('/api/manga/complete', {
    id: 'lnkratelim',
    recordUri: recUri('rkratelim'),
    recordCid: RECORD_CID,
  })
  ok('exhausted link id limited even from a fresh IP', freshIpSameLink.status === 429)
  const sameIpFreshLink = await post(
    '/api/manga/complete',
    { id: 'lnkratelimb', recordUri: recUri('rkratelim'), recordCid: RECORD_CID },
    { ip },
  )
  ok('exhausted IP limited even for a fresh link id', sameIpFreshLink.status === 429)
  const unrelated = await post('/api/manga/complete', {
    id: 'lnkratelimc',
    recordUri: recUri('rkratelim'),
    recordCid: RECORD_CID,
  })
  ok('fresh IP + fresh link id not limited', unrelated.status !== 429, String(unrelated.status))
}

console.log('--- /api/manage/links (list) ---')
{
  const res = await send('/api/manage/links', 'GET')
  await expectResponse('list without service auth -> 401', res, 401)
}
{
  addRow('lnkmg00001', {
    state: 'active',
    original_post_uri: postUri('rkmg1'),
    created_at: 100,
    title: '一冊目',
  })
  addRow('lnkmg00002', {
    state: 'active',
    original_post_uri: postUri('rkmg2'),
    created_at: 200,
    record_cid: RECORD_CID,
    start_side: 'left',
  })
  addRow('lnkmgother', {
    author_did: OTHER,
    state: 'active',
    original_post_uri: postUri('rkmgo', OTHER),
    created_at: 300,
  })
  // Quota expiry after 24 hours must not shorten the 180-day repair window.
  addRow('lnkmgpendf', { created_at: now() })
  addRow('lnkmgpendx', { created_at: 100 })
  addRow('lnkmgpendm', { created_at: now() - 2 * 24 * 60 * 60 })
  const res = await send('/api/manage/links', 'GET', { auth: makeJwt() })
  const body = await expectResponse('list returns own links', res, 200)
  const ids = (body.links ?? []).map((l) => l.id)
  ok("another author's rows excluded", !ids.includes('lnkmgother'), ids.join(','))
  ok(
    'own rows listed newest first',
    ids.includes('lnkmg00001') &&
      ids.includes('lnkmg00002') &&
      ids.indexOf('lnkmg00002') < ids.indexOf('lnkmg00001'),
    ids.join(','),
  )
  const item = (body.links ?? []).find((l) => l.id === 'lnkmg00002')
  ok(
    'list item carries metadata + viewerUrl',
    item &&
      item.recordCid === RECORD_CID &&
      item.startSide === 'left' &&
      item.state === 'active' &&
      item.createdAt === 200 &&
      item.viewerUrl === viewer('lnkmg00002'),
    JSON.stringify(item),
  )
  const pendingItem = (body.links ?? []).find((l) => l.id === 'lnkmgpendf')
  ok(
    'fresh pending rows are listed (cleanup targets)',
    pendingItem?.state === 'pending',
    ids.join(','),
  )
  ok(
    'expired pending rows are purged by the list request',
    !ids.includes('lnkmgpendx') && !db.rows.has('lnkmgpendx'),
    ids.join(','),
  )
  ok(
    'mid-age pending survives the purge (repair window)',
    ids.includes('lnkmgpendm') && db.rows.has('lnkmgpendm'),
    ids.join(','),
  )
}

console.log('--- /api/manage/links/:id (delete) ---')
{
  const res = await send('/api/manage/links/lnkmg00001', 'DELETE')
  await expectResponse('delete without service auth -> 401', res, 401)
  ok('row untouched without auth', db.rows.has('lnkmg00001'))
}
{
  const res = await send('/api/manage/links/lnkmgother', 'DELETE', {
    auth: makeJwt(),
  })
  await expectResponse("delete another author's link -> 404", res, 404)
  ok("another author's row not deleted", db.rows.has('lnkmgother'))
}
{
  const res = await send(
    `/api/manage/links/${encodeURIComponent('bad id!')}`,
    'DELETE',
    { auth: makeJwt() },
  )
  await expectResponse('malformed id -> 400', res, 400, 'id')
}
{
  const res = await send('/api/manage/links/lnkmg00001', 'DELETE', {
    auth: makeJwt(),
  })
  const body = await expectResponse('delete own link succeeds', res, 200)
  ok('row removed', body.ok === true && !db.rows.has('lnkmg00001'))
  const again = await send('/api/manage/links/lnkmg00001', 'DELETE', {
    auth: makeJwt(),
  })
  await expectResponse('deleting the same link again -> 404', again, 404)
}

console.log('--- /api/manage/links/:id/record (record-only detach) ---')
{
  const res = await send(
    `/api/manage/links/lnkmg00002/record?expectedCid=${RECORD_CID}`,
    'DELETE',
  )
  await expectResponse('record detach without service auth -> 401', res, 401)
  ok(
    'record_cid untouched without auth',
    db.rows.get('lnkmg00002').record_cid === RECORD_CID,
  )
}
{
  const res = await send('/api/manage/links/lnkmg00002/record', 'DELETE', {
    auth: makeJwt(),
  })
  await expectResponse('detach without expectedCid -> 400', res, 400, 'expectedCid')
}
{
  addRow('lnkdetach1', {
    author_did: OTHER,
    state: 'active',
    original_post_uri: postUri('rkdet1', OTHER),
    record_cid: RECORD_CID,
  })
  const res = await send(
    `/api/manage/links/lnkdetach1/record?expectedCid=${RECORD_CID}`,
    'DELETE',
    { auth: makeJwt() },
  )
  await expectResponse("detach another author's record -> 404", res, 404)
  ok(
    "another author's record_cid untouched",
    db.rows.get('lnkdetach1').record_cid === RECORD_CID,
  )
}
{
  const res = await send(
    `/api/manage/links/lnkmg00002/record?expectedCid=${WRONG_CID}`,
    'DELETE',
    { auth: makeJwt() },
  )
  await expectResponse('detach with stale expectedCid -> 409', res, 409, '競合')
  ok(
    'record_cid survives a stale detach',
    db.rows.get('lnkmg00002').record_cid === RECORD_CID,
  )
}
{
  const res = await send(
    `/api/manage/links/lnkmg00002/record?expectedCid=${RECORD_CID}`,
    'DELETE',
    { auth: makeJwt() },
  )
  const body = await expectResponse('own record detached', res, 200)
  const row = db.rows.get('lnkmg00002')
  ok(
    'record_cid cleared, link row kept',
    body.ok === true && row && row.record_cid === null && row.state === 'active',
    JSON.stringify(row),
  )
}

console.log('--- record edit sync (manager save via record-mode /complete) ---')
{
  const NEW_CID = 'bafyreieditedaaaaaaaaaaaa'
  const id = 'lnkedit001'
  const rkey = 'rkedit'
  addRow(id, {
    state: 'active',
    original_post_uri: postUri(rkey),
    record_cid: RECORD_CID,
    title: '旧タイトル',
    start_side: 'right',
  })
  setRecord(
    rkey,
    comicValue(id, rkey, { title: '新タイトル', startSide: 'left' }),
    NEW_CID,
  )
  setThreadPost(rkey)
  const res = await post('/api/manga/complete', {
    id,
    recordUri: recUri(rkey),
    recordCid: NEW_CID,
  })
  const body = await expectResponse('edited record accepted', res, 200)
  const row = db.rows.get(id)
  ok(
    'D1 synced to the new record version',
    body.recordCid === NEW_CID &&
      row.record_cid === NEW_CID &&
      row.title === '新タイトル' &&
      row.start_side === 'left',
    JSON.stringify(row),
  )
}
{
  const id = 'lnkattach1'
  const rkey = 'rkattach'
  addRow(id, {
    state: 'active',
    original_post_uri: postUri(rkey),
    record_cid: null,
  })
  setRecord(rkey, comicValue(id, rkey, { title: '後付けタイトル' }))
  setThreadPost(rkey)
  const res = await post('/api/manga/complete', {
    id,
    recordUri: recUri(rkey),
    recordCid: RECORD_CID,
  })
  await expectResponse('record attached to legacy link', res, 200)
  const row = db.rows.get(id)
  ok(
    'legacy row gains record metadata',
    row.record_cid === RECORD_CID &&
      row.title === '後付けタイトル' &&
      row.original_post_uri === postUri(rkey),
    JSON.stringify(row),
  )
}
{
  const id = 'lnkrebind1'
  const rkeyOld = 'rkrebold'
  const rkeyNew = 'rkrebnew'
  addRow(id, {
    state: 'active',
    original_post_uri: postUri(rkeyOld),
    record_cid: null,
  })
  setRecord(rkeyNew, comicValue(id, rkeyNew))
  setThreadPost(rkeyNew)
  const res = await post('/api/manga/complete', {
    id,
    recordUri: recUri(rkeyNew),
    recordCid: RECORD_CID,
  })
  await expectResponse('record for another thread -> 409', res, 409, '異なるスレッド')
}

console.log('--- pending lazy self-repair (viewer GET) ---')
{
  const id = 'lnkrepair1'
  const rkey = 'rkrepair1'
  addRow(id, { created_at: now() - 600 })
  feeds.set(AUTHOR, [
    feedPost('rkrepairx', '関係ないポスト'),
    feedPost(rkey, `新作です ${viewer(id)} (1/3)`, { createdAt: isoAt(now() - 300) }),
  ])
  setThreadPost(rkey, {
    embed: {
      $type: 'app.bsky.embed.images#view',
      images: [{ fullsize: 'https://cdn.example.com/page1.jpg' }],
    },
  })
  const res = await send(`/api/manga/${id}`, 'GET')
  const body = await expectResponse('published pending link self-repairs on view', res, 200)
  const row = db.rows.get(id)
  ok(
    'row activated and bound to the root post',
    row.state === 'active' &&
      row.original_post_uri === postUri(rkey) &&
      body.originalPostUri === postUri(rkey),
    JSON.stringify(row),
  )
  const feedCalls = () => fetchLog.filter((u) => u.includes('getAuthorFeed')).length
  const afterRepair = feedCalls()
  const res2 = await send(`/api/manga/${id}`, 'GET')
  await expectResponse('repaired link serves normally afterwards', res2, 200)
  ok('no further feed scans once active', feedCalls() === afterRepair)
}
{
  // Only an original root post with images proves ownership of the pending link.
  const id = 'lnkrepair2'
  addRow(id, { created_at: now() - 600 })
  feeds.set(AUTHOR, [
    feedPost('rkrepReply', `読んでね ${viewer(id)}`, {
      reply: true,
      createdAt: isoAt(now() - 300),
    }),
    feedPost('rkrepText', `読んでね ${viewer(id)}`, {
      noImage: true,
      createdAt: isoAt(now() - 300),
    }),
    feedPost('rkrepBoost', `拡散 ${viewer(id)}`, {
      reason: true,
      createdAt: isoAt(now() - 300),
    }),
  ])
  const res = await send(`/api/manga/${id}`, 'GET')
  await expectResponse('decoy posts never bind', res, 404, '完了していません')
  ok('row still pending after decoys', db.rows.get(id).state === 'pending')
}
{
  // A later share can also contain images and the viewer URL.
  const id = 'lnkrepair3'
  const rkeyRoot = 'rkrep3root'
  addRow(id, { created_at: now() - 7200 })
  feeds.set(AUTHOR, [
    feedPost('rkrep3share', `もう読みましたか ${viewer(id)}`, {
      createdAt: isoAt(now() - 100),
    }),
    feedPost(rkeyRoot, `本編 ${viewer(id)} (1/5)`, {
      createdAt: isoAt(now() - 7000),
    }),
  ])
  setThreadPost(rkeyRoot, {
    embed: {
      $type: 'app.bsky.embed.images#view',
      images: [{ fullsize: 'https://cdn.example.com/root.jpg' }],
    },
  })
  const res = await send(`/api/manga/${id}`, 'GET')
  await expectResponse('oldest qualifying post wins', res, 200)
  ok(
    'bound to the original root, not the later share',
    db.rows.get(id).original_post_uri === postUri(rkeyRoot),
  )
}
{
  const id = 'lnkrepair4'
  addRow(id, { created_at: now() - 600 })
  feeds.set(AUTHOR, [])
  const feedCalls = () => fetchLog.filter((u) => u.includes('getAuthorFeed')).length
  const before = feedCalls()
  for (let i = 0; i < 5; i += 1) {
    const res = await send(`/api/manga/${id}`, 'GET')
    await res.body?.cancel?.()
  }
  ok('repair scans rate limited per link (3/window)', feedCalls() - before === 3, String(feedCalls() - before))
}

console.log('--- viewer GET (cache key / id validation) ---')
{
  const id = 'lnkcache01'
  const rkey = 'rkcache1'
  addRow(id, { state: 'active', original_post_uri: postUri(rkey) })
  setThreadPost(rkey, {
    embed: {
      $type: 'app.bsky.embed.images#view',
      images: [{ fullsize: 'https://cdn.example.com/cache1.jpg' }],
    },
  })
  // Replace the always-miss cache with a real store for this block.
  const noCache = globalThis.caches
  const stored = new Map()
  globalThis.caches = {
    default: {
      async match(request) {
        return stored.get(request.url)?.clone()
      },
      async put(request, response) {
        stored.set(request.url, response)
      },
    },
  }
  try {
    const threadCalls = () =>
      fetchLog.filter((u) => u.includes('getPostThread')).length
    const res1 = await send(`/api/manga/${id}?x=1`, 'GET')
    await expectResponse('viewer GET with a query string', res1, 200)
    const afterFirst = threadCalls()
    const res2 = await send(`/api/manga/${id}?x=2`, 'GET')
    const body2 = await expectResponse('different query string still served', res2, 200)
    ok(
      'query string cannot bypass the viewer cache',
      threadCalls() === afterFirst && body2.id === id,
      String(threadCalls() - afterFirst),
    )
    ok(
      'cache keyed on the bare path',
      stored.size === 1 && [...stored.keys()][0].endsWith(`/api/manga/${id}`),
      JSON.stringify([...stored.keys()]),
    )
  } finally {
    globalThis.caches = noCache
  }
}
{
  // IDs outside the link ID alphabet cannot exist; answer without a DB lookup.
  const originalPrepare = db.prepare
  let prepared = 0
  db.prepare = (sql) => {
    prepared += 1
    return originalPrepare.call(db, sql)
  }
  try {
    const tooLong = await send(`/api/manga/${'a'.repeat(33)}`, 'GET')
    await expectResponse('over-long link id -> 404', tooLong, 404, '見つかりません')
    const badChars = await send('/api/manga/bad.id', 'GET')
    await expectResponse('link id with invalid characters -> 404', badChars, 404, '見つかりません')
    ok('malformed ids never reach the DB', prepared === 0, String(prepared))
  } finally {
    db.prepare = originalPrepare
  }
}

console.log('--- quota (creation-path purge + atomic guard) ---')
{
  // Purging must also work for authors who never open /manage.
  addRow('lnkqexp001', { created_at: 100 })
  const res = await post(
    '/api/manga/reserve',
    { startSide: 'right' },
    { auth: makeJwt() },
  )
  const body = await expectResponse('reserve succeeds below quota', res, 200)
  ok('expired pending purged by reserve', !db.rows.has('lnkqexp001'))
  db.rows.delete(body.id)
}
{
  const cutoff = now() - 24 * 60 * 60
  const freshRows = () =>
    [...db.rows.values()].filter(
      (row) =>
        row.author_did === AUTHOR &&
        !(row.state === 'pending' && (row.created_at ?? 0) < cutoff),
    ).length
  let filler = 0
  while (freshRows() < 100) {
    filler += 1
    addRow(`lnkqf${String(filler).padStart(5, '0')}`, {
      state: 'active',
      original_post_uri: postUri(`rkqf${filler}`),
      created_at: now(),
    })
  }

  const res = await post(
    '/api/manga/reserve',
    { startSide: 'right' },
    { auth: makeJwt() },
  )
  await expectResponse('reserve at quota -> 429', res, 429, '100件')

  setThreadPost('rkqnew1', {
    embed: {
      $type: 'app.bsky.embed.images#view',
      images: [{ fullsize: 'https://cdn.example.com/imgq.jpg' }],
    },
  })
  const resNew = await post(
    '/api/manga/generate',
    { postUrl: postUri('rkqnew1'), startSide: 'right' },
    { auth: makeJwt() },
  )
  await expectResponse('generate (new thread) at quota -> 429', resNew, 429, '100件')

  const resReuse = await post(
    '/api/manga/generate',
    { postUrl: postUri('rkgen1'), startSide: 'right' },
    { auth: makeJwt() },
  )
  const reuseBody = await expectResponse(
    'generate reuse still works at quota',
    resReuse,
    200,
  )
  ok('reuse flag set at quota', reuseBody.reused === true, JSON.stringify(reuseBody))
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
