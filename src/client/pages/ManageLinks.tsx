import { Agent } from '@atproto/api'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import {
  COMIC_COLLECTION,
  parsePostUri,
  type StrongRef,
} from '../../shared/comicRecord'
import StatusScreen from '../components/StatusScreen'
import { useBskyAuth } from '../hooks/useBskyAuth'
import { toBskyPostUrl } from '../utils/mangaReader'
import {
  completeLink,
  getServiceAuthHeader,
  putComicRecord,
  withRetry,
} from '../utils/skybindApi'

type StartSide = 'right' | 'left'

type ManagedLink = {
  id: string
  title?: string
  startSide: StartSide
  originalPostUri: string
  recordCid?: string
  state: 'active' | 'pending'
  createdAt?: number
  viewerUrl: string
}

type GenerateApiResponse = {
  id: string
  viewerUrl: string
  rootUri?: string
  rootCid?: string | null
  posts?: StrongRef[]
  pageCount?: number
  sensitiveSelfLabels?: string[]
  error?: string
}

type Feedback = {
  id: string
  kind: 'error' | 'notice'
  text: string
}

type RecordCheckStatus = 'checking' | 'exists' | 'none' | 'unknown'

const MAX_TITLE_LENGTH = 100

const PUBLIC_API =
  (import.meta.env.VITE_BSKY_PUBLIC_API as string | undefined) ??
  'https://public.api.bsky.app'
// app.bsky.feed.getPosts accepts at most 25 URIs per call.
const GET_POSTS_BATCH = 25

type EmbedImageView = { thumb?: string; thumbnail?: string; fullsize?: string }
type EmbedView = {
  $type?: string
  images?: EmbedImageView[]
  items?: EmbedImageView[]
  media?: EmbedView
}

const firstImageFromEmbed = (embed: EmbedView | undefined): string | null => {
  if (!embed || typeof embed.$type !== 'string') {
    return null
  }
  const list = embed.$type.includes('app.bsky.embed.images')
    ? embed.images
    : embed.$type.includes('app.bsky.embed.gallery')
      ? embed.items
      : null
  if (Array.isArray(list) && list.length) {
    const first = list[0]
    return first.thumb || first.thumbnail || first.fullsize || null
  }
  return embed.media ? firstImageFromEmbed(embed.media) : null
}

const toMessage = (err: unknown, fallback: string) =>
  err instanceof Error && err.message ? err.message : fallback

const formatDate = (seconds?: number) => {
  if (!seconds) {
    return ''
  }
  return new Date(seconds * 1000).toLocaleDateString('ja-JP', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

export default function ManageLinks() {
  const { session, profile, status, error, signIn, signOut } = useBskyAuth()
  const navigate = useNavigate()
  const [links, setLinks] = useState<ManagedLink[] | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [busyLabel, setBusyLabel] = useState<string | null>(null)
  const [feedback, setFeedback] = useState<Feedback | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const [editStartSide, setEditStartSide] = useState<StartSide>('right')
  const [confirmingId, setConfirmingId] = useState<string | null>(null)
  const [recordCheck, setRecordCheck] = useState<{
    id: string
    status: RecordCheckStatus
  } | null>(null)
  // Allow link-only deletion when the PDS record cannot be deleted.
  const [recordDeleteFailedId, setRecordDeleteFailedId] = useState<string | null>(null)
  const [recordDeleteConfirming, setRecordDeleteConfirming] = useState(false)

  const rawHandle = profile?.handle?.toLowerCase()
  const handleLabel = rawHandle
    ? rawHandle.startsWith('@')
      ? rawHandle
      : `@${rawHandle}`
    : '@unknown'

  const fetchLinks = useCallback(async () => {
    if (!session) {
      return
    }
    setListError(null)
    try {
      const agent = new Agent(session)
      const authHeader = await getServiceAuthHeader(agent)
      const response = await fetch('/api/manage/links', {
        headers: { Authorization: authHeader },
      })
      const data = (await response.json().catch(() => null)) as
        | { links?: ManagedLink[]; error?: string }
        | null
      if (!response.ok || !data?.links) {
        throw new Error(data?.error || 'リンク一覧の取得に失敗しました。')
      }
      setLinks(data.links)
    } catch (err) {
      setListError(toMessage(err, 'リンク一覧の取得に失敗しました。'))
    }
  }, [session])

  useEffect(() => {
    if (session) {
      fetchLinks()
    }
  }, [session, fetchLinks])

  const [thumbs, setThumbs] = useState<Record<string, string>>({})
  // Remember misses so unavailable posts do not trigger repeated requests.
  const attemptedThumbs = useRef<Set<string>>(new Set())

  useEffect(() => {
    const wanted = (links ?? [])
      .map((link) => link.originalPostUri)
      .filter(
        (uri) => uri.startsWith('at://') && !attemptedThumbs.current.has(uri),
      )
    if (!wanted.length) {
      return
    }
    wanted.forEach((uri) => attemptedThumbs.current.add(uri))
    let alive = true
    const run = async () => {
      const found: Record<string, string> = {}
      for (let i = 0; i < wanted.length; i += GET_POSTS_BATCH) {
        const chunk = wanted.slice(i, i + GET_POSTS_BATCH)
        const params = chunk
          .map((uri) => `uris=${encodeURIComponent(uri)}`)
          .join('&')
        try {
          const response = await fetch(
            `${PUBLIC_API}/xrpc/app.bsky.feed.getPosts?${params}`,
            { headers: { Accept: 'application/json' } },
          )
          if (!response.ok) {
            continue
          }
          const data = (await response.json()) as {
            posts?: { uri: string; embed?: EmbedView }[]
          }
          for (const post of data.posts ?? []) {
            const image = firstImageFromEmbed(post.embed)
            if (image) {
              found[post.uri] = image
            }
          }
        } catch {
          // Thumbnail failures must not prevent link management.
        }
      }
      if (alive && Object.keys(found).length) {
        setThumbs((prev) => ({ ...prev, ...found }))
      }
    }
    run()
    return () => {
      alive = false
    }
  }, [links])

  const openEdit = (link: ManagedLink) => {
    setEditingId(link.id)
    setEditTitle(link.title ?? '')
    setEditStartSide(link.startSide)
    setConfirmingId(null)
    setFeedback(null)
    setRecordDeleteConfirming(false)
  }

  const closePanels = () => {
    setEditingId(null)
    setConfirmingId(null)
    setRecordCheck(null)
    setRecordDeleteFailedId(null)
    setRecordDeleteConfirming(false)
  }

  const openConfirm = (link: ManagedLink) => {
    setConfirmingId(link.id)
    setEditingId(null)
    setFeedback(null)
    setRecordDeleteFailedId(null)
    const rkey = parsePostUri(link.originalPostUri)?.rkey
    if (!session || !rkey) {
      setRecordCheck({ id: link.id, status: 'none' })
      return
    }
    // Check the PDS before confirming deletion; D1's record CID may be stale.
    setRecordCheck({ id: link.id, status: 'checking' })
    const agent = new Agent(session)
    agent.com.atproto.repo
      .getRecord({ repo: session.did, collection: COMIC_COLLECTION, rkey })
      .then(() => {
        setRecordCheck((prev) =>
          prev?.id === link.id ? { id: link.id, status: 'exists' } : prev,
        )
      })
      .catch((err: unknown) => {
        const code = (err as { error?: string }).error
        const message = err instanceof Error ? err.message : ''
        const notFound =
          code === 'RecordNotFound' || /could not locate record/i.test(message)
        setRecordCheck((prev) =>
          prev?.id === link.id
            ? { id: link.id, status: notFound ? 'none' : 'unknown' }
            : prev,
        )
      })
  }

  const saveRecord = async (link: ManagedLink) => {
    if (!session) {
      return
    }
    setBusyId(link.id)
    setFeedback(null)
    try {
      const agent = new Agent(session)
      const trimmedTitle = editTitle.trim()

      setBusyLabel('スレッドを確認中...')
      const authHeader = await getServiceAuthHeader(agent)
      const response = await fetch('/api/manga/generate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: authHeader,
        },
        body: JSON.stringify({
          postUrl: link.originalPostUri,
          title: trimmedTitle || undefined,
          startSide: editStartSide,
        }),
      })
      const data = (await response.json().catch(() => null)) as
        | GenerateApiResponse
        | null
      if (!response.ok || !data) {
        throw new Error(data?.error || 'スレッドの確認に失敗しました。')
      }
      if (data.id !== link.id || !data.rootUri || !data.rootCid) {
        throw new Error('リンクとスレッドの対応が確認できませんでした。')
      }

      // Preserve fields that the form does not manage.
      let language: string | undefined
      let createdAt: string | undefined
      const rkey = parsePostUri(data.rootUri)?.rkey
      if (rkey) {
        try {
          const existing = await agent.com.atproto.repo.getRecord({
            repo: session.did,
            collection: COMIC_COLLECTION,
            rkey,
          })
          const value = existing.data.value as {
            language?: unknown
            createdAt?: unknown
          }
          if (typeof value.language === 'string') {
            language = value.language
          }
          if (typeof value.createdAt === 'string') {
            createdAt = value.createdAt
          }
        } catch {
          // Missing or unreadable records use the defaults for a new record.
        }
      }

      setBusyLabel('レコードを書き込み中...')
      const record = await withRetry(() =>
        putComicRecord(agent, session.did, {
          subject: { uri: data.rootUri as string, cid: data.rootCid as string },
          url: data.viewerUrl,
          posts: data.posts,
          title: trimmedTitle || undefined,
          startSide: editStartSide,
          language,
          labelValues: data.sensitiveSelfLabels,
          pageCount: data.pageCount,
          createdAt,
        }),
      )

      setBusyLabel('レコードを検証中...')
      // D1 metadata is updated only after the server verifies the public record.
      await completeLink({
        id: link.id,
        recordUri: record.uri,
        recordCid: record.cid,
      })

      setLinks((prev) =>
        prev
          ? prev.map((item) =>
              item.id === link.id
                ? {
                    ...item,
                    title: trimmedTitle || undefined,
                    startSide: editStartSide,
                    recordCid: record.cid,
                  }
                : item,
            )
          : prev,
      )
      setEditingId(null)
      setFeedback({ id: link.id, kind: 'notice', text: 'レコードを保存しました。' })
    } catch (err) {
      setFeedback({
        id: link.id,
        kind: 'error',
        text: toMessage(err, 'レコードの保存に失敗しました。'),
      })
    } finally {
      setBusyId(null)
      setBusyLabel(null)
    }
  }

  // Delete from the PDS before clearing D1 so failures remain visible and retryable.
  // Both operations compare CIDs to preserve concurrent edits.
  const deleteRecordOnly = async (link: ManagedLink) => {
    if (!session || !link.recordCid) {
      return
    }
    const rkey = parsePostUri(link.originalPostUri)?.rkey
    if (!rkey) {
      setFeedback({
        id: link.id,
        kind: 'error',
        text: 'レコードの位置を特定できませんでした。',
      })
      return
    }
    setBusyId(link.id)
    setFeedback(null)
    try {
      const agent = new Agent(session)
      setBusyLabel('レコードを削除中...')
      try {
        await agent.com.atproto.repo.deleteRecord({
          repo: session.did,
          collection: COMIC_COLLECTION,
          rkey,
          swapRecord: link.recordCid,
        })
      } catch (err) {
        const code = (err as { error?: string }).error
        if (code === 'InvalidSwap') {
          throw new Error(
            'レコードが別の場所で更新されています。ページを再読み込みして、もう一度お試しください。',
          )
        }
        throw err
      }
      const authHeader = await getServiceAuthHeader(agent)
      const response = await fetch(
        `/api/manage/links/${encodeURIComponent(link.id)}/record?expectedCid=${encodeURIComponent(link.recordCid)}`,
        {
          method: 'DELETE',
          headers: { Authorization: authHeader },
        },
      )
      const data = (await response.json().catch(() => null)) as
        | { ok?: boolean; error?: string }
        | null
      if (!response.ok || !data?.ok) {
        throw new Error(data?.error || 'レコード情報の更新に失敗しました。')
      }

      setLinks((prev) =>
        prev
          ? prev.map((item) =>
              item.id === link.id ? { ...item, recordCid: undefined } : item,
            )
          : prev,
      )
      closePanels()
      setFeedback({
        id: link.id,
        kind: 'notice',
        text: 'レコードを削除しました。リンクはそのまま利用できます。',
      })
    } catch (err) {
      setFeedback({
        id: link.id,
        kind: 'error',
        text: toMessage(err, 'レコードの削除に失敗しました。'),
      })
    } finally {
      setBusyId(null)
      setBusyLabel(null)
    }
  }

  const deleteLink = async (link: ManagedLink, options?: { skipRecord?: boolean }) => {
    if (!session) {
      return
    }
    setBusyId(link.id)
    setFeedback(null)
    try {
      const agent = new Agent(session)

      // Delete the record first to avoid leaving it pointing at a deleted link.
      if (!options?.skipRecord) {
        const rkey = parsePostUri(link.originalPostUri)?.rkey
        if (rkey) {
          setBusyLabel('レコードを削除中...')
          try {
            await agent.com.atproto.repo.deleteRecord({
              repo: session.did,
              collection: COMIC_COLLECTION,
              rkey,
            })
          } catch (err) {
            console.error('comic record delete failed', err)
            setRecordDeleteFailedId(link.id)
            setFeedback({
              id: link.id,
              kind: 'error',
              text: 'Blueskyアカウント上のレコード削除に失敗しました。再試行するか、「リンクのみ削除」を選んでください。',
            })
            return
          }
        }
      }

      setBusyLabel('リンクを削除中...')
      const authHeader = await getServiceAuthHeader(agent)
      const response = await fetch(
        `/api/manage/links/${encodeURIComponent(link.id)}`,
        {
          method: 'DELETE',
          headers: { Authorization: authHeader },
        },
      )
      const data = (await response.json().catch(() => null)) as
        | { ok?: boolean; error?: string }
        | null
      if (!response.ok || !data?.ok) {
        throw new Error(data?.error || 'リンクの削除に失敗しました。')
      }

      setLinks((prev) => (prev ? prev.filter((item) => item.id !== link.id) : prev))
      setConfirmingId(null)
      setRecordDeleteFailedId(null)
      setFeedback(null)
    } catch (err) {
      setFeedback({
        id: link.id,
        kind: 'error',
        text: toMessage(err, 'リンクの削除に失敗しました。'),
      })
    } finally {
      setBusyId(null)
      setBusyLabel(null)
    }
  }

  if (status === 'loading') {
    return (
      <StatusScreen title="Checking login" subtitle="Bluesky認証を確認しています。">
        <div className="mt-6 flex items-center justify-center gap-2">
          <span className="h-2 w-2 rounded-full bg-accent animate-breath" />
          <span
            className="h-2 w-2 rounded-full bg-accent/70 animate-breath"
            style={{ animationDelay: '180ms' }}
          />
          <span
            className="h-2 w-2 rounded-full bg-accent/40 animate-breath"
            style={{ animationDelay: '360ms' }}
          />
        </div>
      </StatusScreen>
    )
  }

  if (status === 'error') {
    return (
      <StatusScreen title="Login error" subtitle={error || '認証に失敗しました。'}>
        <button
          type="button"
          onClick={() => navigate('/')}
          className="mt-6 rounded-full bg-ink px-6 py-2 text-xs font-semibold uppercase tracking-[0.3em] text-paper"
        >
          戻る
        </button>
      </StatusScreen>
    )
  }

  if (!session) {
    return (
      <StatusScreen
        title="リンク管理"
        subtitle="作成したリンクの管理には、Blueskyでのログインが必要です。"
      >
        <button
          type="button"
          onClick={() => signIn({ returnTo: '/manage' })}
          className="mt-6 rounded-full bg-ink px-6 py-3 text-xs font-semibold uppercase tracking-[0.3em] text-paper shadow transition hover:bg-ink/90"
        >
          Blueskyでログイン
        </button>
        <div className="mt-4 text-xs text-ink/60">
          <Link
            to="/"
            className="underline decoration-ink/30 underline-offset-4 transition hover:text-ink hover:decoration-ink/60"
          >
            トップに戻る
          </Link>
        </div>
      </StatusScreen>
    )
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-6 py-12">
      <div className="w-full max-w-xl animate-soft-in rounded-3xl border border-ink/10 bg-white/70 p-8 shadow-frame backdrop-blur-sm">
        <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.4em] text-ink/50">
          <span>SKYBIND</span>
          <span className="rounded-full bg-ink/10 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[0.3em] text-ink/60">
            Manager
          </span>
        </div>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-[11px] text-ink/50">
          <span className="tracking-[0.2em]">{handleLabel}</span>
          <button
            type="button"
            onClick={async () => {
              await signOut()
              navigate('/')
            }}
            disabled={busyId !== null}
            className="rounded-full border border-ink/10 bg-paper/70 px-4 py-2 text-[10px] font-semibold uppercase tracking-[0.3em] text-ink/70 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Logout
          </button>
        </div>

        <div className="mt-6">
          <h1 className="text-2xl font-semibold text-ink">リンク管理</h1>
          <p className="mt-2 text-sm text-ink/60">
            作成したリーダー用リンクの一覧です。リンクの削除と、Blueskyアカウント上のレコード
            (blue.skybind.comic) の作成・編集ができます。
          </p>
        </div>

        {listError ? (
          <div
            role="alert"
            className="mt-4 rounded-2xl border border-accent/30 bg-accent/10 px-4 py-3 text-sm text-accent"
          >
            {listError}
            <button
              type="button"
              onClick={fetchLinks}
              className="ml-3 underline decoration-accent/40 underline-offset-4"
            >
              再読み込み
            </button>
          </div>
        ) : null}

        {links === null && !listError ? (
          <div className="mt-6 text-sm text-ink/50">読み込み中...</div>
        ) : null}

        {links !== null && links.length === 0 ? (
          <div className="mt-6 rounded-2xl border border-ink/10 bg-paper/70 px-4 py-4 text-sm text-ink/60">
            作成済みのリンクはありません。
          </div>
        ) : null}

        {links?.length ? (
          <div className="mt-6 space-y-4">
            {links.map((link) => {
              const busy = busyId === link.id
              const anyBusy = busyId !== null
              const isPending = link.state === 'pending'
              const postUrl = toBskyPostUrl(link.originalPostUri, session.did)
              const editing = editingId === link.id
              const confirming = confirmingId === link.id
              const check: RecordCheckStatus =
                recordCheck?.id === link.id ? recordCheck.status : 'unknown'
              return (
                <div
                  key={link.id}
                  className="rounded-2xl border border-ink/10 bg-paper/70 px-4 py-4"
                >
                  <div className="flex flex-wrap items-center gap-2">
                  {link.title ? (
                    <span className="text-sm font-semibold text-ink/85">
                      {link.title}
                    </span>
                  ) : (
                    <span className="text-sm text-ink/45">タイトル未設定</span>
                  )}
                  {isPending ? (
                    <span className="rounded-full border border-accent/30 bg-accent/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.2em] text-accent/80">
                      未完了
                    </span>
                  ) : (
                    <span
                      className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.2em] ${
                        link.recordCid
                          ? 'bg-ink/10 text-ink/60'
                          : 'border border-ink/15 text-ink/45'
                      }`}
                    >
                      {link.recordCid ? 'レコードあり' : 'レコードなし'}
                    </span>
                  )}
                  {link.createdAt ? (
                    <span className="ml-auto text-[11px] text-ink/45">
                      {formatDate(link.createdAt)}
                    </span>
                  ) : null}
                  </div>

                  {thumbs[link.originalPostUri] ? (
                    <div className="mt-3 h-32 w-24 overflow-hidden rounded-lg border border-ink/10 bg-ink/5">
                      <img
                        src={thumbs[link.originalPostUri]}
                        alt=""
                        loading="lazy"
                        className="h-full w-full object-cover"
                      />
                    </div>
                  ) : null}

                  <div className="mt-2">
                    <div className="text-[9px] font-semibold uppercase tracking-[0.3em] text-ink/40">
                      リーダー用リンク
                    </div>
                    <p className="break-all text-xs text-ink/55">{link.viewerUrl}</p>
                  </div>

                <div className="mt-3 flex flex-wrap gap-2">
                    {!isPending ? (
                      <a
                        href={link.viewerUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="rounded-full border border-ink/10 bg-white/70 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.25em] text-ink/70"
                      >
                        リーダーを開く
                      </a>
                    ) : null}
                    {!isPending && postUrl ? (
                      <a
                        href={postUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="rounded-full border border-ink/10 bg-white/70 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.25em] text-ink/70"
                      >
                        ポストを開く
                      </a>
                    ) : null}
                    {!isPending ? (
                      <button
                        type="button"
                        disabled={anyBusy}
                        onClick={() => (editing ? closePanels() : openEdit(link))}
                        className="rounded-full border border-ink/10 bg-white/70 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.25em] text-ink/70 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {link.recordCid ? 'レコードを編集' : 'レコードを作成'}
                      </button>
                    ) : null}
                    <button
                      type="button"
                      disabled={anyBusy}
                      onClick={() => (confirming ? closePanels() : openConfirm(link))}
                      className="rounded-full border border-accent/30 bg-white/70 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.25em] text-accent/80 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      リンクを削除
                    </button>
                  </div>

                  {isPending ? (
                    <div className="mt-2 text-[11px] text-ink/45">
                      作成が完了しなかったリンクです。削除できます。
                    </div>
                  ) : null}

                  {editing ? (
                    <div className="mt-4 rounded-2xl border border-ink/10 bg-white/70 px-4 py-4">
                      <div className="text-xs font-semibold uppercase tracking-[0.3em] text-ink/50">
                        {link.recordCid ? 'レコードの編集' : 'レコードの作成'}
                      </div>
                      <div className="mt-3 text-sm font-semibold text-ink/80">
                        作品タイトル（任意）
                      </div>
                      <input
                        type="text"
                        value={editTitle}
                        maxLength={MAX_TITLE_LENGTH}
                        disabled={busy}
                        onChange={(event) => setEditTitle(event.target.value)}
                        placeholder="未入力でも保存できます"
                        className="mt-2 w-full rounded-2xl border border-ink/10 bg-paper/80 px-4 py-3 text-sm shadow-sm focus:border-ink/40 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
                      />
                      <div className="mt-3 text-sm font-semibold text-ink/80">
                        1ページ目の位置
                      </div>
                      <div className="mt-2 flex gap-2">
                        {([
                          ['left', '左ページから'],
                          ['right', '右ページから'],
                        ] as const).map(([side, label]) => (
                          <button
                            key={side}
                            type="button"
                            disabled={busy}
                            onClick={() => setEditStartSide(side)}
                            className={`rounded-full px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.25em] transition disabled:cursor-not-allowed disabled:opacity-50 ${
                              editStartSide === side
                                ? 'bg-ink text-paper'
                                : 'border border-ink/10 bg-paper/70 text-ink/70'
                            }`}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                      <div className="mt-3 text-[11px] leading-relaxed text-ink/50">
                        {link.recordCid
                          ? '保存すると、Blueskyアカウント上のレコードを書き換えます。1ページ目の位置はリーダーの表示にも反映されます。'
                          : '保存すると、この作品のレコード (blue.skybind.comic) をBlueskyアカウントに作成します。1ページ目の位置はリーダーの表示にも反映されます。'}
                      </div>
                      <div className="mt-3 flex gap-2">
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => saveRecord(link)}
                          className="rounded-full bg-ink px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.25em] text-paper disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          {busy
                            ? busyLabel || '保存中...'
                            : link.recordCid
                              ? '保存'
                              : 'レコードを作成'}
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={closePanels}
                          className="rounded-full border border-ink/10 bg-paper/70 px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.25em] text-ink/70 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          キャンセル
                        </button>
                      </div>

                      {link.recordCid ? (
                        <div className="mt-4 border-t border-ink/10 pt-3">
                          {recordDeleteConfirming ? (
                            <div>
                              <div className="text-xs leading-relaxed text-ink/70">
                                レコードを削除しますか？リンクとリーダーはそのまま利用できます。
                              </div>
                              <div className="mt-2 flex gap-2">
                                <button
                                  type="button"
                                  disabled={busy}
                                  onClick={() => deleteRecordOnly(link)}
                                  className="rounded-full bg-accent px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.25em] text-paper disabled:cursor-not-allowed disabled:opacity-60"
                                >
                                  {busy ? busyLabel || '削除中...' : '削除する'}
                                </button>
                                <button
                                  type="button"
                                  disabled={busy}
                                  onClick={() => setRecordDeleteConfirming(false)}
                                  className="rounded-full border border-ink/10 bg-paper/70 px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.25em] text-ink/70 disabled:cursor-not-allowed disabled:opacity-50"
                                >
                                  やめる
                                </button>
                              </div>
                            </div>
                          ) : (
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => setRecordDeleteConfirming(true)}
                              className="text-[11px] font-semibold uppercase tracking-[0.25em] text-accent/70 underline-offset-4 transition hover:underline disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              レコードを削除
                            </button>
                          )}
                        </div>
                      ) : null}
                    </div>
                  ) : null}

                  {confirming ? (
                    <div className="mt-4 rounded-2xl border border-accent/30 bg-accent/5 px-4 py-4">
                      <div className="text-sm font-semibold text-ink/80">
                        このリンクを削除しますか？
                      </div>
                      <ul className="mt-2 space-y-1 text-xs leading-relaxed text-ink/60">
                        <li>・リーダー用リンクは使えなくなります</li>
                        {check === 'checking' ? (
                          <li>・Blueskyアカウント上のレコードの有無を確認しています...</li>
                        ) : check === 'exists' ? (
                          <li>・Blueskyアカウント上のレコードも削除されます</li>
                        ) : check === 'none' ? (
                          <li>・レコードはないため、削除されるのはリンクのみです</li>
                        ) : (
                          <li>
                            ・レコードの有無を確認できませんでした（存在する場合は一緒に削除されます）
                          </li>
                        )}
                        <li>・Blueskyのポストと画像はそのまま残ります</li>
                      </ul>
                      <div className="mt-3 flex flex-wrap gap-2">
                        <button
                          type="button"
                          disabled={busy || check === 'checking'}
                          onClick={() => deleteLink(link)}
                          className="rounded-full bg-accent px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.25em] text-paper disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          {busy
                            ? busyLabel || '削除中...'
                            : check === 'checking'
                              ? '確認中...'
                              : '削除する'}
                        </button>
                        {recordDeleteFailedId === link.id ? (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => deleteLink(link, { skipRecord: true })}
                            className="rounded-full border border-accent/40 bg-white/70 px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.25em] text-accent/80 disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            リンクのみ削除
                          </button>
                        ) : null}
                        <button
                          type="button"
                          disabled={busy}
                          onClick={closePanels}
                          className="rounded-full border border-ink/10 bg-paper/70 px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.25em] text-ink/70 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          キャンセル
                        </button>
                      </div>
                    </div>
                  ) : null}

                  {feedback?.id === link.id ? (
                    <div
                      role={feedback.kind === 'error' ? 'alert' : 'status'}
                      className={`mt-3 rounded-2xl px-4 py-3 text-xs ${
                        feedback.kind === 'error'
                          ? 'border border-accent/30 bg-accent/10 text-accent'
                          : 'border border-ink/10 bg-white/70 text-ink/70'
                      }`}
                    >
                      {feedback.text}
                    </div>
                  ) : null}
                </div>
              )
            })}
          </div>
        ) : null}
      </div>
    </div>
  )
}
