import type { Agent } from '@atproto/api'
import {
  COMIC_COLLECTION,
  SERVICE_AUTH_AUD,
  SERVICE_AUTH_LXM,
  comicRecordUri,
  parsePostUri,
  type ComicRecord,
  type StrongRef,
} from '../../shared/comicRecord'

export const RETRY_LIMIT = 3
const RETRY_BASE_MS = 700

export const AUTH_REFRESH_MESSAGE =
  '権限の更新が必要です。一度ログアウトして、ログインし直してください。'

export const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    window.setTimeout(resolve, ms)
  })

export const getErrorStatus = (err: unknown): number | null => {
  if (!err || typeof err !== 'object') {
    return null
  }
  const status = (err as { status?: number; statusCode?: number }).status
  if (typeof status === 'number') {
    return status
  }
  const statusCode = (err as { statusCode?: number }).statusCode
  if (typeof statusCode === 'number') {
    return statusCode
  }
  const causeStatus = (err as { cause?: { status?: number } }).cause?.status
  return typeof causeStatus === 'number' ? causeStatus : null
}

const isRetriableError = (err: unknown) => {
  const status = getErrorStatus(err)
  if (status === null) {
    const message = err instanceof Error ? err.message : ''
    return message.includes('Network') || message.includes('fetch')
  }
  if (status === 1 || status === 2) {
    return true
  }
  if (status === 408 || status === 429) {
    return true
  }
  return status >= 500
}

export async function withRetry<T>(
  task: () => Promise<T>,
  onRetry?: (attempt: number) => void,
): Promise<T> {
  let attempt = 0
  while (true) {
    try {
      return await task()
    } catch (err) {
      if (!isRetriableError(err) || attempt >= RETRY_LIMIT - 1) {
        throw err
      }
      attempt += 1
      onRetry?.(attempt)
      const delay = RETRY_BASE_MS * Math.pow(2, attempt - 1)
      await sleep(delay)
    }
  }
}

// Short-lived proof of account control, minted by the user's own PDS and
// verified by the SkyBind API. Minting fails on sessions that predate the
// rpc scope — those users must re-login.
export const getServiceAuthHeader = async (agent: Agent): Promise<string> => {
  try {
    const response = await agent.com.atproto.server.getServiceAuth({
      aud: SERVICE_AUTH_AUD,
      lxm: SERVICE_AUTH_LXM,
    })
    return `Bearer ${response.data.token}`
  } catch (err) {
    console.error('service auth minting failed', err)
    throw new Error(AUTH_REFRESH_MESSAGE)
  }
}

// Best-effort sidecar record in the author's own repo (rkey = root post rkey),
// so third-party clients can look the comic up straight from the post.
export const putComicRecord = async (
  agent: Agent,
  did: string,
  input: {
    subject: StrongRef
    url: string
    posts?: StrongRef[]
    title?: string
    startSide: 'right' | 'left'
    language?: string
    labelValues?: string[]
    pageCount?: number
    // Preserved across edits: the record keeps its original creation time.
    createdAt?: string
  },
) => {
  const subjectPost = parsePostUri(input.subject.uri)
  if (!subjectPost) {
    throw new Error('subjectのURIが不正です。')
  }
  const record: ComicRecord = {
    $type: COMIC_COLLECTION,
    subject: input.subject,
    url: input.url,
    startSide: input.startSide,
    createdAt: input.createdAt ?? new Date().toISOString(),
  }
  if (input.posts?.length) {
    record.posts = input.posts
  }
  if (input.title) {
    record.title = input.title
  }
  if (input.language) {
    record.language = input.language
  }
  if (input.pageCount) {
    record.pageCount = input.pageCount
  }
  if (input.labelValues?.length) {
    record.labels = {
      $type: 'com.atproto.label.defs#selfLabels',
      values: input.labelValues.map((val) => ({ val })),
    }
  }
  const response = await agent.com.atproto.repo.putRecord({
    repo: did,
    collection: COMIC_COLLECTION,
    rkey: subjectPost.rkey,
    record: record as unknown as Record<string, unknown>,
  })
  return { uri: comicRecordUri(did, subjectPost.rkey), cid: response.data.cid }
}

export type CompleteResponse = {
  id: string
  viewerUrl: string
  pending?: boolean
  recordCid?: string
}

export const completeLink = async (
  body:
    | { id: string; recordUri: string; recordCid?: string }
    | { id: string; postUrl: string },
  // Service-auth tokens are single-use, so each retry mints a fresh one.
  mintAuthHeader?: () => Promise<string>,
): Promise<CompleteResponse> => {
  const maxAttempts = 3
  let lastError: Error | null = null

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const authHeader = mintAuthHeader ? await mintAuthHeader() : null
      const response = await fetch('/api/manga/complete', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(authHeader ? { Authorization: authHeader } : {}),
        },
        body: JSON.stringify(body),
      })

      // WAF/edge errors may be HTML: never let JSON parsing swallow the
      // HTTP status (it decides whether the attempt is retriable).
      const data = (await response.json().catch(() => null)) as
        | (CompleteResponse & { error?: string })
        | null
      if (response.ok && data) {
        return data
      }

      const message = data?.error || 'リンクの紐づけに失敗しました。'
      throw Object.assign(new Error(`[${response.status}] ${message}`), {
        status: response.status,
      })
    } catch (err) {
      lastError = err instanceof Error ? err : new Error('リンクの紐づけに失敗しました。')
      const status = getErrorStatus(err)
      const retriable = status === null || status === 404 || status >= 500
      if (!retriable) {
        throw lastError
      }
      if (attempt < maxAttempts - 1) {
        await sleep(1000 * (attempt + 1))
      }
    }
  }

  throw lastError || new Error('リンクの紐づけに失敗しました。')
}
