import { useEffect } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import ManageGearLink from '../components/ManageGearLink'
import StatusScreen from '../components/StatusScreen'
import { useBskyAuth } from '../hooks/useBskyAuth'

const CONTACT_URL = 'https://forms.gle/6HF3vh6zowttYerc8'
const REPOSITORY_URL = 'https://github.com/tohu-sand/skybind-blue'

export default function Home() {
  const { status, error, postLoginPath, signIn } = useBskyAuth()
  const navigate = useNavigate()

  useEffect(() => {
    if (status === 'authenticated') {
      // postLoginPath carries logins that started elsewhere (e.g. /manage)
      // back to where they began after the OAuth round trip.
      navigate(postLoginPath ?? '/create')
    }
  }, [navigate, status, postLoginPath])

  return (
    <StatusScreen
      showBrand={false}
      title={
        <div className="text-center">
          <div className="text-4xl font-semibold tracking-[0.18em] text-ink">
            SKYBIND
          </div>
          <div className="mt-2 text-[11px] uppercase tracking-[0.4em] text-ink/50">
            bluesky comic reader
          </div>
        </div>
      }
    >
      <div className="mt-4 text-sm leading-relaxed text-ink/70">
        <p>Blueskyに投稿された漫画を見開きで読むためのサービスです。</p>
        <p className="mt-3">リーダー用リンクの作成は投稿者本人のみが行えます。</p>
      </div>
      <div className="mt-4 rounded-2xl border border-ink/10 bg-paper/70 px-4 py-3 text-xs text-ink/60">
        ※本サービスはポストを並べて表示するものであり、画像の保存や再アップロードは行っておりません。
      </div>
      {error ? (
        <div className="mt-4 rounded-2xl border border-accent/30 bg-accent/10 px-4 py-3 text-sm text-accent">
          {error}
        </div>
      ) : null}
      <button
        type="button"
        onClick={() => signIn()}
        disabled={status === 'loading'}
        className="mt-6 rounded-full bg-ink px-6 py-3 text-xs font-semibold uppercase tracking-[0.3em] text-paper shadow transition hover:bg-ink/90 disabled:cursor-not-allowed disabled:opacity-70"
      >
        {status === 'loading' ? 'Connecting...' : 'Blueskyでログイン'}
      </button>
      <div className="mt-4 flex flex-col items-center gap-2 text-xs text-ink/60">
        <div className="flex items-center gap-3">
          <a
            href="https://bsky.app/profile/tohu-sand.com"
            className="decoration-ink/30 underline-offset-4 transition hover:text-ink"
            target="_blank"
            rel="noreferrer"
          >
            @tohu-sand.com
          </a>
          <a
            href={REPOSITORY_URL}
            aria-label="GitHub リポジトリ"
            title="GitHub"
            className="text-ink/40 transition hover:text-ink/70"
            target="_blank"
            rel="noreferrer"
          >
            <svg
              viewBox="0 0 16 16"
              className="h-4 w-4 fill-current"
              aria-hidden="true"
            >
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.012 8.012 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
            </svg>
          </a>
          <ManageGearLink />
        </div>
        <div className="flex items-center gap-2">
          <a
            href={CONTACT_URL}
            className="underline decoration-ink/30 underline-offset-4 transition hover:text-ink hover:decoration-ink/60"
            target="_blank"
            rel="noreferrer"
          >
            お問い合わせ
          </a>
          <span className="text-ink/30">/</span>
          <Link
            to="/terms"
            className="underline decoration-ink/30 underline-offset-4 transition hover:text-ink hover:decoration-ink/60"
          >
            利用規約
          </Link>
          <span className="text-ink/30">/</span>
          <Link
            to="/privacy"
            className="underline decoration-ink/30 underline-offset-4 transition hover:text-ink hover:decoration-ink/60"
          >
            プライバシーポリシー
          </Link>
          <span className="text-ink/30">/</span>
          <a
            href="/THIRD_PARTY_NOTICES.txt"
            className="underline decoration-ink/30 underline-offset-4 transition hover:text-ink hover:decoration-ink/60"
            target="_blank"
            rel="noreferrer"
          >
            Licenses
          </a>
        </div>
      </div>
    </StatusScreen>
  )
}
