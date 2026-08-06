// This module deliberately avoids @atproto/api: the worker only needs two
// public XRPC GET queries, and the SDK's ESM build uses import attributes
// that the Pages Functions bundler (wrangler 3 / esbuild) cannot parse.
// The browser-side uploader keeps using the SDK.

import { fetchDidDocument, isPublicHostname, readBodyCapped } from './did'

type AuthorProfile = {
  did: string
  handle?: string
  displayName?: string
  avatar?: string
}

export type MangaThreadResult = {
  pages: string[]
  authorDid: string
  originalPostUri: string
  hasSensitive: boolean
  author: AuthorProfile
  // Chain posts in reading order (root first), for blue.skybind.comic `posts`.
  posts: { uri: string; cid: string }[]
  rootCid: string | null
  // Sensitive self-label values across the WHOLE chain (a child-only R18 post
  // must still mark the comic), for mirroring onto the record.
  sensitiveSelfLabels: string[]
}

export type BskyClient = { service: string }

type PostLabel = { val?: string; neg?: boolean }

type PostView = {
  uri: string
  cid?: string
  author: AuthorProfile
  record?: { createdAt?: string; text?: string }
  embed?: unknown
  labels?: PostLabel[]
  indexedAt?: string
  replyCount?: number
}

type ThreadViewPost = {
  $type?: string
  post: PostView
  replies?: unknown[]
}

const isThreadViewPost = (value: unknown): value is ThreadViewPost => {
  if (!value || typeof value !== 'object') {
    return false
  }
  const node = value as {
    $type?: unknown
    post?: { uri?: unknown; author?: { did?: unknown } }
  }
  return (
    node.$type === 'app.bsky.feed.defs#threadViewPost' &&
    typeof node.post?.uri === 'string' &&
    typeof node.post?.author?.did === 'string'
  )
}

// Upstream hosts include author-controlled PDSes, so responses are treated as
// hostile: redirects are never followed (they could point at an internal
// address), a timeout covers the body read too, and the bytes actually
// consumed are capped.
const XRPC_TIMEOUT_MS = 10_000
// Public-API thread chunks are the largest legitimate payloads (deep reply
// arrays reach a few hundred KB); 5 MB is far above that yet bounds memory.
const XRPC_MAX_BYTES = 5 * 1024 * 1024
const XRPC_ERROR_MAX_BYTES = 64 * 1024

const xrpcGet = async <T,>(
  client: BskyClient,
  nsid: string,
  params: Record<string, string | number>,
): Promise<T> => {
  const url = new URL(`/xrpc/${nsid}`, client.service)
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, String(value))
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), XRPC_TIMEOUT_MS)
  try {
    const response = await fetch(url.toString(), {
      headers: { Accept: 'application/json' },
      redirect: 'manual',
      signal: controller.signal,
    })
    if (!response.ok) {
      let body: { error?: string; message?: string } | null = null
      try {
        body = JSON.parse(
          await readBodyCapped(
            response,
            controller,
            XRPC_ERROR_MAX_BYTES,
            '応答が大きすぎます。',
          ),
        ) as { error?: string; message?: string }
      } catch {
        // not JSON (or oversized); fall through to the generic message
      }
      const error = new Error(
        body?.message || `${nsid} failed (${response.status})`,
      ) as Error & { status?: number; error?: string }
      error.status = response.status
      if (body?.error) {
        error.error = body.error
      }
      throw error
    }
    return JSON.parse(
      await readBodyCapped(response, controller, XRPC_MAX_BYTES, '応答が大きすぎます。'),
    ) as T
  } finally {
    clearTimeout(timer)
  }
}

const toTimestamp = (post: {
  indexedAt?: string
  record?: { createdAt?: string }
}) => {
  const value = post.indexedAt || post.record?.createdAt
  if (!value) {
    return Number.POSITIVE_INFINITY
  }
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? Number.POSITIVE_INFINITY : parsed
}

// Posts expose pages through two embed shapes:
//   - app.bsky.embed.images (1-4 photos): `images[]`, each with `thumb`/`fullsize`
//   - app.bsky.embed.gallery (5+ photo carousels, added 2026): `items[]`, each
//     with `thumbnail`/`fullsize`
// Both always carry `fullsize`. recordWithMedia nests either shape under `media`.
type EmbedImageView = { fullsize?: string; thumb?: string; thumbnail?: string }
type EmbedView = {
  $type?: string
  images?: EmbedImageView[]
  items?: EmbedImageView[]
  media?: EmbedView
}

const collectEmbedUrls = (value: EmbedView | undefined): string[] => {
  if (!value || typeof value !== 'object' || typeof value.$type !== 'string') {
    return []
  }
  const list = value.$type.includes('app.bsky.embed.images')
    ? value.images
    : value.$type.includes('app.bsky.embed.gallery')
      ? value.items
      : null
  if (!Array.isArray(list)) {
    return []
  }
  return list
    .map((image) => image.fullsize || image.thumbnail || image.thumb)
    .filter((url): url is string => Boolean(url))
}

const extractImages = (embed: unknown): string[] => {
  if (!embed || typeof embed !== 'object') {
    return []
  }
  const view = embed as EmbedView
  const direct = collectEmbedUrls(view)
  return direct.length ? direct : collectEmbedUrls(view.media)
}

const SENSITIVE_LABELS = new Set(['porn', 'sexual', 'nudity'])

const extractSelfLabelValues = (record: unknown) => {
  if (!record || typeof record !== 'object') {
    return []
  }
  const labels = (record as { labels?: unknown }).labels
  if (!labels || typeof labels !== 'object') {
    return []
  }
  const values = (labels as { values?: unknown }).values
  if (!Array.isArray(values)) {
    return []
  }
  return values
    .map((value) => {
      if (!value || typeof value !== 'object') {
        return null
      }
      const val = (value as { val?: unknown }).val
      return typeof val === 'string' ? val : null
    })
    .filter((val): val is string => Boolean(val))
}

const hasSensitiveLabels = (post: PostView) => {
  if (
    post.labels?.some(
      (label) => !label.neg && typeof label.val === 'string' && SENSITIVE_LABELS.has(label.val),
    )
  ) {
    return true
  }
  return extractSelfLabelValues(post.record).some((val) => SENSITIVE_LABELS.has(val))
}

const pickNextReply = (replies: unknown[] | undefined, authorDid: string) => {
  if (!replies?.length) {
    return null
  }

  const candidates = replies
    .filter(isThreadViewPost)
    .filter((reply) => reply.post.author.did === authorDid)

  if (!candidates.length) {
    return null
  }

  const sorted = candidates
    .map((reply, index) => ({
      reply,
      index,
      ts: toTimestamp(reply.post),
    }))
    .sort((a, b) => (a.ts - b.ts) || (a.index - b.index))

  return sorted[0]?.reply ?? null
}

export const createAgent = (serviceUrl: string): BskyClient => ({
  service: serviceUrl,
})

export const resolvePostUri = async (agent: BskyClient, input: string) => {
  if (input.startsWith('at://')) {
    return input
  }

  let parsed: URL
  try {
    parsed = new URL(input)
  } catch {
    throw new Error('URLの形式が正しくありません。')
  }

  const segments = parsed.pathname.split('/').filter(Boolean)
  const profileIndex = segments.indexOf('profile')
  if (profileIndex === -1) {
    throw new Error('BlueskyのポストURLを入力してください。')
  }

  const handleOrDid = segments[profileIndex + 1]
  const postKeyword = segments[profileIndex + 2]
  const rkey = segments[profileIndex + 3]

  if (!handleOrDid || postKeyword !== 'post' || !rkey) {
    throw new Error('BlueskyのポストURLを入力してください。')
  }

  const did = handleOrDid.startsWith('did:')
    ? handleOrDid
    : (
        await xrpcGet<{ did: string }>(agent, 'com.atproto.identity.resolveHandle', {
          handle: handleOrDid,
        })
      ).did

  return `at://${did}/app.bsky.feed.post/${rkey}`
}

export const fetchMangaThread = async (
  agent: BskyClient,
  uri: string,
): Promise<MangaThreadResult> => {
  const pages: string[] = []
  const posts: { uri: string; cid: string }[] = []
  const sensitiveSelfLabelSet = new Set<string>()
  const visited = new Set<string>()
  let authorDid = ''
  let author: AuthorProfile | null = null
  let rootCid: string | null = null
  let currentUri: string | null = uri
  let steps = 0
  const maxSteps = 250
  let hasSensitive = false
  const chunkDepth = 15

  // Public API caps thread depth, so walk a chunk at a time and continue from the tail.
  while (currentUri) {
    if (steps >= maxSteps) {
      break
    }
    const response: { thread?: unknown } = await xrpcGet(
      agent,
      'app.bsky.feed.getPostThread',
      {
        uri: currentUri,
        depth: chunkDepth,
        parentHeight: 0,
      },
    )

    if (!isThreadViewPost(response.thread)) {
      throw new Error('スレッドが取得できませんでした。')
    }

    let current: ThreadViewPost | null = response.thread
    let lastNode: ThreadViewPost | null = current
    let newVisits = 0
    let stepsInChunk = 0

    while (current && steps < maxSteps) {
      if (!authorDid) {
        authorDid = current.post.author.did
      }
      if (!author) {
        author = {
          did: current.post.author.did,
          handle: current.post.author.handle,
          displayName: current.post.author.displayName,
          avatar: current.post.author.avatar,
        }
      }
      if (!hasSensitive && hasSensitiveLabels(current.post)) {
        hasSensitive = true
      }
      if (!visited.has(current.post.uri)) {
        visited.add(current.post.uri)
        newVisits += 1
        pages.push(...extractImages(current.post.embed))
        if (typeof current.post.cid === 'string') {
          posts.push({ uri: current.post.uri, cid: current.post.cid })
        }
        if (!rootCid && current.post.uri === uri) {
          rootCid = current.post.cid ?? null
        }
        for (const val of extractSelfLabelValues(current.post.record)) {
          if (SENSITIVE_LABELS.has(val)) {
            sensitiveSelfLabelSet.add(val)
          }
        }
      }

      lastNode = current
      steps += 1
      stepsInChunk += 1

      const next = pickNextReply(current.replies, authorDid)
      if (!next) {
        break
      }
      if (visited.has(next.post.uri)) {
        break
      }
      current = next
    }

    if (!lastNode) {
      break
    }

    const replyCount = lastNode.post.replyCount
    const replyCountKnown = typeof replyCount === 'number'
    const hasMoreReplies = replyCountKnown ? replyCount > 0 : false
    const replyLength = Array.isArray(lastNode.replies) ? lastNode.replies.length : 0
    const depthLikelyCapped =
      (hasMoreReplies && replyLength === 0) ||
      (!replyCountKnown && stepsInChunk >= chunkDepth)

    if (!depthLikelyCapped || newVisits === 0) {
      break
    }
    currentUri = lastNode.post.uri
  }

  return {
    pages,
    authorDid,
    originalPostUri: uri,
    hasSensitive,
    author: author ?? { did: authorDid },
    posts,
    rootCid,
    sensitiveSelfLabels: Array.from(sensitiveSelfLabelSet),
  }
}

// --- pending link self-repair ------------------------------------------------
// The uploader publishes the viewer URL in the ROOT post before the final
// bind call, so a crashed run can leave a live published URL pointing at a
// pending row. Everything needed to finish the bind is public: scan the row
// author's own feed for a root post with images whose text carries the URL.
// (Same ownership proof as legacy /complete: only the author can have posted
// it to their own repo.)

const REPAIR_FEED_PAGE_CAP = 5
const REPAIR_SINCE_MARGIN_MS = 60 * 60 * 1000

export const findPublishedLinkPost = async (
  agent: BskyClient,
  authorDid: string,
  linkId: string,
  // Reservation time: posts older than this (minus margin) cannot be the one.
  sinceEpochSec: number | null,
): Promise<string | null> => {
  const needle = `/v/${linkId}`
  const sinceMs =
    sinceEpochSec !== null ? sinceEpochSec * 1000 - REPAIR_SINCE_MARGIN_MS : null
  let cursor: string | undefined
  // The upload posts the URL within minutes of the reservation, so the OLDEST
  // qualifying post is the comic root; later shares/reposts must lose.
  let best: { uri: string; ts: number } | null = null

  for (let page = 0; page < REPAIR_FEED_PAGE_CAP; page += 1) {
    const params: Record<string, string | number> = {
      actor: authorDid,
      limit: 100,
    }
    if (cursor) {
      params.cursor = cursor
    }
    const response = await xrpcGet<{ feed?: unknown[]; cursor?: string }>(
      agent,
      'app.bsky.feed.getAuthorFeed',
      params,
    )
    const feed = Array.isArray(response.feed) ? response.feed : []
    if (!feed.length) {
      break
    }
    let reachedOlder = false
    for (const item of feed) {
      const entry = item as { post?: PostView; reason?: unknown }
      if (entry.reason || !entry.post) {
        continue // repost of someone else's (or own) post
      }
      const post = entry.post
      if (post.author?.did !== authorDid) {
        continue
      }
      const record = post.record as
        | { text?: string; createdAt?: string; reply?: unknown }
        | undefined
      const ts = Date.parse(record?.createdAt ?? '')
      if (sinceMs !== null && !Number.isNaN(ts) && ts < sinceMs) {
        reachedOlder = true
        continue
      }
      if (record?.reply) {
        continue // the URL lives in the root post only
      }
      if (typeof record?.text !== 'string' || !record.text.includes(needle)) {
        continue
      }
      if (!extractImages(post.embed).length) {
        continue // text-only shares of the URL are not the comic
      }
      const orderTs = Number.isNaN(ts) ? Number.MAX_SAFE_INTEGER : ts
      if (!best || orderTs < best.ts) {
        best = { uri: post.uri, ts: orderTs }
      }
    }
    if (reachedOlder) {
      break
    }
    cursor = response.cursor
    if (!cursor) {
      break
    }
  }

  return best?.uri ?? null
}

// Single-post fetch used by the /complete verification paths.
export type PostSummary = {
  text: string
  cid: string | null
  authorDid: string
}

export const fetchPostSummary = async (
  agent: BskyClient,
  uri: string,
): Promise<PostSummary> => {
  const response: { thread?: unknown } = await xrpcGet(
    agent,
    'app.bsky.feed.getPostThread',
    { uri, depth: 0, parentHeight: 0 },
  )
  if (!isThreadViewPost(response.thread)) {
    throw new Error('ポストが取得できませんでした。')
  }
  const post = response.thread.post
  return {
    text: post.record?.text ?? '',
    cid: typeof post.cid === 'string' ? post.cid : null,
    authorDid: post.author.did,
  }
}

// --- blue.skybind.comic record verification helpers -------------------------
// /complete proves account control by fetching the comic record from the
// author's own PDS: only the account holder can have written it there.

export const resolvePdsEndpoint = async (did: string): Promise<string> => {
  // The shared resolver validates the DID before any network access (SSRF),
  // never follows redirects, bounds the fetch by timeout and size, and caches
  // documents — so repeated /complete attempts don't re-resolve per request.
  const { doc } = await fetchDidDocument(did)
  // Per the DID spec, match the PDS service by both id and type.
  const service = doc.service?.find(
    (entry) =>
      (entry?.id === '#atproto_pds' || entry?.id === `${did}#atproto_pds`) &&
      entry?.type === 'AtprotoPersonalDataServer',
  )
  const endpoint = service?.serviceEndpoint
  if (typeof endpoint !== 'string') {
    throw new Error('PDSが見つかりませんでした。')
  }
  let parsed: URL
  try {
    parsed = new URL(endpoint)
  } catch {
    throw new Error('PDSエンドポイントが不正です。')
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.pathname !== '/' && parsed.pathname !== '') ||
    // The endpoint is read from an attacker-influencable document, so the
    // host must look public: no IP literals (169.254.169.254, [::1], ...),
    // localhost, or reserved TLDs. Explicit ports stay allowed — the atproto
    // DID spec permits them for PDS service endpoints.
    !isPublicHostname(parsed.hostname)
  ) {
    throw new Error('PDSエンドポイントが不正です。')
  }
  return parsed.origin
}

export type FetchedRecord = {
  uri: string
  cid: string
  value: Record<string, unknown>
}

export const fetchRepoRecord = async (
  pds: string,
  did: string,
  collection: string,
  rkey: string,
): Promise<FetchedRecord> => {
  const client: BskyClient = { service: pds }
  const response = await xrpcGet<{ uri?: string; cid?: string; value?: unknown }>(
    client,
    'com.atproto.repo.getRecord',
    { repo: did, collection, rkey },
  )
  if (
    typeof response.uri !== 'string' ||
    typeof response.cid !== 'string' ||
    !response.value ||
    typeof response.value !== 'object'
  ) {
    throw new Error('レコードの取得に失敗しました。')
  }
  return {
    uri: response.uri,
    cid: response.cid,
    value: response.value as Record<string, unknown>,
  }
}

const bytesToBase64Url = (bytes: Uint8Array) => {
  let binary = ''
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte)
  })
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

export const generateShortId = (length = 10) => {
  const bytes = new Uint8Array(Math.ceil((length * 3) / 4))
  crypto.getRandomValues(bytes)
  return bytesToBase64Url(bytes).slice(0, length)
}
