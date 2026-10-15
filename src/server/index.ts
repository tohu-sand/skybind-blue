import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { HTTPException } from 'hono/http-exception'
import {
  COMIC_COLLECTION,
  SERVICE_AUTH_LXM,
  parseComicRecordUri,
  parsePostUri,
} from '../shared/comicRecord'
import {
  LINK_ID_PATTERN,
  readCompletePayload,
  readGeneratePayload,
  readReservePayload,
} from './auth'
import { purgeExpiredJti, requireServiceAuth } from './serviceAuth'
import {
  createAgent,
  fetchMangaThread,
  fetchPostSummary,
  fetchRepoRecord,
  findPublishedLinkPost,
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
  // Selected for pending-link recovery.
  created_at?: number | null
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
// Cache viewer responses to reduce sequential upstream thread requests.
const VIEWER_CACHE_SECONDS = 60
// Abandoned reservations stop counting toward the author's quota after this period.
const PENDING_TTL_SECONDS = 24 * 60 * 60
const COUNT_LINKS_SQL = `SELECT COUNT(1) as count FROM manga_links WHERE author_did = ? AND NOT (state = 'pending' AND created_at < (CAST(strftime('%s','now') AS INTEGER) - ${PENDING_TTL_SECONDS}))`
// Enforce the quota within INSERT to prevent races after the initial count.
const QUOTA_GUARD_SQL = `(SELECT COUNT(1) FROM manga_links WHERE author_did = ? AND NOT (state = 'pending' AND created_at < (CAST(strftime('%s','now') AS INTEGER) - ${PENDING_TTL_SECONDS}))) < ${MAX_LINKS_PER_AUTHOR}`
const QUOTA_ERROR_MESSAGE = `リンク生成は1アカウントあたり${MAX_LINKS_PER_AUTHOR}件までです。`
// Retain pending rows beyond quota expiry so already-published URLs remain repairable.
const PENDING_PURGE_TTL_SECONDS = 180 * 24 * 60 * 60
const purgeExpiredPending = (db: D1Database, authorDid: string) =>
  db
    .prepare(
      `DELETE FROM manga_links WHERE author_did = ? AND state = 'pending' AND created_at < (CAST(strftime('%s','now') AS INTEGER) - ${PENDING_PURGE_TTL_SECONDS})`,
    )
    .bind(authorDid)
    .run()

const toErrorMessage = (err: unknown, fallback: string) =>
  err instanceof Error && err.message ? err.message : fallback

const isNotFoundError = (err: unknown) => {
  if (!err || typeof err !== 'object') {
    return false
  }
  const maybe = err as { error?: string; status?: number }
  // getRecord may report missing records as HTTP 400 with RecordNotFound.
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
      const result = await db
        .prepare(
          `INSERT INTO manga_links (id, author_did, title, pages_json, start_side, original_post_uri, state)
           SELECT ?, ?, ?, ?, ?, ?, ?
           WHERE ${QUOTA_GUARD_SQL}`,
        )
        .bind(
          candidate,
          input.authorDid,
          input.title ?? null,
          input.pagesJson,
          input.startSide,
          input.originalPostUri,
          input.state,
          input.authorDid,
        )
        .run()
      // ID collisions throw; zero changes means the quota guard rejected the insert.
      if (!result.meta.changes) {
        throw new HTTPException(429, { message: QUOTA_ERROR_MESSAGE })
      }
      insertedId = candidate
      break
    } catch (err) {
      if (err instanceof HTTPException) {
        throw err
      }
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
  // Schedule nonce cleanup even if payload parsing fails after authentication.
  c.executionCtx.waitUntil(
    purgeExpiredJti(c.env.DB).catch((err) => console.error(err)),
  )
  const payload = await readReservePayload(c)

  try {
    await purgeExpiredPending(c.env.DB, authorDid)
    const row = (await c.env.DB.prepare(COUNT_LINKS_SQL)
      .bind(authorDid)
      .first()) as { count?: number | string } | null
    const count = Number(row?.count ?? 0)
    if (count >= MAX_LINKS_PER_AUTHOR) {
      return c.json({ error: QUOTA_ERROR_MESSAGE }, 429)
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
    if (err instanceof HTTPException) {
      throw err
    }
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
    if (isNotFoundError(err)) {
      return c.json(
        { error: '投稿が削除されたか非公開のため、レコードを作成できません。' },
        404,
      )
    }
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

  // Reuse existing links before checking the quota so authors at the limit can retrieve them.
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
    await purgeExpiredPending(c.env.DB, authorDid)
    const row = (await c.env.DB.prepare(COUNT_LINKS_SQL)
      .bind(authorDid)
      .first()) as { count?: number | string } | null
    const count = Number(row?.count ?? 0)
    if (count >= MAX_LINKS_PER_AUTHOR) {
      return c.json({ error: QUOTA_ERROR_MESSAGE }, 429)
    }
  } catch (err) {
    console.error(err)
    return c.json({ error: '件数確認に失敗しました。' }, 500)
  }

  // A comic record points to one viewer URL. Check duplicates and quota atomically;
  // a concurrent request that loses the insert reuses the existing link.
  let insertedId = ''
  let reused = false
  try {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const candidate = generateShortId()
      const result = await c.env.DB.prepare(
        `INSERT INTO manga_links (id, author_did, title, pages_json, start_side, original_post_uri, state)
         SELECT ?, ?, ?, ?, ?, ?, 'active'
         WHERE NOT EXISTS (SELECT 1 FROM manga_links WHERE author_did = ? AND original_post_uri = ? AND state = 'active')
           AND ${QUOTA_GUARD_SQL}`,
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
          authorDid,
        )
        .run()
      if (result.meta.changes && result.meta.changes > 0) {
        insertedId = candidate
        break
      }
      // Check whether another request inserted the link.
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
      // No concurrent link exists, so the quota guard rejected the insert.
      return c.json({ error: QUOTA_ERROR_MESSAGE }, 429)
    }
  } catch (err) {
    console.error(err)
    return c.json({ error: 'DBへの書き込みに失敗しました。' }, 500)
  }
  if (!insertedId) {
    return c.json({ error: 'ID生成に失敗しました。' }, 500)
  }

  const viewerUrl = new URL(`/v/${insertedId}`, baseUrlForGenerate).toString()

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

// Record completion needs no service auth, so bound its upstream fetches.
// These limits apply per isolate; global limits require platform WAF rules.
const RATE_WINDOW_MS = 60 * 1000
const RATE_MAX_ATTEMPTS = 30
const RATE_BUCKET_MAX = 10_000
const rateBuckets = new Map<string, { count: number; resetAt: number }>()

const isRateLimited = (key: string, maxAttempts = RATE_MAX_ATTEMPTS): boolean => {
  const now = Date.now()
  const bucket = rateBuckets.get(key)
  if (bucket && bucket.resetAt > now) {
    bucket.count += 1
    return bucket.count > maxAttempts
  }
  if (rateBuckets.size >= RATE_BUCKET_MAX) {
    for (const [k, v] of rateBuckets) {
      if (v.resetAt <= now) {
        rateBuckets.delete(k)
      }
    }
    if (rateBuckets.size >= RATE_BUCKET_MAX) {
      const oldest = rateBuckets.keys().next().value
      if (oldest) {
        rateBuckets.delete(oldest)
      }
    }
  }
  rateBuckets.set(key, { count: 1, resetAt: now + RATE_WINDOW_MS })
  return false
}

// atproto uses CIDv1 in lowercase base32 ("b..." multibase prefix).
const isLikelyCid = (value: unknown): value is string =>
  typeof value === 'string' && /^b[a-z2-7]{10,}$/.test(value)

// PDSes may store unknown-lexicon records without validation; check all fields used here.
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
  // Count malformed and oversized bodies toward the IP limit before parsing.
  const clientIp = c.req.header('CF-Connecting-IP') ?? 'unknown'
  if (isRateLimited(`ip:${clientIp}`)) {
    return c.json(
      { error: '試行回数が多すぎます。しばらく待ってから再試行してください。' },
      429,
    )
  }

  const payload = await readCompletePayload(c)

  if (isRateLimited(`link:${payload.id}`)) {
    return c.json(
      { error: '試行回数が多すぎます。しばらく待ってから再試行してください。' },
      429,
    )
  }

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
    // The author's PDS record proves ownership and binds this link through its url.
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

    // Verify the subject against the live post, including its CID and author.
    const agent = createAgent(c.env.BSKY_PUBLIC_API || 'https://public.api.bsky.app')
    try {
      const subjectPost = await fetchPostSummary(agent, subjectUri)
      if (subjectPost.authorDid !== parsed.did) {
        return c.json({ error: 'subjectのポスト作者が一致しません。' }, 400)
      }
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

    const recordTitle =
      typeof record.value.title === 'string'
        ? record.value.title.slice(0, 100)
        : null
    const recordStartSide = record.value.startSide === 'left' ? 'left' : 'right'

    // Match the previously read URI and CID to prevent concurrent rebinds or stale
    // metadata writes. IS handles a nullable record_cid.
    try {
      const updated = await c.env.DB.prepare(
        "UPDATE manga_links SET original_post_uri = ?, record_cid = ?, state = 'active', title = ?, start_side = ? WHERE id = ? AND original_post_uri = ? AND record_cid IS ?",
      )
        .bind(
          subjectUri,
          record.cid,
          recordTitle,
          recordStartSide,
          payload.id,
          row.original_post_uri,
          row.record_cid,
        )
        .run()
      if (!updated.meta.changes) {
        return c.json(
          { error: '別の更新と競合しました。もう一度お試しください。' },
          409,
        )
      }
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

  // Failed record writes fall back to service auth.
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
    // The root post must contain this viewer URL to bind it to the reservation.
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

    // A concurrent completion must not rebind an already-active link.
    try {
      const updated = await c.env.DB.prepare(
        "UPDATE manga_links SET original_post_uri = ?, state = 'active' WHERE id = ? AND original_post_uri = 'pending'",
      )
        .bind(postUri, payload.id)
        .run()
      if (!updated.meta.changes) {
        return c.json(
          { error: '別の更新と競合しました。もう一度お試しください。' },
          409,
        )
      }
    } catch (updateErr) {
      console.error(updateErr)
      return c.json({ error: 'DBの更新に失敗しました。' }, 500)
    }

    return c.json({ id: payload.id, viewerUrl, pending: true })
  }

  return c.json({ id: payload.id, viewerUrl })
})

// Uploads publish the viewer URL before completion. Recover pending links from
// the author's root post, with per-link and per-IP limits on unauthenticated scans.
const REPAIR_MAX_ATTEMPTS = 3

const tryRepairPendingLink = async (
  c: { env: Bindings; req: { header: (name: string) => string | undefined } },
  row: MangaRow,
): Promise<string | null> => {
  const clientIp = c.req.header('CF-Connecting-IP') ?? 'unknown'
  if (
    isRateLimited(`repair:${row.id}`, REPAIR_MAX_ATTEMPTS) ||
    isRateLimited(`repairip:${clientIp}`, REPAIR_MAX_ATTEMPTS)
  ) {
    return null
  }

  const agent = createAgent(c.env.BSKY_PUBLIC_API || 'https://public.api.bsky.app')
  let foundUri: string | null = null
  try {
    foundUri = await findPublishedLinkPost(
      agent,
      row.author_did,
      row.id,
      typeof row.created_at === 'number' ? row.created_at : null,
    )
  } catch (err) {
    console.error('pending repair scan failed', err)
    return null
  }
  if (!foundUri || getPostAuthorDid(foundUri) !== row.author_did) {
    return null
  }

  try {
    // A concurrent completion must not rebind an already-active link.
    const updated = await c.env.DB.prepare(
      "UPDATE manga_links SET original_post_uri = ?, state = 'active' WHERE id = ? AND original_post_uri = 'pending'",
    )
      .bind(foundUri, row.id)
      .run()
    if (!updated.meta.changes) {
      return null
    }
  } catch (err) {
    console.error('pending repair update failed', err)
    return null
  }
  return foundUri
}

app.get('/api/manga/:id', async (c) => {
  const id = c.req.param('id')

  // The shared DOM types omit Workers' caches.default.
  const cache = (caches as unknown as { default: Cache }).default
  const cacheKey = new Request(new URL(c.req.url).toString(), { method: 'GET' })
  const cached = await cache.match(cacheKey)
  if (cached) {
    return cached
  }

  const row = (await c.env.DB.prepare(
    'SELECT id, author_did, title, start_side, original_post_uri, record_cid, created_at FROM manga_links WHERE id = ?',
  )
    .bind(id)
    .first()) as MangaRow | null

  if (!row) {
    return c.json({ error: 'リンクが見つかりませんでした。' }, 404)
  }

  if (row.original_post_uri === 'pending') {
    const repairedUri = await tryRepairPendingLink(c, row)
    if (!repairedUri) {
      return c.json({ error: 'このリンクはまだ作成が完了していません。' }, 404)
    }
    row.original_post_uri = repairedUri
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
    // Only verified records have a stored CID.
    recordCid: row.record_cid ?? undefined,
  })
  response.headers.set(
    'Cache-Control',
    `public, max-age=30, s-maxage=${VIEWER_CACHE_SECONDS}`,
  )
  c.executionCtx.waitUntil(cache.put(cacheKey, response.clone()))
  return response
})

type ManagedLinkRow = {
  id: string
  title: string | null
  start_side: string | null
  original_post_uri: string
  record_cid: string | null
  state: string
  created_at: number | null
}

// Bound list size, including expired reservations retained for recovery.
const MANAGE_LIST_LIMIT = 200

app.get('/api/manage/links', async (c) => {
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

  try {
    await purgeExpiredPending(c.env.DB, authorDid)
    const result = await c.env.DB.prepare(
      `SELECT id, title, start_side, original_post_uri, record_cid, state, created_at FROM manga_links WHERE author_did = ? ORDER BY created_at DESC LIMIT ${MANAGE_LIST_LIMIT}`,
    )
      .bind(authorDid)
      .all()
    const baseUrl = c.env.APP_URL || 'https://skybind.blue'
    const links = ((result.results ?? []) as ManagedLinkRow[]).map((row) => ({
      id: row.id,
      title: row.title ?? undefined,
      startSide: row.start_side === 'left' ? 'left' : 'right',
      originalPostUri: row.original_post_uri,
      recordCid: row.record_cid ?? undefined,
      state: row.state === 'pending' ? 'pending' : 'active',
      createdAt: typeof row.created_at === 'number' ? row.created_at : undefined,
      viewerUrl: new URL(`/v/${row.id}`, baseUrl).toString(),
    }))
    return c.json({ links })
  } catch (err) {
    console.error(err)
    return c.json({ error: 'リンク一覧の取得に失敗しました。' }, 500)
  }
})

app.delete('/api/manage/links/:id', async (c) => {
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

  const id = c.req.param('id')
  if (!LINK_ID_PATTERN.test(id)) {
    return c.json({ error: 'idが不正です。' }, 400)
  }

  try {
    // Return the same response for another author's ID and a missing ID.
    const result = await c.env.DB.prepare(
      'DELETE FROM manga_links WHERE id = ? AND author_did = ?',
    )
      .bind(id, authorDid)
      .run()
    if (!result.meta.changes) {
      return c.json({ error: 'リンクが見つかりませんでした。' }, 404)
    }
  } catch (err) {
    console.error(err)
    return c.json({ error: 'リンクの削除に失敗しました。' }, 500)
  }

  // Deleted links remain available in the viewer cache until its TTL expires.
  return c.json({ ok: true })
})

// The client deletes the PDS record; this endpoint clears its stored verification.
app.delete('/api/manage/links/:id/record', async (c) => {
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

  const id = c.req.param('id')
  if (!LINK_ID_PATTERN.test(id)) {
    return c.json({ error: 'idが不正です。' }, 400)
  }
  // Match the deleted version so a concurrent record edit retains its verification.
  const expectedCid = (c.req.query('expectedCid') ?? '').trim()
  if (!isLikelyCid(expectedCid)) {
    return c.json({ error: 'expectedCidが必要です。' }, 400)
  }

  try {
    const result = await c.env.DB.prepare(
      'UPDATE manga_links SET record_cid = NULL WHERE id = ? AND author_did = ? AND record_cid = ?',
    )
      .bind(id, authorDid, expectedCid)
      .run()
    if (!result.meta.changes) {
      const row = (await c.env.DB.prepare(
        'SELECT id, author_did, title, start_side, original_post_uri, record_cid FROM manga_links WHERE id = ?',
      )
        .bind(id)
        .first()) as MangaRow | null
      if (!row || row.author_did !== authorDid) {
        return c.json({ error: 'リンクが見つかりませんでした。' }, 404)
      }
      return c.json(
        { error: '別の更新と競合しました。ページを再読み込みしてください。' },
        409,
      )
    }
  } catch (err) {
    console.error(err)
    return c.json({ error: 'レコード情報の更新に失敗しました。' }, 500)
  }

  return c.json({ ok: true })
})

app.onError((err, c) => {
  // Clients parse all API responses as JSON, including HTTPException errors.
  if (err instanceof HTTPException) {
    return c.json({ error: err.message }, err.status)
  }
  console.error(err)
  return c.json({ error: 'サーバーエラーが発生しました。' }, 500)
})
