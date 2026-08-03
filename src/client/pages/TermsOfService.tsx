import { Link } from 'react-router-dom'
import StatusScreen from '../components/StatusScreen'

const CONTACT_URL = 'https://forms.gle/6HF3vh6zowttYerc8'
const LAST_UPDATED = '2026-08-03'

export default function TermsOfService() {
  return (
    <StatusScreen
      showBrand={false}
      align="left"
      className="max-w-2xl"
      title={
        <div>
          <div className="text-[11px] uppercase tracking-[0.4em] text-ink/50">
            SKYBIND
          </div>
          <h1 className="mt-3 text-2xl font-semibold text-ink">利用規約</h1>
          <div className="mt-2 text-xs uppercase tracking-[0.3em] text-ink/50">
            最終更新: {LAST_UPDATED}
          </div>
        </div>
      }
    >
      <div className="mt-6 space-y-6 text-sm leading-relaxed text-ink/70">
        <p>
          SkyBind（以下「本サービス」）の利用条件を定めます。本サービスの利用により本規約に同意したものとみなします。
        </p>

        <section>
          <h2 className="text-sm font-semibold text-ink">1. 提供内容</h2>
          <ul className="mt-2 list-disc space-y-2 pl-5">
            <li>投稿者本人によるビューワー用リンクの生成</li>
            <li>Bluesky投稿の見開き表示</li>
            <li>ブラウザからBlueskyへの投稿支援</li>
          </ul>
          <p className="mt-2 text-xs text-ink/60">
            画像は保存せず、投稿はブラウザからBlueskyへ直接送信されます。
          </p>
        </section>

        <section>
          <h2 className="text-sm font-semibold text-ink">2. 利用条件</h2>
          <ul className="mt-2 list-disc space-y-2 pl-5">
            <li>投稿内容の権利を有すること、または正当な許諾があること</li>
            <li>Blueskyの利用規約・ポリシーに従うこと</li>
          </ul>
          <p className="mt-2">
            当方は、不正利用の防止のため、必要に応じて利用制限を行うことがあります。
          </p>
        </section>

        <section>
          <h2 className="text-sm font-semibold text-ink">3. 禁止事項</h2>
          <ul className="mt-2 list-disc space-y-2 pl-5">
            <li>第三者の権利侵害、法令違反となる行為</li>
            <li>不正アクセスや過度な負荷を与える行為</li>
            <li>本サービスの運営を妨げる行為</li>
          </ul>
        </section>

        <section>
          <h2 className="text-sm font-semibold text-ink">4. 免責</h2>
          <p className="mt-2">
            本サービスは現状有姿で提供され、可用性・正確性・継続性を保証しません。Bluesky側の障害や仕様変更等により利用できない場合でも、当方は責任を負いません。
          </p>
        </section>

        <section>
          <h2 className="text-sm font-semibold text-ink">5. 変更・停止</h2>
          <p className="mt-2">
            本サービスの内容および本規約は必要に応じて変更・停止することがあります。重要な変更はサイト上で告知します。
          </p>
        </section>

        <section>
          <h2 className="text-sm font-semibold text-ink">6. 準拠法・管轄</h2>
          <p className="mt-2">
            本規約は日本法に準拠します。本サービスに関して紛争が生じた場合は、運営者の住所地を管轄する裁判所を専属的合意管轄裁判所とします。
          </p>
        </section>

        <section>
          <h2 className="text-sm font-semibold text-ink">7. お問い合わせ</h2>
          <p className="mt-2">
            ご質問は
            <a
              href={CONTACT_URL}
              className="mx-1 underline decoration-ink/30 underline-offset-4"
              target="_blank"
              rel="noreferrer"
            >
              お問い合わせフォーム
            </a>
            からご連絡ください。
          </p>
        </section>
      </div>

      <div className="mt-8 flex items-center gap-2 text-xs text-ink/60">
        <Link to="/" className="underline decoration-ink/30 underline-offset-4">
          トップに戻る
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
          href={CONTACT_URL}
          className="underline decoration-ink/30 underline-offset-4"
          target="_blank"
          rel="noreferrer"
        >
          お問い合わせ
        </a>
      </div>
    </StatusScreen>
  )
}
