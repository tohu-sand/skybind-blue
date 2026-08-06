import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import StatusScreen from '../components/StatusScreen'

const CONTACT_URL = 'https://forms.gle/6HF3vh6zowttYerc8'
const LAST_UPDATED = '2026-08-06'

const linkClass =
  'underline decoration-ink/30 underline-offset-4 transition hover:text-ink hover:decoration-ink/60'

// Every section is a heading + one bullet list (one item = one fact), so the
// whole document reads in a single consistent rhythm.
const Section = ({ title, children }: { title: string; children: ReactNode }) => (
  <section>
    <h2 className="text-sm font-semibold text-ink">{title}</h2>
    <ul className="mt-2 list-disc space-y-2 pl-5">{children}</ul>
  </section>
)

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

        <Section title="1. サーバーに保存する情報">
          <li>Blueskyアカウント識別子（DID）</li>
          <li>元ポストURI（1ページ目のポストURLから解決したもの）</li>
          <li>開始ページの左右</li>
          <li>作品タイトル（入力した場合のみ）</li>
          <li>リンクID・作成日時・リンクの状態</li>
          <li>公開レコード（後述）の識別子（CID）</li>
          <li>
            リンク操作時の認証トークンの使用済み識別子（トークンの再利用防止のためのみに使用し、期限経過後に削除）
          </li>
        </Section>

        <Section title="2. 利用者のBlueskyアカウントに記録される情報">
          <li>
            リンク作成時に、リンク情報（元ポストURL・リーダーURL・作品タイトル（入力した場合のみ）・開始ページの左右等）が、公開レコード（blue.skybind.comic）として利用者自身のBlueskyアカウントに記録されます
          </li>
          <li>
            このレコードはAT
            Protocol上の公開データであり、本サービス以外のアプリやサービスからも参照できます
          </li>
        </Section>

        <Section title="3. ブラウザ内にのみ保存される情報">
          <li>OAuthセッション情報（アクセストークン等）</li>
        </Section>

        <Section title="4. 保存せず、表示・処理のためにのみ扱う情報">
          <li>
            投稿の画像URL・作者の表示名/ハンドル/アイコン（表示のために都度取得。配信高速化のための一時キャッシュ（最大60秒程度）を除き保存しません）
          </li>
          <li>
            アップロードする画像と本文（ブラウザからBlueskyへ直接送信され、サーバーを経由しません）
          </li>
          <li>
            アクセスログ（IPアドレス・ブラウザ情報等。ホスティング事業者（Cloudflare）が処理します。）
          </li>
        </Section>

        <Section title="5. 利用目的">
          <li>リーダー用URLの生成と表示</li>
          <li>アップローダー機能による投稿支援</li>
          <li>作成したリンク・レコードの管理機能の提供</li>
          <li>投稿者本人であることの確認</li>
          <li>不正利用防止や利用制限の運用</li>
        </Section>

        <Section title="6. 第三者提供・外部サービス">
          <li>投稿情報の取得: Bluesky API</li>
          <li>ホスティングおよびデータベース: Cloudflare Pages / D1</li>
          <li>お問い合わせフォーム: Google Forms</li>
        </Section>

        <Section title="7. 保存期間と削除">
          <li>生成されたリンクを提供するために必要な期間、データを保存します</li>
          <li>
            作成したリンクとレコードは、リンク管理ページから利用者自身で削除できます
          </li>
          <li>作成が完了しなかったリンクの情報は、一定期間の経過後に削除されることがあります</li>
        </Section>
      </div>

      <div className="mt-8 flex items-center gap-2 text-xs text-ink/60">
        <Link to="/" className={linkClass}>
          トップに戻る
        </Link>
        <span className="text-ink/30">/</span>
        <Link to="/terms" className={linkClass}>
          利用規約
        </Link>
        <span className="text-ink/30">/</span>
        <a href={CONTACT_URL} className={linkClass} target="_blank" rel="noreferrer">
          お問い合わせ
        </a>
      </div>
    </StatusScreen>
  )
}
