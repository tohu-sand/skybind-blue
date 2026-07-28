import useMediaQuery from '../hooks/useMediaQuery'
import { getFrameStyles } from './frameStyles'
import type { FrameVariant } from './frameTypes'

export type AuthorPage = {
  type: 'author'
  name: string
  handle?: string
  avatar?: string
  url?: string
  firstPostUrl?: string
}

type AuthorFrameProps = {
  author: AuthorPage
  frame?: FrameVariant
}

export default function AuthorFrame({ author, frame = 'single' }: AuthorFrameProps) {
  const name = author?.name || 'Unknown author'
  const rawHandle = author?.handle || ''
  const handle = rawHandle ? (rawHandle.startsWith('@') ? rawHandle : `@${rawHandle}`) : ''
  const avatar = author?.avatar || ''
  const url = author?.url || ''
  const firstPostUrl = author?.firstPostUrl || ''
  const { frameClass, backgroundClass } = getFrameStyles(frame)
  const compactLandscape = useMediaQuery('(orientation: landscape) and (max-height: 520px)')
  const containerClass = compactLandscape
    ? 'flex h-full w-full flex-col items-center justify-center gap-4 px-5'
    : 'flex h-full w-full flex-col items-center justify-center gap-7 px-8 text-center'
  const layoutClass = compactLandscape
    ? 'flex w-full max-w-[520px] items-center justify-center gap-5'
    : 'flex w-full flex-col items-center gap-7'
  const infoClass = compactLandscape
    ? 'flex flex-col items-start gap-3 text-left'
    : 'flex flex-col items-center gap-5 text-center'
  const avatarClass = compactLandscape ? 'h-24 w-24' : 'h-36 w-36'
  const nameClass = compactLandscape ? 'text-xl' : 'text-3xl'
  const handleClass = compactLandscape ? 'mt-1 text-sm' : 'mt-3 text-lg'
  const buttonGroupClass = compactLandscape
    ? 'flex flex-wrap items-center justify-start gap-2'
    : 'flex flex-wrap items-center justify-center gap-3'
  const primaryButtonClass = compactLandscape
    ? 'rounded-full border border-ink/10 bg-ink px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.2em] text-paper shadow-sm transition hover:bg-ink/90'
    : 'rounded-full border border-ink/10 bg-ink px-6 py-3 text-xs font-semibold uppercase tracking-[0.3em] text-paper shadow-sm transition hover:bg-ink/90'
  const secondaryButtonClass = compactLandscape
    ? 'rounded-full border border-ink/10 bg-paper/80 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.2em] text-accent2 shadow-sm transition hover:bg-white'
    : 'rounded-full border border-ink/10 bg-paper/80 px-5 py-3 text-xs font-semibold uppercase tracking-[0.3em] text-accent2 shadow-sm transition hover:bg-white'

  return (
    <div
      className={`relative h-full w-full overflow-hidden ${backgroundClass} backdrop-blur-sm ${frameClass}`}
    >
      <div className={containerClass}>
        {!compactLandscape ? (
          <div className="text-xs uppercase tracking-[0.35em] text-ink/50">
            Author
          </div>
        ) : null}
        <div className={layoutClass}>
          {avatar ? (
            <img
              src={avatar}
              alt={name}
              className={`${avatarClass} rounded-full border border-ink/10 object-cover shadow-md`}
              draggable={false}
            />
          ) : (
            <div
              className={`flex ${avatarClass} items-center justify-center rounded-full border border-ink/10 bg-ink/5 text-2xl font-semibold text-ink/60`}
            >
              {name.slice(0, 2).toUpperCase()}
            </div>
          )}
          <div className={infoClass}>
            {compactLandscape ? (
              <div className="text-[10px] uppercase tracking-[0.3em] text-ink/50">
                Author
              </div>
            ) : null}
            <div>
              <div className={`font-semibold text-ink ${nameClass}`}>{name}</div>
              {handle ? (
                <div className={`text-ink/60 ${handleClass}`}>{handle}</div>
              ) : null}
            </div>
            <div className={buttonGroupClass}>
              {firstPostUrl ? (
                <a
                  href={firstPostUrl}
                  target="_blank"
                  rel="noreferrer"
                  onPointerDown={(event) => event.stopPropagation()}
                  onPointerUp={(event) => event.stopPropagation()}
                  className={primaryButtonClass}
                >
                  Blueskyでいいねする
                </a>
              ) : null}
              {url ? (
                <a
                  href={url}
                  target="_blank"
                  rel="noreferrer"
                  onPointerDown={(event) => event.stopPropagation()}
                  onPointerUp={(event) => event.stopPropagation()}
                  className={secondaryButtonClass}
                >
                  Blueskyプロフィール
                </a>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
