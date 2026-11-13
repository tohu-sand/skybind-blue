import { useEffect, useRef, useState } from 'react'
import { getFrameStyles, getObjectPositionClass } from './frameStyles'
import type { FrameVariant } from './frameTypes'

export type ImagePage = {
  type: 'image'
  url: string
  alt?: string
  nsfw?: boolean
}

type ImageFrameProps = {
  image: ImagePage | null
  index: number
  revealed?: boolean
  onReveal?: () => void
  priority?: boolean
  frame?: FrameVariant
  // Hold the request back while a higher-priority page is still loading.
  deferred?: boolean
  // Called once the image has loaded or failed.
  onSettled?: (url: string) => void
}

export default function ImageFrame({
  image,
  index,
  revealed,
  onReveal,
  priority = false,
  frame = 'single',
  deferred = false,
  onSettled,
}: ImageFrameProps) {
  const [result, setResult] = useState<{
    url: string | undefined
    status: 'loading' | 'loaded' | 'error'
  }>({ url: image?.url, status: 'loading' })
  const [retryCount, setRetryCount] = useState(0)
  // A started request is never taken back: unmounting the <img> would drop a
  // loaded image and blank the page when it is shown again.
  const [started, setStarted] = useState(!deferred)
  if (!deferred && !started) {
    setStarted(true)
  }
  const imgRef = useRef<HTMLImageElement | null>(null)
  const url = image?.url
  const status = result.url === url ? result.status : 'loading'

  useEffect(() => {
    // Cached images may finish before React receives their load/error event.
    const img = imgRef.current
    setResult({
      url,
      status: img?.complete ? (img.naturalWidth > 0 ? 'loaded' : 'error') : 'loading',
    })
  }, [url, retryCount, started])

  useEffect(() => {
    if (url && status !== 'loading') {
      onSettled?.(url)
    }
  }, [url, status, onSettled])

  const { frameClass, backgroundClass, placeholderClass } = getFrameStyles(frame)
  const objectPositionClass = getObjectPositionClass(frame)

  if (!image) {
    return (
      <div className={`h-full w-full ${placeholderClass} ${frameClass}`} />
    )
  }

  const isBlurred = image.nsfw && !revealed
  const fetchPriority = priority ? 'high' : 'auto'

  return (
    <div
      className={`relative h-full w-full overflow-hidden ${backgroundClass} backdrop-blur-sm ${frameClass}`}
    >
      {started ? (
        <img
          key={`${image.url}:${retryCount}`}
          ref={imgRef}
          src={image.url}
          alt={image.alt || `Manga page ${index + 1}`}
          className={`h-full w-full select-none object-contain ${objectPositionClass} transition-opacity duration-500 ${
            status === 'loaded' ? 'opacity-100' : 'opacity-0'
          } ${isBlurred ? 'blur-2xl scale-[1.02]' : ''}`}
          fetchPriority={fetchPriority}
          // Async decoding lets the browser paint a turned page before its
          // image is decoded, leaving it blank for a few frames.
          decoding="sync"
          onLoad={() => setResult({ url, status: 'loaded' })}
          onError={() => setResult({ url, status: 'error' })}
          draggable={false}
        />
      ) : null}
      {status === 'loading' && (
        <div className="absolute inset-0 flex items-center justify-center bg-white/40">
          <div className="h-2 w-16 rounded-full bg-ink/20 animate-breath" />
        </div>
      )}
      {status === 'error' && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-paper/90 px-4 text-center">
          <p role="status" className="text-xs text-ink/70">画像を読み込めませんでした</p>
          <button
            type="button"
            onPointerDown={(event) => event.stopPropagation()}
            onPointerUp={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation()
              setResult({ url, status: 'loading' })
              setRetryCount((count) => count + 1)
            }}
            className="rounded-full border border-ink/15 bg-paper px-5 py-2 text-xs text-ink transition hover:bg-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          >
            再読み込み
          </button>
        </div>
      )}
      {isBlurred && (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation()
            onReveal?.()
          }}
          onPointerDown={(event) => event.stopPropagation()}
          onPointerUp={(event) => event.stopPropagation()}
          className="absolute inset-0 flex items-center justify-center bg-ink/60 px-6 text-[11px] font-semibold tracking-[0.2em] text-paper"
        >
          <span className="text-center leading-relaxed">
            成人向けコンテンツ
            <br />
            表示
          </span>
        </button>
      )}
    </div>
  )
}
