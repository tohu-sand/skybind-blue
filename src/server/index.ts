import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { HTTPException } from 'hono/http-exception'
import { readCompletePayload, readGeneratePayload, readReservePayload } from './auth'
import { createAgent, fetchMangaThread, generateShortId, resolvePostUri } from './manga'

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
}

type InsertLinkInput = {
  id?: string
  authorDid: string
  title?: string | null
  pagesJson: string
  startSide: 'right' | 'left'
  originalPostUri: string
}

const MAX_LINKS_PER_AUTHOR = 100
// Edge-cache TTL for viewer responses. One viewer request fans out into up to
// ~17 sequential getPostThread calls upstream, so even a short TTL matters.
const VIEWER_CACHE_SECONDS = 60

const toErrorMessage = (err: unknown, fallback: string) =>
  err instanceof Error && err.message ? err.message : fallback

const isNotFoundError = (err: unknown) => {
  if (!err || typeof err !== 'object') {
    return false
  }
  const maybe = err as { error?: string; status?: number }
  if (maybe.error === 'NotFound') {
    return true
  }
  if (typeof maybe.status === 'number' && maybe.status === 404) {
    return true
  }
  return err instanceof Error && /not found/i.test(err.message)
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
          'INSERT INTO manga_links (id, author_did, title, pages_json, start_side, original_post_uri) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .bind(
          candidate,
          input.authorDid,
          input.title ?? null,
          input.pagesJson,
          input.startSide,
          input.originalPostUri,
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
  const payload = await readReservePayload(c)

  if (!c.env.DB) {
    return c.json({ error: 'DBバインドが未設定です。' }, 500)
  }

  try {
    const row = (await c.env.DB.prepare(
      'SELECT COUNT(1) as count FROM manga_links WHERE author_did = ?',
    )
      .bind(payload.authorDid)
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
      authorDid: payload.authorDid,
      title: payload.title ?? null,
      pagesJson: JSON.stringify([]),
      startSide: payload.startSide,
      originalPostUri: 'pending',
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
  if (thread.authorDid !== payload.authorDid) {
    return c.json({ error: '作者本人のみURLを生成できます。' }, 403)
  }

  if (!thread.pages.length) {
    return c.json({ error: '画像付きのポストが見つかりませんでした。' }, 400)
  }

  if (!c.env.DB) {
    return c.json({ error: 'DBバインドが未設定です。' }, 500)
  }

  try {
    const row = (await c.env.DB.prepare(
      'SELECT COUNT(1) as count FROM manga_links WHERE author_did = ?',
    )
      .bind(payload.authorDid)
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
      authorDid: payload.authorDid,
      title: payload.title ?? null,
      pagesJson: JSON.stringify([]),
      startSide: payload.startSide,
      originalPostUri: thread.originalPostUri,
    })
  } catch (err) {
    console.error(err)
    return c.json({ error: 'DBへの書き込みに失敗しました。' }, 500)
  }

  const baseUrl = c.env.APP_URL || 'https://skybind.blue'
  const viewerUrl = new URL(`/v/${insertedId}`, baseUrl).toString()

  return c.json({ id: insertedId, viewerUrl })
})

app.post('/api/manga/complete', async (c) => {
  const payload = await readCompletePayload(c)

  if (!c.env.DB) {
    return c.json({ error: 'DBバインドが未設定です。' }, 500)
  }

  const row = (await c.env.DB.prepare(
    'SELECT id, author_did, title, start_side, original_post_uri FROM manga_links WHERE id = ?',
  )
    .bind(payload.id)
    .first()) as MangaRow | null

  if (!row) {
    return c.json({ error: 'リンクが見つかりませんでした。' }, 404)
  }

  if (row.author_did !== payload.authorDid) {
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

  if (row.original_post_uri === 'pending') {
    try {
      await c.env.DB.prepare(
        'UPDATE manga_links SET original_post_uri = ? WHERE id = ?',
      )
        .bind(postUri, payload.id)
        .run()
    } catch (updateErr) {
      console.error(updateErr)
      return c.json({ error: 'DBの更新に失敗しました。' }, 500)
    }

    const baseUrl = c.env.APP_URL || 'https://skybind.blue'
    const viewerUrl = new URL(`/v/${payload.id}`, baseUrl).toString()
    return c.json({ id: payload.id, viewerUrl, pending: true })
  }

  const baseUrl = c.env.APP_URL || 'https://skybind.blue'
  const viewerUrl = new URL(`/v/${payload.id}`, baseUrl).toString()
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
    'SELECT id, author_did, title, start_side, original_post_uri FROM manga_links WHERE id = ?',
  )
    .bind(id)
    .first()) as MangaRow | null

  if (!row) {
    return c.json({ error: 'リンクが見つかりませんでした。' }, 404)
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
  })
  response.headers.set(
    'Cache-Control',
    `public, max-age=30, s-maxage=${VIEWER_CACHE_SECONDS}`,
  )
  c.executionCtx.waitUntil(cache.put(cacheKey, response.clone()))
  return response
})

app.onError((err, c) => {
  if (err instanceof HTTPException) {
    return err.getResponse()
  }
  console.error(err)
  return c.json({ error: 'サーバーエラーが発生しました。' }, 500)
})
