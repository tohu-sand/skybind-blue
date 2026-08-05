import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { HTTPException } from 'hono/http-exception'
import {
  COMIC_COLLECTION,
  SERVICE_AUTH_LXM,
  parseComicRecordUri,
  parsePostUri,
} from '../shared/comicRecord'
import { readCompletePayload, readGeneratePayload, readReservePayload } from './auth'
import { purgeExpiredJti, requireServiceAuth } from './serviceAuth'
import {
  createAgent,
  fetchMangaThread,
  fetchPostSummary,
  fetchRepoRecord,
  generateShortId,
  resolvePdsEndpoint,
  resolvePostUri,
  type FetchedRecord,
} from './manga'

type Bindings = {
  DB: D1Database
  APP_URL: string
  BSKY_PUBLIC_API: string
}

type MangaRow = {
  id: string
  author_did: string
  title: string | null
  start_side: string | null
  original_post_uri: string
  record_cid: string | null
}

type InsertLinkInput = {
  id?: string
  authorDid: string
  title?: string | null
  pagesJson: string
  startSide: 'right' | 'left'
  originalPostUri: string
  state: 'pending' | 'active'
}

const MAX_LINKS_PER_AUTHOR = 100
// Edge-cache TTL for viewer responses. One viewer request fans out into up to
// ~17 sequential getPostThread calls upstream, so even a short TTL matters.
const VIEWER_CACHE_SECONDS = 60
// Reserved-but-never-completed rows stop counting against the per-author
// quota after this long, so abandoned uploads can't exhaust the limit forever.
const PENDING_TTL_SECONDS = 24 * 60 * 60
const COUNT_LINKS_SQL = `SELECT COUNT(1) as count FROM manga_links WHERE author_did = ? AND NOT (state = 'pending' AND created_at < (CAST(strftime('%s','now') AS INTEGER) - ${PENDING_TTL_SECONDS}))`

const toErrorMessage = (err: unknown, fallback: string) =>
  err instanceof Error && err.message ? err.message : fallback

const isNotFoundError = (err: unknown) => {
  if (!err || typeof err !== 'object') {
    return false
  }
  const maybe = err as { error?: string; status?: number }
  // com.atproto.repo.getRecord reports a missing record as HTTP 400 with
  // error name "RecordNotFound" (not 404/"NotFound").
  if (maybe.error === 'NotFound' || maybe.error === 'RecordNotFound') {
    return true
  }
  if (typeof maybe.status === 'number' && maybe.status === 404) {
    return true
  }
  return (
    err instanceof Error &&
    (/not found/i.test(err.message) || /could not locate record/i.test(err.message))
  )
}

const getPostAuthorDid = (uri: string) => {
  const match = /^at:\/\/(did:[^/]+)\/app\.bsky\.feed\.post\/[^/?#]+$/.exec(uri)
  return match?.[1] ?? null
}

export const app = new Hono<{ Bindings: Bindings }>()

app.use(
  '*',
  cors({
    origin: (origin, c) => {
      const allowed = (c.env as Bindings | undefined)?.APP_URL ?? 'https://skybind.blue'
      return origin === allowed ? origin : null
    },
  }),
)

app.get('/api/health', (c) => c.json({ ok: true }))

const insertMangaLink = async (db: D1Database, input: InsertLinkInput) => {
  let insertedId = ''
  const tries = input.id ? 1 : 5

  for (let attempt = 0; attempt < tries; attempt += 1) {
    const candidate = input.id ?? generateShortId()
    try {
      await db
        .prepare(
          'INSERT INTO manga_links (id, author_did, title, pages_json, start_side, original_post_uri, state) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .bind(
          candidate,
          input.authorDid,
          input.title ?? null,
          input.pagesJson,
          input.startSide,
          input.originalPostUri,
          input.state,
        )
        .run()
      insertedId = candidate
      break
    } catch (err) {
      if (attempt === tries - 1) {
        throw err
      }
    }
  }

  if (!insertedId) {
    throw new HTTPException(500, { message: 'ID生成に失敗しました。' })
  }

  return insertedId
}

app.post('/api/manga/reserve', async (c) => {
  if (!c.env.DB) {
    return c.json({ error: 'DBバインドが未設定です。' }, 500)
  }
  const authorDid = await requireServiceAuth(
    c.req.header('Authorization'),
    SERVICE_AUTH_LXM,
    c.env.DB,
  )
  // Purge is registered BEFORE body parsing: a consumed jti must always be
  // matched by a cleanup pass, even when the payload turns out to be invalid.
  c.executionCtx.waitUntil(
    purgeExpiredJti(c.env.DB).catch((err) => console.error(err)),
  )
  const payload = await readReservePayload(c)

  try {
    const row = (await c.env.DB.prepare(COUNT_LINKS_SQL)
      .bind(authorDid)
      .first()) as { count?: number | string } | null
    const count = Number(row?.count ?? 0)
    if (count >= MAX_LINKS_PER_AUTHOR) {
      return c.json(
        { error: `リンク生成は1アカウントあたり${MAX_LINKS_PER_AUTHOR}件までです。` },
        429,
      )
    }
  } catch (err) {
    console.error(err)
    return c.json({ error: '件数確認に失敗しました。' }, 500)
  }

  let insertedId = ''
  try {
    insertedId = await insertMangaLink(c.env.DB, {
      authorDid,
      title: payload.title ?? null,
      pagesJson: JSON.stringify([]),
      startSide: payload.startSide,
      originalPostUri: 'pending',
      state: 'pending',
    })
  } catch (err) {
    console.error(err)
    return c.json({ error: 'DBへの書き込みに失敗しました。' }, 500)
  }

  const baseUrl = c.env.APP_URL || 'https://skybind.blue'
  const viewerUrl = new URL(`/v/${insertedId}`, baseUrl).toString()

  return c.json({ id: insertedId, viewerUrl })
})

app.post('/api/manga/generate', async (c) => {
  if (!c.env.DB) {
    return c.json({ error: 'DBバインドが未設定です。' }, 500)
  }
  const authorDid = await requireServiceAuth(
    c.req.header('Authorization'),
    SERVICE_AUTH_LXM,
    c.env.DB,
  )
  c.executionCtx.waitUntil(
    purgeExpiredJti(c.env.DB).catch((err) => console.error(err)),
  )
  const payload = await readGeneratePayload(c)
  const agent = createAgent(c.env.BSKY_PUBLIC_API || 'https://public.api.bsky.app')
  let postUri = ''
  try {
    postUri = await resolvePostUri(agent, payload.postUrl)
  } catch (err) {
    return c.json(
      { error: toErrorMessage(err, 'ポストURLの解決に失敗しました。') },
      400,
    )
  }

  let thread: Awaited<ReturnType<typeof fetchMangaThread>>
  try {
    thread = await fetchMangaThread(agent, postUri)
  } catch (err) {
    console.error(err)
    return c.json({ error: 'スレッド取得に失敗しました。' }, 502)
  }
  if (thread.authorDid !== authorDid) {
    return c.json({ error: '作者本人のみURLを生成できます。' }, 403)
  }

  if (!thread.pages.length) {
    return c.json({ error: '画像付きのポストが見つかりませんでした。' }, 400)
  }

  if (!c.env.DB) {
    return c.json({ error: 'DBバインドが未設定です。' }, 500)
  }

  const baseUrlForGenerate = c.env.APP_URL || 'https://skybind.blue'

  // Existing-row reuse, before the quota check so an at-limit author can
  // still re-fetch their link. The caller's DID is verified, so returning
  // their own (possibly unlisted) id is safe.
  try {
    const existing = (await c.env.DB.prepare(
      "SELECT id FROM manga_links WHERE author_did = ? AND original_post_uri = ? AND state = 'active' ORDER BY created_at DESC LIMIT 1",
    )
      .bind(authorDid, thread.originalPostUri)
      .first()) as { id?: string } | null
    if (existing?.id) {
      return c.json({
        id: existing.id,
        viewerUrl: new URL(`/v/${existing.id}`, baseUrlForGenerate).toString(),
        rootUri: thread.originalPostUri,
        rootCid: thread.rootCid,
        posts: thread.posts,
        pageCount: thread.pages.length,
        sensitiveSelfLabels: thread.sensitiveSelfLabels,
        reused: true,
      })
    }
  } catch (err) {
    console.error(err)
    return c.json({ error: '既存リンクの確認に失敗しました。' }, 500)
  }

  try {
    const row = (await c.env.DB.prepare(COUNT_LINKS_SQL)
      .bind(authorDid)
      .first()) as { count?: number | string } | null
    const count = Number(row?.count ?? 0)
    if (count >= MAX_LINKS_PER_AUTHOR) {
      return c.json(
        { error: `リンク生成は1アカウントあたり${MAX_LINKS_PER_AUTHOR}件までです。` },
        429,
      )
    }
  } catch (err) {
    console.error(err)
    return c.json({ error: '件数確認に失敗しました。' }, 500)
  }

  // One row per (author, thread): the sidecar record can only point at one
  // viewer URL. The conditional INSERT is a single statement, so concurrent
  // requests cannot both insert; the loser re-reads the winner's id.
  let insertedId = ''
  let reused = false
  try {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const candidate = generateShortId()
      const result = await c.env.DB.prepare(
        `INSERT INTO manga_links (id, author_did, title, pages_json, start_side, original_post_uri, state)
         SELECT ?, ?, ?, ?, ?, ?, 'active'
         WHERE NOT EXISTS (SELECT 1 FROM manga_links WHERE author_did = ? AND original_post_uri = ? AND state = 'active')`,
      )
        .bind(
          candidate,
          authorDid,
          payload.title ?? null,
          JSON.stringify([]),
          payload.startSide,
          thread.originalPostUri,
          authorDid,
          thread.originalPostUri,
        )
        .run()
      if (result.meta.changes && result.meta.changes > 0) {
        insertedId = candidate
        break
      }
      // changes === 0: a row appeared concurrently; return its id.
      const existing = (await c.env.DB.prepare(
        "SELECT id FROM manga_links WHERE author_did = ? AND original_post_uri = ? AND state = 'active' ORDER BY created_at DESC LIMIT 1",
      )
        .bind(authorDid, thread.originalPostUri)
        .first()) as { id?: string } | null
      if (existing?.id) {
        insertedId = existing.id
        reused = true
        break
      }
    }
  } catch (err) {
    console.error(err)
    return c.json({ error: 'DBへの書き込みに失敗しました。' }, 500)
  }
  if (!insertedId) {
    return c.json({ error: 'ID生成に失敗しました。' }, 500)
  }

  const viewerUrl = new URL(`/v/${insertedId}`, baseUrlForGenerate).toString()

  // Extra thread facts so the client can write the blue.skybind.comic record
  // (subject strongRef, explicit page order, mirrored self labels).
  return c.json({
    id: insertedId,
    viewerUrl,
    rootUri: thread.originalPostUri,
    rootCid: thread.rootCid,
    posts: thread.posts,
    pageCount: thread.pages.length,
    sensitiveSelfLabels: thread.sensitiveSelfLabels,
    reused: reused || undefined,
  })
})

// atproto uses CIDv1 in lowercase base32 ("b..." multibase prefix).
const isLikelyCid = (value: unknown): value is string =>
  typeof value === 'string' && /^b[a-z2-7]{10,}$/.test(value)

// Structural validation of a fetched blue.skybind.comic record against this
// link. The PDS may store unknown-lexicon records unvalidated
// (validationStatus: unknown), so the server re-checks everything it relies on.
const validateComicRecord = (
  record: FetchedRecord,
  expected: {
    recordUri: string
    recordCid?: string
    did: string
    rkey: string
    viewerUrl: string
  },
): { error: string; status: 400 | 409 } | { subjectUri: string; subjectCid: string } => {
  if (record.uri !== expected.recordUri) {
    return { error: '取得したレコードのURIが一致しません。', status: 400 }
  }
  if (expected.recordCid && expected.recordCid !== record.cid) {
    return { error: 'レコードが書き込み後に変更されています。', status: 409 }
  }
  const value = record.value
  if (value.$type !== COMIC_COLLECTION) {
    return { error: 'レコードの$typeが不正です。', status: 400 }
  }
  const subject = value.subject as { uri?: unknown; cid?: unknown } | undefined
  const subjectUri = typeof subject?.uri === 'string' ? subject.uri : ''
  const subjectPost = parsePostUri(subjectUri)
  if (!subjectPost || !isLikelyCid(subject?.cid)) {
    return { error: 'レコードのsubjectが不正です。', status: 400 }
  }
  const subjectCid = subject.cid as string
  if (subjectPost.did !== expected.did) {
    return { error: 'subjectの作者がレコード所有者と一致しません。', status: 400 }
  }
  if (subjectPost.rkey !== expected.rkey) {
    return { error: 'レコードキーがsubjectのrkeyと一致しません。', status: 400 }
  }
  if (value.url !== expected.viewerUrl) {
    return { error: 'レコードのurlがこのリンクと一致しません。', status: 400 }
  }
  if (value.posts !== undefined) {
    const posts = value.posts
    if (!Array.isArray(posts) || posts.length === 0 || posts.length > 1000) {
      return { error: 'レコードのpostsが不正です。', status: 400 }
    }
    const seen = new Set<string>()
    for (const item of posts) {
      const uri = (item as { uri?: unknown } | null)?.uri
      const cid = (item as { cid?: unknown } | null)?.cid
      if (typeof uri !== 'string' || !isLikelyCid(cid)) {
        return { error: 'レコードのpostsが不正です。', status: 400 }
      }
      const parsedPost = parsePostUri(uri)
      if (!parsedPost || parsedPost.did !== expected.did || seen.has(uri)) {
        return { error: 'レコードのpostsが不正です。', status: 400 }
      }
      seen.add(uri)
    }
    const first = posts[0] as { uri: string; cid: string }
    if (first.uri !== subjectUri || first.cid !== subjectCid) {
      return { error: 'レコードのpostsがsubjectと一致しません。', status: 400 }
    }
  }
  if (
    (value.title !== undefined &&
      (typeof value.title !== 'string' || value.title.length > 1000)) ||
    (value.startSide !== undefined &&
      (typeof value.startSide !== 'string' || value.startSide.length > 32)) ||
    (value.language !== undefined &&
      (typeof value.language !== 'string' || value.language.length > 48)) ||
    (value.pageCount !== undefined &&
      (!Number.isInteger(value.pageCount) || (value.pageCount as number) < 1)) ||
    typeof value.createdAt !== 'string' ||
    Number.isNaN(Date.parse(value.createdAt))
  ) {
    return { error: 'レコードのフィールドが不正です。', status: 400 }
  }
  if (value.labels !== undefined) {
    const labels = value.labels as
      | { $type?: unknown; values?: unknown }
      | null
    const values = Array.isArray(labels?.values) ? labels.values : null
    if (
      !labels ||
      labels.$type !== 'com.atproto.label.defs#selfLabels' ||
      !values ||
      values.length > 10 ||
      values.some((entry) => {
        const val = (entry as { val?: unknown } | null)?.val
        return typeof val !== 'string' || !val || val.length > 128
      })
    ) {
      return { error: 'レコードのlabelsが不正です。', status: 400 }
    }
  }
  return { subjectUri, subjectCid }
}

app.post('/api/manga/complete', async (c) => {
  const payload = await readCompletePayload(c)

  if (!c.env.DB) {
    return c.json({ error: 'DBバインドが未設定です。' }, 500)
  }

  const row = (await c.env.DB.prepare(
    'SELECT id, author_did, title, start_side, original_post_uri, record_cid FROM manga_links WHERE id = ?',
  )
    .bind(payload.id)
    .first()) as MangaRow | null

  if (!row) {
    return c.json({ error: 'リンクが見つかりませんでした。' }, 404)
  }

  const baseUrl = c.env.APP_URL || 'https://skybind.blue'
  const viewerUrl = new URL(`/v/${payload.id}`, baseUrl).toString()
  const wasPending = row.original_post_uri === 'pending'

  if (payload.kind === 'record') {
    // Ownership proof: the comic record must exist in the reserving author's
    // own repo and be bound to this exact link via its `url` field.
    const parsed = parseComicRecordUri(payload.recordUri)
    if (!parsed) {
      return c.json({ error: 'recordUriの形式が正しくありません。' }, 400)
    }
    if (parsed.did !== row.author_did) {
      return c.json({ error: '予約した作者本人のレコードのみ紐づけできます。' }, 403)
    }

    let record: FetchedRecord
    try {
      const pds = await resolvePdsEndpoint(parsed.did)
      record = await fetchRepoRecord(pds, parsed.did, COMIC_COLLECTION, parsed.rkey)
    } catch (err) {
      console.error(err)
      return c.json(
        { error: toErrorMessage(err, 'レコードの取得に失敗しました。') },
        502,
      )
    }

    const verdict = validateComicRecord(record, {
      recordUri: payload.recordUri,
      recordCid: payload.recordCid,
      did: parsed.did,
      rkey: parsed.rkey,
      viewerUrl,
    })
    if ('error' in verdict) {
      return c.json({ error: verdict.error }, verdict.status)
    }
    const subjectUri = verdict.subjectUri
    if (!wasPending && row.original_post_uri !== subjectUri) {
      return c.json({ error: '既存リンクと異なるスレッドは紐づけできません。' }, 409)
    }

    // The subject strongRef must match the live post (existence + CID + author).
    const agent = createAgent(c.env.BSKY_PUBLIC_API || 'https://public.api.bsky.app')
    try {
      const subjectPost = await fetchPostSummary(agent, subjectUri)
      if (subjectPost.authorDid !== parsed.did) {
        return c.json({ error: 'subjectのポスト作者が一致しません。' }, 400)
      }
      // Fail closed: without a CID the claim cannot be verified.
      if (!subjectPost.cid) {
        return c.json({ error: '検証に必要なポスト情報が取得できませんでした。' }, 502)
      }
      if (subjectPost.cid !== verdict.subjectCid) {
        return c.json({ error: 'subjectのCIDが実際のポストと一致しません。' }, 400)
      }
    } catch (err) {
      console.error(err)
      return c.json({ error: 'subjectのポストが取得できませんでした。' }, 502)
    }

    // The record is the author-verified source of truth for link metadata.
    const recordTitle =
      typeof record.value.title === 'string'
        ? record.value.title.slice(0, 100)
        : null
    const recordStartSide = record.value.startSide === 'left' ? 'left' : 'right'

    try {
      await c.env.DB.prepare(
        "UPDATE manga_links SET original_post_uri = ?, record_cid = ?, state = 'active', title = ?, start_side = ? WHERE id = ?",
      )
        .bind(subjectUri, record.cid, recordTitle, recordStartSide, payload.id)
        .run()
    } catch (updateErr) {
      console.error(updateErr)
      return c.json({ error: 'DBの更新に失敗しました。' }, 500)
    }

    return c.json({
      id: payload.id,
      viewerUrl,
      pending: wasPending || undefined,
      recordCid: record.cid,
    })
  }

  // Legacy fallback (record write failed): the caller proves account control
  // via service auth instead of a record.
  const authorDid = await requireServiceAuth(
    c.req.header('Authorization'),
    SERVICE_AUTH_LXM,
    c.env.DB,
  )
  c.executionCtx.waitUntil(
    purgeExpiredJti(c.env.DB).catch((err) => console.error(err)),
  )
  if (row.author_did !== authorDid) {
    return c.json({ error: '作者本人のみURLを更新できます。' }, 403)
  }

  const agent = createAgent(c.env.BSKY_PUBLIC_API || 'https://public.api.bsky.app')
  let postUri = ''
  try {
    postUri = await resolvePostUri(agent, payload.postUrl)
  } catch (err) {
    return c.json(
      { error: toErrorMessage(err, 'ポストURLの解決に失敗しました。') },
      400,
    )
  }

  const postAuthorDid = getPostAuthorDid(postUri)
  if (!postAuthorDid) {
    return c.json({ error: 'BlueskyのポストURLを入力してください。' }, 400)
  }
  if (postAuthorDid !== row.author_did) {
    return c.json({ error: '予約した作者本人のポストのみ紐づけできます。' }, 403)
  }

  if (wasPending) {
    // The claimed post must actually carry this link's viewer URL in its text
    // (the uploader always writes it into post 1), so a forged DID + someone
    // else's post URL cannot activate a reservation.
    let postText = ''
    try {
      postText = (await fetchPostSummary(agent, postUri)).text
    } catch (err) {
      console.error(err)
      return c.json({ error: 'ポストの取得に失敗しました。' }, 502)
    }
    if (!postText.includes(`/v/${payload.id}`)) {
      return c.json(
        { error: 'ポスト本文にこのリンクのURLが含まれていないため、紐づけできません。' },
        403,
      )
    }

    try {
      await c.env.DB.prepare(
        "UPDATE manga_links SET original_post_uri = ?, state = 'active' WHERE id = ?",
      )
        .bind(postUri, payload.id)
        .run()
    } catch (updateErr) {
      console.error(updateErr)
      return c.json({ error: 'DBの更新に失敗しました。' }, 500)
    }

    return c.json({ id: payload.id, viewerUrl, pending: true })
  }

  return c.json({ id: payload.id, viewerUrl })
})

app.get('/api/manga/:id', async (c) => {
  const id = c.req.param('id')

  // The Workers runtime exposes caches.default, but the shared tsconfig pulls
  // in DOM's CacheStorage type which lacks it.
  const cache = (caches as unknown as { default: Cache }).default
  const cacheKey = new Request(new URL(c.req.url).toString(), { method: 'GET' })
  const cached = await cache.match(cacheKey)
  if (cached) {
    return cached
  }

  const row = (await c.env.DB.prepare(
    'SELECT id, author_did, title, start_side, original_post_uri, record_cid FROM manga_links WHERE id = ?',
  )
    .bind(id)
    .first()) as MangaRow | null

  if (!row) {
    return c.json({ error: 'リンクが見つかりませんでした。' }, 404)
  }

  if (row.original_post_uri === 'pending') {
    return c.json({ error: 'このリンクはまだ作成が完了していません。' }, 404)
  }

  const agent = createAgent(c.env.BSKY_PUBLIC_API || 'https://public.api.bsky.app')
  let thread: Awaited<ReturnType<typeof fetchMangaThread>>
  try {
    thread = await fetchMangaThread(agent, row.original_post_uri)
  } catch (err) {
    console.error(err)
    if (isNotFoundError(err)) {
      return c.json({ error: '元の投稿が削除されたか非公開です。' }, 404)
    }
    return c.json({ error: 'スレッド取得に失敗しました。' }, 502)
  }

  const pages = thread.pages
  const author =
    thread.author && thread.author.did
      ? thread.author
      : { did: thread.authorDid || row.author_did }

  const response = c.json({
    id: row.id,
    title: row.title ?? undefined,
    pages,
    startSide: row.start_side === 'left' ? 'left' : 'right',
    originalPostUri: row.original_post_uri,
    hasSensitive: thread.hasSensitive,
    author,
    // Set only when SkyBind verified a blue.skybind.comic record for this
    // link; absent for legacy links and unverified records.
    recordCid: row.record_cid ?? undefined,
  })
  response.headers.set(
    'Cache-Control',
    `public, max-age=30, s-maxage=${VIEWER_CACHE_SECONDS}`,
  )
  c.executionCtx.waitUntil(cache.put(cacheKey, response.clone()))
  return response
})

app.onError((err, c) => {
  // Always answer JSON: the client parses every API response as JSON, so a
  // text/plain HTTPException body would surface as a parse error instead of
  // the actual message.
  if (err instanceof HTTPException) {
    return c.json({ error: err.message }, err.status)
  }
  console.error(err)
  return c.json({ error: 'サーバーエラーが発生しました。' }, 500)
})
