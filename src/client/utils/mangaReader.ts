import type { ReaderPage } from '../components/Reader'

export type MangaResponse = {
  id: string
  title?: string
  pages: string[]
  startSide: 'right' | 'left'
  originalPostUri: string
  hasSensitive: boolean
  author: {
    did: string
    handle?: string
    displayName?: string
    avatar?: string
  }
}

export const readJsonResponse = async <T,>(response: Response): Promise<T> => {
  const contentType = response.headers.get('content-type') || ''
  if (!contentType.includes('application/json')) {
    const text = await response.text()
    const fallback =
      'サーバーの応答が不正です。時間をおいて再度お試しください。'
    throw new Error(text && !text.trim().startsWith('<') ? text : fallback)
  }
  try {
    return (await response.json()) as T
  } catch {
    throw new Error('サーバーの応答が不正です。時間をおいて再度お試しください。')
  }
}

export const readErrorMessage = async (response: Response) => {
  const contentType = response.headers.get('content-type') || ''
  if (contentType.includes('application/json')) {
    try {
      const body = (await response.json()) as { error?: string }
      return body.error || 'データ取得に失敗しました。'
    } catch {
      return 'サーバーの応答が不正です。'
    }
  }
  const text = await response.text()
  if (text && !text.trim().startsWith('<')) {
    return text
  }
  return 'サーバーの応答が不正です。'
}

const extractActorFromAtUri = (uri: string) => {
  if (!uri.startsWith('at://')) {
    return ''
  }
  const parts = uri.split('/').filter(Boolean)
  return parts.length >= 2 ? parts[1] : ''
}

export const toBskyPostUrl = (uri: string, actor: string) => {
  if (!uri) {
    return ''
  }
  if (uri.startsWith('http')) {
    return uri
  }
  if (!uri.startsWith('at://')) {
    return ''
  }
  const parts = uri.split('/').filter(Boolean)
  const rkey = parts[parts.length - 1]
  if (!rkey || !actor) {
    return ''
  }
  return `https://bsky.app/profile/${actor}/post/${rkey}`
}

export const buildReaderPages = (data: MangaResponse): ReaderPage[] => {
  const imagePages = data.pages.map((url, index) => ({
    type: 'image' as const,
    url,
    alt: `Manga page ${index + 1}`,
    nsfw: Boolean(data.hasSensitive),
  }))

  const fallbackActor = extractActorFromAtUri(data.originalPostUri)
  const actor = data.author.handle || data.author.did || fallbackActor
  const name =
    data.author.displayName || data.author.handle || data.author.did || 'Unknown author'

  const authorPage = actor || data.author.displayName
    ? {
        type: 'author' as const,
        name,
        handle: actor,
        avatar: data.author.avatar || '',
        url: actor ? `https://bsky.app/profile/${actor}` : '',
        firstPostUrl: toBskyPostUrl(data.originalPostUri, actor),
      }
    : null

  return authorPage ? [...imagePages, authorPage] : imagePages
}
