import { useEffect } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import StatusScreen from '../components/StatusScreen'
import { useBskyAuth } from '../hooks/useBskyAuth'

const CONTACT_URL = 'https://forms.gle/6HF3vh6zowttYerc8'

export default function Home() {
  const { status, error, signIn } = useBskyAuth()
  const navigate = useNavigate()

  useEffect(() => {
    if (status === 'authenticated') {
      navigate('/create')
    }
  }, [navigate, status])

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
        <p className="mt-3">ビューワー用リンクの作成は投稿者本人のみが行えます。</p>
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
        onClick={signIn}
        disabled={status === 'loading'}
        className="mt-6 rounded-full bg-ink px-6 py-3 text-xs font-semibold uppercase tracking-[0.3em] text-paper shadow transition hover:bg-ink/90 disabled:cursor-not-allowed disabled:opacity-70"
      >
        {status === 'loading' ? 'Connecting...' : 'Blueskyでログイン'}
      </button>
      <div className="mt-4 flex flex-col items-center gap-2 text-xs text-ink/60">
        <div className="flex items-center gap-2">
          <a
            href="https://bsky.app/profile/tohu-sand.com"
            className="decoration-ink/30 underline-offset-4"
            target="_blank"
            rel="noreferrer"
          >
            @tohu-sand.com
          </a>
        </div>
        <div className="flex items-center gap-2">
          <a
            href={CONTACT_URL}
            className="underline decoration-ink/30 underline-offset-4"
            target="_blank"
            rel="noreferrer"
          >
            お問い合わせ
          </a>
          <span className="text-ink/30">/</span>
          <Link
            to="/terms"
            className="underline decoration-ink/30 underline-offset-4"
          >
            利用規約
          </Link>
          <span className="text-ink/30">/</span>
          <Link
            to="/privacy"
            className="underline decoration-ink/30 underline-offset-4"
          >
            プライバシーポリシー
          </Link>
          <span className="text-ink/30">/</span>
          <a
            href="/THIRD_PARTY_NOTICES.txt"
            className="underline decoration-ink/30 underline-offset-4"
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
