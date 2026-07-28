import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent,
} from 'react'
import useMediaQuery from '../hooks/useMediaQuery'
import AuthorFrame, { type AuthorPage } from './AuthorFrame'
import ImageFrame, { type ImagePage } from './ImageFrame'
import type { FrameVariant } from './frameTypes'

export type ReaderPage = ImagePage | AuthorPage

export type ReaderLayout = 'auto' | 'single' | 'spread'

type ReaderBrand = {
  label: string
  href: string
  target?: '_self' | '_blank'
  rel?: string
  title?: string
}

type ReaderProps = {
  pages: ReaderPage[]
  startOnLeft?: boolean
  layout?: ReaderLayout
  initialPage?: number
  brand?: ReaderBrand | null
  showPageIndicator?: boolean
}

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max)

export default function Reader({
  pages,
  startOnLeft = false,
  layout = 'auto',
  initialPage,
  brand,
  showPageIndicator = true,
}: ReaderProps) {
  const isLandscape = useMediaQuery('(orientation: landscape)')
  const isSpread =
    layout === 'spread' ? true : layout === 'single' ? false : isLandscape
  const [index, setIndex] = useState(0)
  const [nsfwRevealed, setNsfwRevealed] = useState(false)
  const leftStartSpread = isSpread && startOnLeft
  const preloadedRef = useRef<Set<string>>(new Set())
  const previousSpreadRef = useRef(isSpread)
  const previousPagesRef = useRef<ReaderPage[] | null>(null)
  const previousInitialPageRef = useRef<number | undefined>(undefined)
  const [swipeOffset, setSwipeOffset] = useState(0)
  const [isAnimating, setIsAnimating] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const resolvedBrand = brand === undefined ? { label: 'SkyBind', href: '/' } : brand
  const pointerState = useRef({
    pointerId: null as number | null,
    startX: 0,
    startY: 0,
    currentX: 0,
    isDragging: false,
  })

  useEffect(() => {
    const { body, documentElement } = document
    const previousBodyOverflow = body.style.overflow
    const previousBodyOverscroll = body.style.overscrollBehavior
    const previousRootOverflow = documentElement.style.overflow
    const previousRootOverscroll = documentElement.style.overscrollBehavior

    body.style.overflow = 'hidden'
    body.style.overscrollBehavior = 'none'
    documentElement.style.overflow = 'hidden'
    documentElement.style.overscrollBehavior = 'none'

    return () => {
      body.style.overflow = previousBodyOverflow
      body.style.overscrollBehavior = previousBodyOverscroll
      documentElement.style.overflow = previousRootOverflow
      documentElement.style.overscrollBehavior = previousRootOverscroll
    }
  }, [])

  useEffect(() => {
    const pagesChanged = previousPagesRef.current !== pages
    const initialPageChanged = previousInitialPageRef.current !== initialPage
    if (!pagesChanged && !initialPageChanged) {
      return
    }

    previousPagesRef.current = pages
    previousInitialPageRef.current = initialPage

    if (!pages.length) {
      setIndex(0)
      setNsfwRevealed(false)
      preloadedRef.current = new Set()
      return
    }

    const safePage =
      typeof initialPage === 'number' && Number.isFinite(initialPage)
        ? Math.floor(initialPage)
        : 1
    const clampedPage = clamp(safePage, 1, pages.length)
    const logicalIndex = clampedPage - 1

    if (!isSpread) {
      setIndex(logicalIndex)
    } else {
      const adjustedIndex = leftStartSpread ? logicalIndex + 1 : logicalIndex
      setIndex(adjustedIndex - (adjustedIndex % 2))
    }

    setNsfwRevealed(false)
    preloadedRef.current = new Set()
  }, [initialPage, isSpread, leftStartSpread, pages])

  const viewLength = useMemo(() => {
    if (!pages.length) {
      return 0
    }
    return pages.length + (leftStartSpread ? 1 : 0)
  }, [pages.length, leftStartSpread])

  const maxIndex = useMemo(() => {
    if (!pages.length) {
      return 0
    }
    if (!isSpread) {
      return pages.length - 1
    }
    return viewLength % 2 === 0 ? viewLength - 2 : viewLength - 1
  }, [pages.length, isSpread, viewLength])

  useEffect(() => {
    const wasSpread = previousSpreadRef.current
    if (wasSpread === isSpread) {
      return
    }

    previousSpreadRef.current = isSpread

    if (isSpread) {
      setIndex((prev) => {
        const parity = prev % 2
        const spreadIndex = startOnLeft ? prev + parity : prev - parity
        return Math.min(Math.max(spreadIndex, 0), maxIndex)
      })
      return
    }

    setIndex((prev) => {
      const lastIndex = Math.max(0, pages.length - 1)
      const logicalIndex = startOnLeft ? prev - 1 : prev
      return Math.min(Math.max(logicalIndex, 0), lastIndex)
    })
  }, [isSpread, startOnLeft, maxIndex, pages.length])

  const pageStep = isSpread ? 2 : 1

  const toLogicalIndex = useCallback(
    (viewIndex: number) => (leftStartSpread ? viewIndex - 1 : viewIndex),
    [leftStartSpread],
  )

  const getPageAt = useCallback(
    (viewIndex: number) => {
      const logicalIndex = toLogicalIndex(viewIndex)
      if (logicalIndex < 0 || logicalIndex >= pages.length) {
        return null
      }
      return pages[logicalIndex] || null
    },
    [pages, toLogicalIndex],
  )

  const goNext = useCallback(() => {
    setIndex((prev) => Math.min(prev + pageStep, maxIndex))
  }, [maxIndex, pageStep])

  const goPrev = useCallback(() => {
    setIndex((prev) => Math.max(prev - pageStep, 0))
  }, [pageStep])

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'ArrowLeft') {
        event.preventDefault()
        goNext()
      } else if (event.key === 'ArrowRight') {
        event.preventDefault()
        goPrev()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [goNext, goPrev])

  useEffect(() => {
    const schedule =
      typeof window !== 'undefined' && 'requestIdleCallback' in window
        ? (window as Window & {
            requestIdleCallback: (cb: IdleRequestCallback) => number
          }).requestIdleCallback
        : (fn: () => void) => window.setTimeout(fn, 120)

    const cancel =
      typeof window !== 'undefined' && 'cancelIdleCallback' in window
        ? (window as Window & { cancelIdleCallback: (id: number) => void }).cancelIdleCallback
        : (id: number) => window.clearTimeout(id)

    const lookahead = isSpread ? 4 : 2
    const id = schedule(() => {
      for (let offset = 1; offset <= lookahead; offset += 1) {
        const page = getPageAt(index + offset)
        if (page?.type !== 'image') {
          continue
        }
        if (preloadedRef.current.has(page.url)) {
          continue
        }
        const nextImage = new Image()
        nextImage.decoding = 'async'
        nextImage.src = page.url
        preloadedRef.current.add(page.url)
      }
    })

    return () => cancel(id)
  }, [getPageAt, index, isSpread])

  const resetPointer = () => {
    pointerState.current.pointerId = null
    pointerState.current.startX = 0
    pointerState.current.startY = 0
    pointerState.current.currentX = 0
    pointerState.current.isDragging = false
  }

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (!pages.length || event.button !== 0) {
      return
    }
    if (pointerState.current.pointerId !== null) {
      return
    }
    if (isAnimating) {
      return
    }
    pointerState.current.pointerId = event.pointerId
    pointerState.current.startX = event.clientX
    pointerState.current.startY = event.clientY
    pointerState.current.currentX = event.clientX
    pointerState.current.isDragging = false
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!pages.length || isSpread) {
      return
    }
    if (pointerState.current.pointerId !== event.pointerId) {
      return
    }
    const dx = event.clientX - pointerState.current.startX
    const dy = event.clientY - pointerState.current.startY

    if (!pointerState.current.isDragging && Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy)) {
      pointerState.current.isDragging = true
    }

    if (pointerState.current.isDragging) {
      pointerState.current.currentX = event.clientX
      // Only allow swipe in valid directions
      const canGoPrev = index > 0
      const canGoNext = index < pages.length - 1
      if ((dx < 0 && canGoPrev) || (dx > 0 && canGoNext)) {
        setSwipeOffset(dx)
      } else {
        setSwipeOffset(0)
      }
    }
  }

  const handlePointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (!pages.length) {
      return
    }
    if (pointerState.current.pointerId !== event.pointerId) {
      return
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }

    const rect = event.currentTarget.getBoundingClientRect()
    const dx = event.clientX - pointerState.current.startX
    const dy = event.clientY - pointerState.current.startY
    const swipeThreshold = Math.max(32, Math.min(80, rect.width * 0.08))
    const tapThreshold = 12

    if (!isSpread && pointerState.current.isDragging) {
      const containerWidth = containerRef.current?.getBoundingClientRect().width || rect.width
      const threshold = containerWidth * 0.15

      const canGoPrev = index > 0
      const canGoNext = index < pages.length - 1
      const wantsPrev = dx < 0
      const wantsNext = dx > 0

      if (Math.abs(dx) > threshold && ((wantsPrev && canGoPrev) || (wantsNext && canGoNext))) {
        const targetOffset = wantsPrev ? -containerWidth : containerWidth
        setSwipeOffset(targetOffset)
        setIsAnimating(true)

        setTimeout(() => {
          if (wantsPrev) {
            setIndex((prev) => Math.max(prev - 1, 0))
          } else {
            setIndex((prev) => Math.min(prev + 1, pages.length - 1))
          }
          setSwipeOffset(0)
          setIsAnimating(false)
        }, 200)
      } else {
        setSwipeOffset(0)
      }
      resetPointer()
      return
    }

    if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > swipeThreshold) {
      if (dx < 0) {
        goPrev()
      } else {
        goNext()
      }
      resetPointer()
      return
    }

    if (Math.abs(dx) <= tapThreshold && Math.abs(dy) <= tapThreshold) {
      const x = event.clientX - rect.left
      if (!isSpread) {
        const containerWidth = containerRef.current?.getBoundingClientRect().width || rect.width
        if (x < rect.width / 2) {
          if (index < pages.length - 1) {
            setSwipeOffset(containerWidth)
            setIsAnimating(true)
            setTimeout(() => {
              setIndex((prev) => Math.min(prev + 1, pages.length - 1))
              setSwipeOffset(0)
              setIsAnimating(false)
            }, 200)
          }
        } else {
          if (index > 0) {
            setSwipeOffset(-containerWidth)
            setIsAnimating(true)
            setTimeout(() => {
              setIndex((prev) => Math.max(prev - 1, 0))
              setSwipeOffset(0)
              setIsAnimating(false)
            }, 200)
          }
        }
      } else {
        if (x < rect.width / 2) {
          goNext()
        } else {
          goPrev()
        }
      }
    }
    resetPointer()
  }

  const handlePointerCancel = (event: PointerEvent<HTMLDivElement>) => {
    if (pointerState.current.pointerId !== event.pointerId) {
      return
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    setSwipeOffset(0)
    resetPointer()
  }

  const revealAllNsfw = () => {
    setNsfwRevealed(true)
  }

  const current = getPageAt(index)
  const next = isSpread ? getPageAt(index + 1) : null

  const visibleIndices = isSpread ? [index, index + 1] : [index]
  const visibleLabels = visibleIndices
    .map((viewIndex) => {
      const logicalIndex = toLogicalIndex(viewIndex)
      if (logicalIndex < 0 || logicalIndex >= pages.length) {
        return null
      }
      return logicalIndex + 1
    })
    .filter((value): value is number => value !== null)

  const rangeLabel =
    visibleLabels.length > 1 && visibleLabels[0] !== visibleLabels[1]
      ? `${visibleLabels[0]}-${visibleLabels[1]}`
      : `${visibleLabels[0] ?? 0}`

  const renderPage = (
    page: ReaderPage | null,
    viewIndex: number,
    priority = false,
    frame: FrameVariant = 'single',
  ) => {
    if (!page) {
      return <ImageFrame image={null} index={viewIndex} frame={frame} />
    }
    if (page.type === 'author') {
      return <AuthorFrame author={page} frame={frame} />
    }
    const logicalIndex = toLogicalIndex(viewIndex)
    return (
      <ImageFrame
        image={page}
        index={logicalIndex}
        revealed={nsfwRevealed}
        onReveal={revealAllNsfw}
        priority={priority}
        frame={frame}
      />
    )
  }

  return (
    <div className="relative min-h-screen w-full">
      {resolvedBrand ? (
        <a
          href={resolvedBrand.href}
          target={resolvedBrand.target}
          rel={resolvedBrand.rel}
          title={resolvedBrand.title}
          className="absolute bottom-4 right-5 z-20 text-xs uppercase tracking-[0.35em] text-ink/45 transition hover:text-ink/70"
        >
          {resolvedBrand.label}
        </a>
      ) : null}
      <div className="relative z-10 flex h-screen w-screen items-center justify-center p-2 sm:p-6">
        <div
          className="relative h-full w-full max-w-[1500px] select-none animate-soft-in"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerCancel}
          role="presentation"
          style={{ touchAction: 'none' }}
        >
          {isSpread ? (
            <div className="h-full w-full overflow-hidden rounded-2xl border border-ink/10 bg-white/70 shadow-frame">
              <div className="grid h-full w-full grid-cols-2 gap-0">
                {renderPage(next, index + 1, true, 'spread-left')}
                {renderPage(current, index, true, 'spread-right')}
              </div>
            </div>
          ) : (
            <div className="relative h-full w-full overflow-hidden flex items-center justify-center">
              <div
                ref={containerRef}
                className="relative h-full max-h-full overflow-hidden rounded-2xl border border-ink/10 bg-white/70 shadow-frame"
                style={{ aspectRatio: '0.7' }}
              >
                <div
                  className="flex h-full"
                  style={{
                    transform: `translateX(${swipeOffset}px)`,
                    transition: isAnimating ? 'transform 200ms ease-out' : 'none',
                  }}
                >
                  <div className="absolute right-full h-full w-full flex-shrink-0">
                    <div className="flex h-full w-full items-center justify-center">
                      {index < pages.length - 1 && renderPage(pages[index + 1], index + 1, false, 'swipe-left')}
                    </div>
                  </div>
                  <div className="h-full w-full flex-shrink-0">
                    <div className="flex h-full w-full items-center justify-center">
                      {renderPage(current, index, true, 'swipe-right')}
                    </div>
                  </div>
                  <div className="absolute left-full h-full w-full flex-shrink-0">
                    <div className="flex h-full w-full items-center justify-center">
                      {index > 0 && renderPage(pages[index - 1], index - 1, false, 'swipe-left')}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}
          {showPageIndicator ? (
            <div className="pointer-events-none absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-paper/70 px-4 py-1 text-[11px] uppercase tracking-[0.35em] text-ink/70 shadow-md backdrop-blur">
              {rangeLabel} / {pages.length}
            </div>
          ) : null}
          <div className="pointer-events-none absolute inset-y-0 left-0 w-1/5 bg-gradient-to-r from-ink/5 via-transparent to-transparent" />
          <div className="pointer-events-none absolute inset-y-0 right-0 w-1/5 bg-gradient-to-l from-ink/5 via-transparent to-transparent" />
        </div>
      </div>
    </div>
  )
}
