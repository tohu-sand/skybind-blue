import { Link } from 'react-router-dom'
import StatusScreen from '../components/StatusScreen'

const CONTACT_URL = 'https://forms.gle/6HF3vh6zowttYerc8'
const LAST_UPDATED = '2026-08-03'

export default function PrivacyPolicy() {
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
          <h1 className="mt-3 text-2xl font-semibold text-ink">
            プライバシーポリシー
          </h1>
          <div className="mt-2 text-xs uppercase tracking-[0.3em] text-ink/50">
            最終更新: {LAST_UPDATED}
          </div>
        </div>
      }
    >
      <div className="mt-6 space-y-6 text-sm leading-relaxed text-ink/70">
        <p>
          SkyBind（以下「本サービス」）は、Blueskyに投稿された漫画を閲覧するために必要な情報のみを取り扱います。
        </p>

        <section>
          <h2 className="text-sm font-semibold text-ink">1. 収集する情報</h2>
          <div className="mt-3 space-y-4">
            <div>
              <div className="text-xs uppercase tracking-[0.3em] text-ink/50">
                サーバーに保存する情報
              </div>
              <ul className="mt-2 list-disc space-y-2 pl-5">
                <li>Blueskyアカウント識別子（DID）</li>
                <li>1ページ目のポストURLから解決した元ポストURI</li>
                <li>開始ページの左右</li>
                <li>生成されたリンクID、作成日時</li>
              </ul>
              <p className="mt-2 text-xs text-ink/60">
                画像ファイル本体、画像URL一覧、投稿本文はサーバーに保存しません。
              </p>
            </div>
            <div>
              <div className="text-xs uppercase tracking-[0.3em] text-ink/50">
                表示のために取得する情報
              </div>
              <ul className="mt-2 list-disc space-y-2 pl-5">
                <li>Bluesky APIから取得する投稿の画像URL</li>
                <li>作者の表示名/ハンドル/アイコン画像</li>
              </ul>
              <p className="mt-2 text-xs text-ink/60">
                これらは表示のために取得するもので、配信高速化のための一時的なキャッシュ（最大60秒程度）を除き、サーバーには保存しません。
              </p>
            </div>
            <div>
              <div className="text-xs uppercase tracking-[0.3em] text-ink/50">
                アップローダー利用時の処理
              </div>
              <p className="mt-2 text-sm text-ink/60">
                画像と本文はブラウザからBlueskyへ直接送信され、サーバーには保存されません。
              </p>
            </div>
            <div>
              <div className="text-xs uppercase tracking-[0.3em] text-ink/50">
                アクセスログ
              </div>
              <p className="mt-2 text-sm text-ink/60">
                サービスの提供・保守のため、IPアドレスやブラウザ情報等のアクセスログがホスティング事業者（Cloudflare）により処理されることがあります。当方がこれらを個人の特定に利用することはありません。
              </p>
            </div>
            <div>
              <div className="text-xs uppercase tracking-[0.3em] text-ink/50">
                ブラウザ内に保存される情報
              </div>
              <ul className="mt-2 list-disc space-y-2 pl-5">
                <li>OAuthセッション情報（アクセストークン等）</li>
              </ul>
              <p className="mt-2 text-xs text-ink/60">
                サーバーには送信されず、ブラウザ内にのみ保存されます。
              </p>
            </div>
          </div>
        </section>

        <section>
          <h2 className="text-sm font-semibold text-ink">2. 利用目的</h2>
          <ul className="mt-2 list-disc space-y-2 pl-5">
            <li>ビューワー用URLの生成と表示</li>
            <li>アップローダー機能による投稿支援</li>
            <li>投稿者本人であることの確認</li>
            <li>不正利用防止や利用制限の運用</li>
          </ul>
        </section>

        <section>
          <h2 className="text-sm font-semibold text-ink">3. 第三者提供・外部サービス</h2>
          <ul className="mt-2 list-disc space-y-2 pl-5">
            <li>投稿情報の取得のためにBluesky APIを利用します。</li>
            <li>ホスティングおよびデータベースはCloudflare Pages / D1を利用します。</li>
            <li>お問い合わせフォームはGoogle Formsを利用します。</li>
          </ul>
        </section>

        <section>
          <h2 className="text-sm font-semibold text-ink">4. 保存期間</h2>
          <p className="mt-2">
            生成されたリンクを提供するために必要な期間、データを保存します。削除を希望する場合はお問い合わせからご連絡ください。
          </p>
        </section>

        <section>
          <h2 className="text-sm font-semibold text-ink">5. お問い合わせ</h2>
          <p className="mt-2">
            ご質問や削除依頼は
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
          to="/terms"
          className="underline decoration-ink/30 underline-offset-4"
        >
          利用規約
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
