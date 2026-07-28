import { useEffect, useMemo, useState } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import Reader, { type ReaderLayout } from '../components/Reader'
import StatusScreen from '../components/StatusScreen'
import {
  buildReaderPages,
  readErrorMessage,
  readJsonResponse,
  type MangaResponse,
} from '../utils/mangaReader'

type UiMode = 'full' | 'minimal' | 'none'

const parseLayout = (value: string | null): ReaderLayout => {
  if (!value) {
    return 'auto'
  }
  const normalized = value.toLowerCase()
  if (['single', 'one', '1', '1up'].includes(normalized)) {
    return 'single'
  }
  if (['spread', 'double', '2', '2up', 'book'].includes(normalized)) {
    return 'spread'
  }
  return 'auto'
}

const parseInitialPage = (value: string | null): number | undefined => {
  if (!value) {
    return undefined
  }
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return undefined
  }
  return parsed
}

const parseUiMode = (value: string | null): UiMode => {
  if (!value) {
    return 'full'
  }
  const normalized = value.toLowerCase()
  if (['0', 'none', 'off', 'false'].includes(normalized)) {
    return 'none'
  }
  if (['min', 'minimal', 'compact'].includes(normalized)) {
    return 'minimal'
  }
  return 'full'
}

export default function EmbedViewer() {
  const { id } = useParams()
  const [searchParams] = useSearchParams()
  const [data, setData] = useState<MangaResponse | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState('')
  const [retryCount, setRetryCount] = useState(0)

  const layoutParam =
    searchParams.get('layout') ||
    searchParams.get('mode') ||
    searchParams.get('view')
  const layout = parseLayout(layoutParam)
  const initialPage = parseInitialPage(searchParams.get('page'))
  const uiParam = searchParams.get('ui') || searchParams.get('chrome') || searchParams.get('controls')
  const uiMode = parseUiMode(uiParam)

  useEffect(() => {
    if (!id) {
      return
    }

    let alive = true
    setStatus('loading')
    setError('')

    fetch(`/api/manga/${id}`)
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
        if (!alive) {
          return
        }
        setData(payload)
        setStatus('ready')
      })
      .catch((err) => {
        if (!alive) {
          return
        }
        setError(err instanceof Error ? err.message : 'データ取得に失敗しました。')
        setStatus('error')
      })

    return () => {
      alive = false
    }
  }, [id, retryCount])

  const pages = useMemo(() => (data ? buildReaderPages(data) : []), [data])

  const viewerUrl = useMemo(() => {
    if (!id || typeof window === 'undefined') {
      return ''
    }
    return new URL(`/v/${id}`, window.location.origin).toString()
  }, [id])

  const showBrand = uiMode === 'full'
  const showPageIndicator = uiMode !== 'none'

  if (status === 'loading') {
    return (
      <StatusScreen
        showBrand={showBrand}
        title="Loading"
        subtitle="Fetching pages from Bluesky."
      >
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
      <StatusScreen showBrand={showBrand} title="Unable to open thread" subtitle={error}>
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
        showBrand={showBrand}
        title="No pages found"
        subtitle="画像付きの投稿が見つかりませんでした。"
      />
    )
  }

  return (
    <div className="min-h-screen w-full bg-paper">
      <Reader
        pages={pages}
        startOnLeft={data?.startSide === 'left'}
        layout={layout}
        initialPage={initialPage}
        brand={
          showBrand && viewerUrl
            ? {
                label: 'SkyBind',
                href: viewerUrl,
                target: '_blank',
                rel: 'noreferrer',
                title: 'Open in SkyBind',
              }
            : null
        }
        showPageIndicator={showPageIndicator}
      />
    </div>
  )
}
