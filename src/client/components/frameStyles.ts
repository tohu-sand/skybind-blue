import type { FrameVariant } from './frameTypes'

const isSpreadFrame = (frame?: FrameVariant) =>
  frame === 'spread-left' || frame === 'spread-right'

const isSwipeFrame = (frame?: FrameVariant) =>
  frame === 'swipe-left' || frame === 'swipe-right'

export const getFrameStyles = (frame?: FrameVariant) => {
  const spreadFrame = isSpreadFrame(frame)
  const swipeFrame = isSwipeFrame(frame)
  return {
    frameClass: spreadFrame || swipeFrame
      ? 'rounded-none border-0 shadow-none'
      : 'rounded-2xl border border-ink/10 shadow-frame',
    backgroundClass: spreadFrame || swipeFrame ? 'bg-transparent' : 'bg-white/70',
    placeholderClass: spreadFrame || swipeFrame ? 'bg-transparent' : 'bg-white/50',
  }
}

export const getObjectPositionClass = (frame?: FrameVariant) => {
  if (frame === 'spread-left' || frame === 'swipe-left') {
    return 'object-right'
  }
  if (frame === 'spread-right' || frame === 'swipe-right') {
    return 'object-left'
  }
  return ''
}
