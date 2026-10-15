import {
  useCallback,
  useEffect,
  useLayoutEffect,
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
  const previousViewRef = useRef<{
    pages: ReaderPage[]
    initialPage: number | undefined
    isSpread: boolean
    startOnLeft: boolean
  } | null>(null)
  const animationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const gestureRef = useRef<HTMLDivElement>(null)
  const [swipeOffset, setSwipeOffset] = useState(0)
  const [isAnimating, setIsAnimating] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const resolvedBrand = brand === undefined ? { label: 'SkyBind', href: '/' } : brand
  const pointerState = useRef({
    pointerId: null as number | null,
    startX: 0,
    startY: 0,
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

  const resetPointer = useCallback(() => {
    const pointerId = pointerState.current.pointerId
    pointerState.current = {
      pointerId: null,
      startX: 0,
      startY: 0,
      isDragging: false,
    }
    const target = gestureRef.current
    if (pointerId !== null && target?.hasPointerCapture(pointerId)) {
      target.releasePointerCapture(pointerId)
    }
  }, [])

  const cancelInteraction = useCallback(() => {
    if (animationTimerRef.current !== null) {
      clearTimeout(animationTimerRef.current)
      animationTimerRef.current = null
    }
    resetPointer()
    setSwipeOffset(0)
    setIsAnimating(false)
  }, [resetPointer])

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

  useLayoutEffect(() => {
    const previous = previousViewRef.current
    const resetPage = !previous || previous.pages !== pages || previous.initialPage !== initialPage
    previousViewRef.current = { pages, initialPage, isSpread, startOnLeft }
    cancelInteraction()

    setIndex((prev) => {
      let logicalIndex: number
      if (resetPage) {
        const safePage = typeof initialPage === 'number' && Number.isFinite(initialPage)
          ? Math.floor(initialPage)
          : 1
        logicalIndex = clamp(safePage - 1, 0, Math.max(0, pages.length - 1))
      } else {
        // Remove the previous layout's leading blank page before reindexing.
        logicalIndex = Math.max(0, prev - (previous.isSpread && previous.startOnLeft ? 1 : 0))
      }
      const viewIndex = logicalIndex + (leftStartSpread ? 1 : 0)
      return clamp(isSpread ? viewIndex - (viewIndex % 2) : logicalIndex, 0, maxIndex)
    })

    if (resetPage) {
      setNsfwRevealed(false)
      preloadedRef.current = new Set()
    }

    return cancelInteraction
  }, [pages, initialPage, isSpread, startOnLeft, leftStartSpread, maxIndex, cancelInteraction])

  useEffect(() => {
    // Resizing changes swipe distances even when the layout mode stays the same.
    window.addEventListener('resize', cancelInteraction)
    return () => window.removeEventListener('resize', cancelInteraction)
  }, [cancelInteraction])

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

  const navigate = useCallback((direction: -1 | 1, animate = false) => {
    // Refs block overlapping events before React commits state updates.
    if (animationTimerRef.current !== null || pointerState.current.pointerId !== null) {
      return
    }
    const targetIndex = clamp(index + direction * pageStep, 0, maxIndex)
    if (targetIndex === index) {
      setSwipeOffset(0)
      return
    }
    const width = containerRef.current?.getBoundingClientRect().width
    if (animate && !isSpread && width) {
      setSwipeOffset(direction * width)
      setIsAnimating(true)
      animationTimerRef.current = setTimeout(() => {
        animationTimerRef.current = null
        setIndex(targetIndex)
        setSwipeOffset(0)
        setIsAnimating(false)
      }, 200)
    } else {
      setIndex((prev) => clamp(prev + direction * pageStep, 0, maxIndex))
    }
  }, [index, isSpread, maxIndex, pageStep])

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey ||
        (event.target instanceof HTMLElement &&
          (event.target.isContentEditable || event.target.closest('input, textarea, select')))) {
        return
      }
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault()
        navigate(event.key === 'ArrowLeft' ? 1 : -1)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [navigate])

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

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (!pages.length || event.button !== 0) {
      return
    }
    if (pointerState.current.pointerId !== null) {
      return
    }
    if (animationTimerRef.current !== null) {
      return
    }
    pointerState.current.pointerId = event.pointerId
    pointerState.current.startX = event.clientX
    pointerState.current.startY = event.clientY
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
    const rect = event.currentTarget.getBoundingClientRect()
    const dx = event.clientX - pointerState.current.startX
    const dy = event.clientY - pointerState.current.startY
    const swipeThreshold = Math.max(32, Math.min(80, rect.width * 0.08))
    const tapThreshold = 12

    const wasDragging = pointerState.current.isDragging
    resetPointer()

    if (!isSpread && wasDragging) {
      const containerWidth = containerRef.current?.getBoundingClientRect().width || rect.width
      if (Math.abs(dx) > containerWidth * 0.15) {
        navigate(dx > 0 ? 1 : -1, true)
      } else {
        setSwipeOffset(0)
      }
      return
    }

    if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > swipeThreshold) {
      navigate(dx > 0 ? 1 : -1, true)
      return
    }

    if (Math.abs(dx) <= tapThreshold && Math.abs(dy) <= tapThreshold) {
      const x = event.clientX - rect.left
      navigate(x < rect.width / 2 ? 1 : -1, true)
    }
  }

  const handlePointerCancel = (event: PointerEvent<HTMLDivElement>) => {
    if (pointerState.current.pointerId === event.pointerId) {
      cancelInteraction()
    }
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
          ref={gestureRef}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerCancel}
          onLostPointerCapture={handlePointerCancel}
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
