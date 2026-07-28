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
}

export default function ImageFrame({
  image,
  index,
  revealed,
  onReveal,
  priority = false,
  frame = 'single',
}: ImageFrameProps) {
  const [loaded, setLoaded] = useState(false)
  const imgRef = useRef<HTMLImageElement | null>(null)

  useEffect(() => {
    // Check if image is already cached before resetting loaded state
    if (image?.url) {
      const testImg = new Image()
      testImg.src = image.url
      if (testImg.complete && testImg.naturalWidth > 0) {
        setLoaded(true)
        return
      }
    }
    setLoaded(false)
  }, [image?.url])

  useEffect(() => {
    const img = imgRef.current
    if (!img) {
      return
    }
    if (img.complete && img.naturalWidth > 0) {
      setLoaded(true)
    }
  }, [image?.url])

  const { frameClass, backgroundClass, placeholderClass } = getFrameStyles(frame)
  const objectPositionClass = getObjectPositionClass(frame)

  if (!image) {
    return (
      <div className={`h-full w-full ${placeholderClass} ${frameClass}`} />
    )
  }

  const isBlurred = image.nsfw && !revealed
  const loading = priority ? 'eager' : 'lazy'
  const fetchPriority = priority ? 'high' : 'auto'

  return (
    <div
      className={`relative h-full w-full overflow-hidden ${backgroundClass} backdrop-blur-sm ${frameClass}`}
    >
      <img
        ref={imgRef}
        src={image.url}
        alt={image.alt || `Manga page ${index + 1}`}
        className={`h-full w-full select-none object-contain ${objectPositionClass} transition-opacity duration-500 ${
          loaded ? 'opacity-100' : 'opacity-0'
        } ${isBlurred ? 'blur-2xl scale-[1.02]' : ''}`}
        loading={loading}
        fetchPriority={fetchPriority}
        decoding="async"
        onLoad={() => setLoaded(true)}
        onError={() => setLoaded(true)}
        draggable={false}
      />
      {!loaded && (
        <div className="absolute inset-0 flex items-center justify-center bg-white/40">
          <div className="h-2 w-16 rounded-full bg-ink/20 animate-breath" />
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
