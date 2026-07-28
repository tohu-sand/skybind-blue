import type { ReactNode } from 'react'

type StatusScreenProps = {
  title: ReactNode
  subtitle?: string
  children?: ReactNode
  className?: string
  showBrand?: boolean
  align?: 'center' | 'left'
}

export default function StatusScreen({
  title,
  subtitle,
  children,
  className,
  showBrand = true,
  align = 'center',
}: StatusScreenProps) {
  const alignClass = align === 'left' ? 'text-left' : 'text-center'
  return (
    <div className="flex min-h-screen items-center justify-center px-6 py-12">
      <div
        className={`w-full max-w-md animate-soft-in rounded-3xl border border-ink/10 bg-white/70 p-8 ${alignClass} shadow-frame backdrop-blur-sm ${
          className ?? ''
        }`}
      >
        {showBrand ? (
          <div className="text-[11px] uppercase tracking-[0.4em] text-ink/50">
            SkyBind
          </div>
        ) : null}
        <div className={showBrand ? 'mt-4' : ''}>{title}</div>
        {subtitle ? (
          <p className="mt-3 text-sm leading-relaxed text-ink/70">{subtitle}</p>
        ) : null}
        {children}
      </div>
    </div>
  )
}
