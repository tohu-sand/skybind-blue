import { Component, type ReactNode } from 'react'

const RELOAD_GUARD_KEY = 'skybind:chunk-reload-at'
const RELOAD_GUARD_MS = 30_000

// Stale deployments make hashed chunk URLs 404, so lazy imports reject with
// browser-specific messages (Chrome / Firefox / Safari).
const isChunkLoadError = (error: unknown) =>
  error instanceof Error &&
  /dynamically imported module|Importing a module script failed|Unable to preload CSS|Loading chunk/i.test(
    error.message,
  )

const shouldAutoReload = () => {
  try {
    const last = Number(sessionStorage.getItem(RELOAD_GUARD_KEY) ?? 0)
    if (Date.now() - last < RELOAD_GUARD_MS) {
      return false
    }
    sessionStorage.setItem(RELOAD_GUARD_KEY, String(Date.now()))
    return true
  } catch {
    return false
  }
}

type AppErrorBoundaryProps = {
  children: ReactNode
}

type AppErrorBoundaryState = {
  hasError: boolean
}

export default class AppErrorBoundary extends Component<
  AppErrorBoundaryProps,
  AppErrorBoundaryState
> {
  state: AppErrorBoundaryState = { hasError: false }

  static getDerivedStateFromError(): AppErrorBoundaryState {
    return { hasError: true }
  }

  componentDidCatch(error: unknown) {
    console.error('render error', error)
    if (isChunkLoadError(error) && shouldAutoReload()) {
      window.location.reload()
    }
  }

  render() {
    if (!this.state.hasError) {
      return this.props.children
    }
    return (
      <div className="flex min-h-screen items-center justify-center px-6 py-12">
        <div className="w-full max-w-md rounded-3xl border border-ink/10 bg-white/70 p-8 text-center shadow-frame backdrop-blur-sm">
          <div className="text-[11px] uppercase tracking-[0.4em] text-ink/50">
            SkyBind
          </div>
          <p className="mt-4 text-sm leading-relaxed text-ink/70">
            ページの表示に失敗しました。再読み込みしてください。
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="mt-6 w-full rounded-2xl bg-ink px-6 py-3 text-xs font-semibold uppercase tracking-[0.3em] text-paper shadow transition hover:bg-ink/90"
          >
            再読み込み
          </button>
        </div>
      </div>
    )
  }
}
