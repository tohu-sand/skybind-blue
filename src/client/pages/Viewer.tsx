import { useEffect, useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import Reader from '../components/Reader'
import StatusScreen from '../components/StatusScreen'
import {
  buildReaderPages,
  readErrorMessage,
  readJsonResponse,
  type MangaResponse,
} from '../utils/mangaReader'

export default function Viewer() {
  const { id } = useParams()
  const [data, setData] = useState<MangaResponse | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState('')
  const [retryCount, setRetryCount] = useState(0)

  useEffect(() => {
    if (!id) {
      return
    }

    const controller = new AbortController()
    setStatus('loading')
    setError('')

    fetch(`/api/manga/${id}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) {
          const message = await readErrorMessage(response)
          throw new Error(`[${response.status}] ${message}`)
        }
        try {
          return await readJsonResponse<MangaResponse>(response)
        } catch (err) {
          const message =
            err instanceof Error
              ? err.message
              : 'サーバーの応答が不正です。時間をおいて再度お試しください。'
          throw new Error(`[${response.status}] ${message}`)
        }
      })
      .then((payload) => {
        setData(payload)
        setStatus('ready')
      })
      .catch((err) => {
        if (controller.signal.aborted) {
          return
        }
        setError(err instanceof Error ? err.message : 'データ取得に失敗しました。')
        setStatus('error')
      })

    return () => {
      controller.abort()
    }
  }, [id, retryCount])

  const pages = useMemo(() => (data ? buildReaderPages(data) : []), [data])

  if (status === 'loading') {
    return (
      <StatusScreen title="Loading" subtitle="Fetching pages from Bluesky.">
        <div className="mt-6 flex items-center justify-center gap-2">
          <span className="h-2 w-2 rounded-full bg-accent animate-breath" />
          <span
            className="h-2 w-2 rounded-full bg-accent/70 animate-breath"
            style={{ animationDelay: '180ms' }}
          />
          <span
            className="h-2 w-2 rounded-full bg-accent/40 animate-breath"
            style={{ animationDelay: '360ms' }}
          />
        </div>
      </StatusScreen>
    )
  }

  if (status === 'error') {
    return (
      <StatusScreen title="Unable to open thread" subtitle={error}>
        <button
          type="button"
          onClick={() => setRetryCount((count) => count + 1)}
          className="mt-6 rounded-full bg-ink px-6 py-2.5 text-xs font-semibold uppercase tracking-[0.3em] text-paper transition hover:bg-ink/90"
        >
          再読み込み
        </button>
      </StatusScreen>
    )
  }

  if (!pages.length) {
    return (
      <StatusScreen
        title="No pages found"
        subtitle="画像付きの投稿が見つかりませんでした。"
      />
    )
  }

  return <Reader pages={pages} startOnLeft={data?.startSide === 'left'} />
}
