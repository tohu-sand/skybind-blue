import { Agent, RichText } from '@atproto/api'
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
} from 'react'
import { useNavigate } from 'react-router-dom'
import type { StrongRef } from '../../shared/comicRecord'
import ManageGearLink from '../components/ManageGearLink'
import StatusScreen from '../components/StatusScreen'
import { useBskyAuth } from '../hooks/useBskyAuth'
import useWakeLock from '../hooks/useWakeLock'
import { compressForBluesky } from '../utils/blueskyImage'
import { toBskyPostUrl } from '../utils/mangaReader'
import {
  RETRY_LIMIT,
  completeLink,
  getErrorStatus,
  getServiceAuthHeader,
  putComicRecord,
  withRetry,
} from '../utils/skybindApi'

type GenerateResponse = {
  id: string
  viewerUrl: string
  pending?: boolean
}

type GenerateApiResponse = GenerateResponse & {
  rootUri?: string
  rootCid?: string | null
  posts?: StrongRef[]
  pageCount?: number
  sensitiveSelfLabels?: string[]
  reused?: boolean
}

type UploadResult = GenerateResponse & {
  postUrl?: string
}

type StartSide = 'right' | 'left'
type ContentRating = 'all' | 'r18'
type PostSplit = 'cover' | 'flat'

type PreviewItem = {
  file: File
  url: string
}

type CompressionLog = {
  name: string
  originalWidth: number
  originalHeight: number
  outputWidth: number
  outputHeight: number
  originalBytes: number
  outputBytes: number
  mime: string
  strategy: string
  quality: number
}

type TimingEntry = {
  label: string
  ms: number
  count: number
}

// Match the 10-character link ID so the preview's grapheme count is accurate.
const PREVIEW_VIEWER_URL = 'https://skybind.blue/v/xxxxxxxxxx'
const MAX_UPLOAD_FILES = 500
// Gallery authoring uses a soft limit of 10; the schema permits 20.
const IMAGES_PER_POST = 10
// The images embed supports at most 4 images.
const GALLERY_MIN_IMAGES = 5
// `via` is an unofficial attribution field supported by some Bluesky clients.
const POST_VIA = 'SkyBind'
const PREVIEW_PAIR_COLORS = [
  '#e07a5f',
  '#81b29a',
  '#3d405b',
  '#e96ba8',
  '#42b5e3',
]

const fileKey = (file: File) =>
  `${file.webkitRelativePath || file.name}:${file.size}:${file.lastModified}`

const formatBytes = (bytes: number) => {
  if (bytes < 1024) {
    return `${bytes}B`
  }
  const kb = bytes / 1024
  if (kb < 1024) {
    return `${kb.toFixed(1)}KB`
  }
  return `${(kb / 1024).toFixed(2)}MB`
}

const toEmbedUrl = (viewerUrl: string) => {
  try {
    const url = new URL(viewerUrl)
    url.pathname = url.pathname.replace('/v/', '/embed/')
    return url.toString()
  } catch {
    return viewerUrl.replace('/v/', '/embed/')
  }
}

const buildEmbedCode = (embedUrl: string) => `<iframe
  src="${embedUrl}"
  title="SkyBind reader"
  loading="lazy"
  style="width: 100%; height: 70vh; min-height: 420px; border: 0;"
  allowfullscreen
></iframe>`

const getErrorCode = (err: unknown) => {
  if (!err || typeof err !== 'object') {
    return null
  }
  const code = (err as { error?: string }).error
  if (typeof code === 'string' && code) {
    return code
  }
  const dataCode = (err as { data?: { error?: string } }).data?.error
  return typeof dataCode === 'string' && dataCode ? dataCode : null
}

const formatUploadError = (err: unknown) => {
  const status = getErrorStatus(err)
  const code = getErrorCode(err)
  if (status === 401 || status === 403) {
    return '認証が切れています。ログインし直してください。'
  }
  if (code === 'BlobTooLarge') {
    return '画像サイズが大きすぎます。圧縮をオンにして再投稿してください。'
  }
  if (status === 429) {
    return '投稿が混み合っています。少し時間をおいて再度お試しください。'
  }
  if (status && status >= 500) {
    return 'Bluesky側で一時的なエラーが発生しています。時間をおいて再試行してください。'
  }
  const fallback = err instanceof Error ? err.message : '投稿に失敗しました。'
  return status && status >= 400 ? `[${status}] ${fallback}` : fallback
}

const extractOrderNumber = (filename: string) => {
  const match =
    filename.match(/_(\d+)(?=\.[^.]+$)/) ??
    filename.match(/(\d+)(?=\.[^.]+$)/)
  if (!match) {
    return -1
  }
  const value = Number.parseInt(match[1], 10)
  return Number.isNaN(value) ? -1 : value
}

const sortComicFiles = (files: File[]) =>
  [...files].sort((a, b) => {
    const aIndex = extractOrderNumber(a.name)
    const bIndex = extractOrderNumber(b.name)
    if (aIndex === bIndex) {
      return a.name.localeCompare(b.name)
    }
    return aIndex - bIndex
  })

const chunkForPosts = <T,>(items: T[], split: PostSplit): T[][] => {
  if (!items.length) {
    return []
  }
  const chunks: T[][] = []
  let start = 0
  if (split === 'cover') {
    chunks.push(items.slice(0, 1))
    start = 1
  }
  for (let i = start; i < items.length; i += IMAGES_PER_POST) {
    chunks.push(items.slice(i, i + IMAGES_PER_POST))
  }
  return chunks
}

const getPairIndex = (pageIndex: number, startSide: StartSide) => {
  if (startSide === 'left') {
    return pageIndex === 0 ? 0 : Math.floor((pageIndex - 1) / 2) + 1
  }
  return Math.floor(pageIndex / 2)
}

const isAllowedImage = (file: File) => {
  const type = file.type.toLowerCase()
  if (type === 'image/png' || type === 'image/jpeg' || type === 'image/webp') {
    return true
  }
  const name = file.name.toLowerCase()
  return (
    name.endsWith('.png') ||
    name.endsWith('.jpg') ||
    name.endsWith('.jpeg') ||
    name.endsWith('.webp')
  )
}

const getEntryFromItem = (item: DataTransferItem) => {
  const entryGetter = (
    item as DataTransferItem & {
      webkitGetAsEntry?: () => FileSystemEntry | null
    }
  ).webkitGetAsEntry
  return entryGetter ? entryGetter.call(item) : null
}

const readEntries = (reader: FileSystemDirectoryReader) =>
  new Promise<FileSystemEntry[]>((resolve, reject) => {
    reader.readEntries(resolve, reject)
  })

const readAllEntries = async (reader: FileSystemDirectoryReader) => {
  const entries: FileSystemEntry[] = []
  while (true) {
    const batch = await readEntries(reader)
    if (!batch.length) {
      break
    }
    entries.push(...batch)
  }
  return entries
}

const collectEntryFiles = async (entry: FileSystemEntry): Promise<File[]> => {
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) => {
      ;(entry as FileSystemFileEntry).file(resolve, reject)
    })
    return [file]
  }
  if (entry.isDirectory) {
    const reader = (entry as FileSystemDirectoryEntry).createReader()
    const entries = await readAllEntries(reader)
    const nested = await Promise.all(entries.map((child) => collectEntryFiles(child)))
    return nested.flat()
  }
  return []
}

const getFilesFromDataTransfer = async (dataTransfer: DataTransfer) => {
  const items = Array.from(dataTransfer.items ?? []).filter(
    (item) => item.kind === 'file',
  )
  const entries = items
    .map((item) => getEntryFromItem(item))
    .filter((entry): entry is FileSystemEntry => Boolean(entry))

  if (!entries.length) {
    return Array.from(dataTransfer.files ?? [])
  }

  const grouped = await Promise.all(entries.map((entry) => collectEntryFiles(entry)))
  return grouped.flat()
}

const MAX_TITLE_LENGTH = 100
const RECORD_FAILURE_NOTICE =
  'リンクは作成されましたが、Blueskyアカウントへのレコード記録に失敗しました。リンク自体は利用できます。'
const RECORD_VERIFY_NOTICE =
  'リンクは作成されましたが、レコードの検証が完了していません。リンク自体は利用できます。'

const buildPostText = ({
  body,
  viewerUrl,
  index,
  total,
}: {
  body: string
  viewerUrl: string
  index: number
  total: number
}) => {
  const lines: string[] = []
  const trimmed = body.trim()
  if (index === 0 && trimmed) {
    lines.push(trimmed)
  }
  if (index === 0) {
    lines.push(viewerUrl)
  }
  lines.push(`(${index + 1}/${total})`)
  return lines.join('\n')
}

const TitleInput = ({
  value,
  onChange,
  disabled = false,
}: {
  value: string
  onChange: (value: string) => void
  disabled?: boolean
}) => (
  <div>
    <div className="text-sm font-semibold text-ink/80">作品タイトル（任意）</div>
    <input
      type="text"
      value={value}
      maxLength={MAX_TITLE_LENGTH}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
      placeholder="未入力でも作成できます"
      className="mt-2 w-full rounded-2xl border border-ink/10 bg-paper/80 px-4 py-3 text-sm shadow-sm focus:border-ink/40 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
    />
  </div>
)

const StartSidePicker = ({
  value,
  onChange,
  disabled = false,
}: {
  value: StartSide
  onChange: (value: StartSide) => void
  disabled?: boolean
}) => (
  <div>
    <div className="text-sm font-semibold text-ink/80">1ページ目の位置</div>
    <div className="mt-2 flex gap-2">
      {([
        ['left', '左ページから'],
        ['right', '右ページから'],
      ] as const).map(([side, label]) => (
        <button
          key={side}
          type="button"
          disabled={disabled}
          onClick={() => onChange(side)}
          className={`rounded-full px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.25em] transition disabled:cursor-not-allowed disabled:opacity-50 ${
            value === side
              ? 'bg-ink text-paper'
              : 'border border-ink/10 bg-paper/70 text-ink/70'
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  </div>
)

const PostSplitPicker = ({
  value,
  onChange,
  disabled = false,
}: {
  value: PostSplit
  onChange: (value: PostSplit) => void
  disabled?: boolean
}) => {
  const [helpOpen, setHelpOpen] = useState(false)
  return (
    <div>
      <div className="flex items-center gap-2">
        <div className="text-sm font-semibold text-ink/80">先頭ポストの画像</div>
        <button
          type="button"
          onClick={() => setHelpOpen((prev) => !prev)}
          aria-label="先頭ポストの画像についての説明"
          aria-expanded={helpOpen}
          className="flex h-4 w-4 items-center justify-center rounded-full border border-ink/30 text-[10px] font-semibold lowercase text-ink/50 transition hover:border-ink/60 hover:text-ink/80"
        >
          i
        </button>
      </div>
      {helpOpen ? (
        <div className="mt-2 rounded-xl border border-ink/10 bg-paper/70 px-3 py-2 text-[11px] leading-relaxed text-ink/60">
          「1枚にする」は先頭ポストを表紙のように画像1枚だけにして、2ポスト目から10枚ずつ投稿します。
          「複数枚にする」は先頭から10枚ずつ投稿します。
          5枚以上が入ったポストはBlueskyでカルーセル表示になります。
        </div>
      ) : null}
      <div className="mt-2 flex gap-2">
        {([
          ['cover', '1枚にする'],
          ['flat', '複数枚にする'],
        ] as const).map(([split, label]) => (
          <button
            key={split}
            type="button"
            disabled={disabled}
            onClick={() => onChange(split)}
            className={`rounded-full px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.25em] transition disabled:cursor-not-allowed disabled:opacity-50 ${
              value === split
                ? 'bg-ink text-paper'
                : 'border border-ink/10 bg-paper/70 text-ink/70'
            }`}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  )
}

const ContentRatingPicker = ({
  value,
  onChange,
  disabled = false,
}: {
  value: ContentRating
  onChange: (value: ContentRating) => void
  disabled?: boolean
}) => (
  <div>
    <div className="text-sm font-semibold text-ink/80">内容区分</div>
    <div className="mt-2 flex gap-2">
      {([
        ['all', '全年齢'],
        ['r18', '成人向け'],
      ] as const).map(([rating, label]) => (
        <button
          key={rating}
          type="button"
          disabled={disabled}
          onClick={() => onChange(rating)}
          className={`rounded-full px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.25em] transition disabled:cursor-not-allowed disabled:opacity-50 ${
            value === rating
              ? 'bg-ink text-paper'
              : 'border border-ink/10 bg-paper/70 text-ink/70'
          }`}
        >
          {label}
        </button>
      ))}
    </div>
    <div className="mt-2 text-[11px] text-ink/50">
      R-18はBlueskyの成人向けラベル(porn)を付けて投稿します。
    </div>
  </div>
)

export default function CreateLink() {
  const { session, profile, status, error, signOut } = useBskyAuth()
  const navigate = useNavigate()
  const [mode, setMode] = useState<'link' | 'upload'>('link')
  const [postUrl, setPostUrl] = useState('')
  const [comicTitle, setComicTitle] = useState('')
  const [linkNotice, setLinkNotice] = useState<string | null>(null)
  const [startSide, setStartSide] = useState<StartSide>('right')
  const [contentRating, setContentRating] = useState<ContentRating>('all')
  const [postSplit, setPostSplit] = useState<PostSplit>('cover')
  const [linkResult, setLinkResult] = useState<GenerateResponse | null>(null)
  const [linkLoading, setLinkLoading] = useState(false)
  const [linkError, setLinkError] = useState<string | null>(null)
  const [uploadFiles, setUploadFiles] = useState<File[]>([])
  const [uploadText, setUploadText] = useState('')
  const [previewItems, setPreviewItems] = useState<PreviewItem[]>([])
  const previewItemsRef = useRef<PreviewItem[]>([])
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const uploadTextRef = useRef<HTMLTextAreaElement | null>(null)
  const debugClickRef = useRef<{ count: number; lastAt: number }>({
    count: 0,
    lastAt: 0,
  })
  const [debugMode, setDebugMode] = useState(false)
  const [debugSkipCompression, setDebugSkipCompression] = useState(false)
  const [compressionLogs, setCompressionLogs] = useState<CompressionLog[]>([])
  const [debugUploadMs, setDebugUploadMs] = useState<number | null>(null)
  const [debugTimings, setDebugTimings] = useState<TimingEntry[]>([])
  const uploadTimerRef = useRef<number | null>(null)
  const copyTimerRef = useRef<number | null>(null)
  const [copyFeedback, setCopyFeedback] = useState<{ key: string; ok: boolean } | null>(
    null,
  )
  const [uploadResult, setUploadResult] = useState<UploadResult | null>(null)
  const [uploading, setUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState<number | null>(null)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [uploadStatus, setUploadStatus] = useState<string | null>(null)
  const [embedOpen, setEmbedOpen] = useState(false)

  const rawHandle = profile?.handle?.toLowerCase()
  const handleLabel = rawHandle
    ? rawHandle.startsWith('@')
      ? rawHandle
      : `@${rawHandle}`
    : '@unknown'

  const totalPosts = useMemo(
    () => chunkForPosts(uploadFiles, postSplit).length,
    [uploadFiles, postSplit],
  )
  const previewTotal = Math.max(totalPosts, 1)
  const previewChunks = useMemo(
    () => chunkForPosts(previewItems, postSplit),
    [previewItems, postSplit],
  )
  const postTextLength = useMemo(() => {
    const text = buildPostText({
      body: uploadText,
      viewerUrl: PREVIEW_VIEWER_URL,
      index: 0,
      total: previewTotal,
    })
    return new RichText({ text }).graphemeLength
  }, [previewTotal, uploadText])

  useEffect(() => {
    if (status === 'anonymous') {
      navigate('/')
    }
  }, [navigate, status])

  useEffect(() => {
    setLinkError(null)
    setLinkNotice(null)
    setUploadError(null)
    setLinkResult(null)
    setUploadResult(null)
    setUploadStatus(null)
    setUploadProgress(null)
  }, [mode])

  useEffect(() => {
    setEmbedOpen(false)
  }, [linkResult?.id, uploadResult?.id])

  // Leaving mid-upload can interrupt the thread before the link is activated.
  useEffect(() => {
    if (!uploading) {
      return
    }
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [uploading])

  // A sleeping phone stalls the upload and can leave the thread half posted.
  useWakeLock(uploading)

  useEffect(() => {
    if (!debugMode) {
      setCompressionLogs([])
      setDebugSkipCompression(false)
      setDebugUploadMs(null)
      setDebugTimings([])
      uploadTimerRef.current = null
      setUploadProgress(null)
    }
  }, [debugMode])

  useEffect(() => {
    if (mode !== 'upload') {
      return
    }
    const element = uploadTextRef.current
    if (!element) {
      return
    }
    element.style.height = 'auto'
    element.style.height = `${element.scrollHeight}px`
  }, [mode, uploadText])

  const handleBrandClick = () => {
    const now = Date.now()
    const gap = now - debugClickRef.current.lastAt
    if (gap > 1200) {
      debugClickRef.current.count = 0
    }
    debugClickRef.current.lastAt = now
    debugClickRef.current.count += 1
    if (debugClickRef.current.count >= 5) {
      setDebugMode((prev) => !prev)
      debugClickRef.current.count = 0
    }
  }

  const handleUploadTextChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    setUploadText(event.target.value)
    const element = uploadTextRef.current
    if (!element) {
      return
    }
    element.style.height = 'auto'
    element.style.height = `${element.scrollHeight}px`
  }

  const applyFiles = (files: File[], options?: { append?: boolean }) => {
    const imageFiles = files.filter((file) => isAllowedImage(file))
    const baseFiles = options?.append ? uploadFiles : []
    const mergedFiles = [...baseFiles, ...imageFiles]
    const seen = new Set<string>()
    const uniqueFiles: File[] = []
    for (const file of mergedFiles) {
      const key = fileKey(file)
      if (seen.has(key)) {
        continue
      }
      seen.add(key)
      uniqueFiles.push(file)
    }
    const sortedFiles = sortComicFiles(uniqueFiles)
    const existingUrlMap = new Map(previewItems.map((item) => [fileKey(item.file), item.url]))
    const nextItems = sortedFiles.map((file) => ({
      file,
      url: existingUrlMap.get(fileKey(file)) ?? URL.createObjectURL(file),
    }))
    const nextKeys = new Set(nextItems.map((item) => fileKey(item.file)))
    previewItems.forEach((item) => {
      if (!nextKeys.has(fileKey(item.file))) {
        URL.revokeObjectURL(item.url)
      }
    })
    setUploadFiles(sortedFiles)
    previewItemsRef.current = nextItems
    setPreviewItems(nextItems)
    setUploadResult(null)
    setUploadError(null)
    setCompressionLogs([])
  }

  useEffect(() => {
    return () => {
      previewItemsRef.current.forEach((item) => URL.revokeObjectURL(item.url))
    }
  }, [])

  const handleGenerate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setLinkError(null)
    setLinkNotice(null)
    setLinkResult(null)

    if (!session) {
      setLinkError('ログインが必要です。')
      return
    }

    if (!postUrl.trim()) {
      setLinkError('漫画の1ページ目のURLを入力してください。')
      return
    }

    setLinkLoading(true)
    try {
      const trimmedTitle = comicTitle.trim()
      const agent = new Agent(session)
      const authHeader = await getServiceAuthHeader(agent)
      const response = await fetch('/api/manga/generate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: authHeader,
        },
        body: JSON.stringify({
          postUrl: postUrl.trim(),
          title: trimmedTitle || undefined,
          startSide,
        }),
      })

      const data = (await response.json().catch(() => null)) as
        | (GenerateApiResponse & { error?: string })
        | null
      if (!response.ok || !data) {
        const message = data?.error || 'リンク作成に失敗しました。'
        throw new Error(`[${response.status}] ${message}`)
      }

      setLinkResult({ id: data.id, viewerUrl: data.viewerUrl })

      // Record publication and verification must not invalidate the created link.
      if (data.rootUri && data.rootCid) {
        let record: { uri: string; cid: string } | null = null
        try {
          record = await withRetry(() =>
            putComicRecord(agent, session.did, {
              subject: { uri: data.rootUri as string, cid: data.rootCid as string },
              url: data.viewerUrl,
              posts: data.posts,
              title: trimmedTitle || undefined,
              startSide,
              labelValues: data.sensitiveSelfLabels,
              pageCount: data.pageCount,
            }),
          )
        } catch (recordErr) {
          console.error('comic record write failed', recordErr)
          setLinkNotice(RECORD_FAILURE_NOTICE)
        }
        if (record) {
          try {
            await completeLink({
              id: data.id,
              recordUri: record.uri,
              recordCid: record.cid,
            })
          } catch (verifyErr) {
            console.error('record verification failed', verifyErr)
            setLinkNotice(RECORD_VERIFY_NOTICE)
          }
        }
      }
    } catch (err) {
      setLinkError(err instanceof Error ? err.message : 'リンク作成に失敗しました。')
    } finally {
      setLinkLoading(false)
    }
  }

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const list = Array.from(event.target.files ?? [])
    applyFiles(list, { append: true })
    event.currentTarget.value = ''
  }

  const handleDrop = async (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    if (uploading) {
      return
    }
    try {
      const list = await getFilesFromDataTransfer(event.dataTransfer)
      applyFiles(list, { append: true })
    } catch {
      const list = Array.from(event.dataTransfer.files ?? [])
      applyFiles(list, { append: true })
    }
  }

  const handleDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault()
  }

  const handleClearFiles = () => {
    previewItems.forEach((item) => URL.revokeObjectURL(item.url))
    setUploadFiles([])
    previewItemsRef.current = []
    setPreviewItems([])
    setUploadResult(null)
    setUploadError(null)
    setCompressionLogs([])
  }

  const handleStartNewUpload = () => {
    handleClearFiles()
    setUploadText('')
  }

  const handleStartNewLink = () => {
    setLinkResult(null)
    setLinkError(null)
    setLinkNotice(null)
    setPostUrl('')
    setComicTitle('')
  }

  const handleRemoveFile = (target: File) => {
    applyFiles(
      uploadFiles.filter((file) => fileKey(file) !== fileKey(target)),
    )
  }

  const handleUpload = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setUploadError(null)
    setUploadResult(null)
    setUploadStatus(null)
    if (!session) {
      setUploadError('ログインが必要です。')
      return
    }

    if (!uploadFiles.length) {
      setUploadError('画像ファイルを選択してください。')
      return
    }

    if (uploadFiles.length > MAX_UPLOAD_FILES) {
      setUploadError(`画像は${MAX_UPLOAD_FILES}枚以内で選択してください。`)
      return
    }

    const chunks = chunkForPosts(uploadFiles, postSplit)
    const firstPostText = buildPostText({
      body: uploadText,
      viewerUrl: PREVIEW_VIEWER_URL,
      index: 0,
      total: chunks.length,
    })
    const firstPostRichText = new RichText({ text: firstPostText })
    if (firstPostRichText.graphemeLength > 300) {
      setUploadError(
        `投稿テキストが長すぎます。（${firstPostRichText.graphemeLength}/300文字）短くしてください。`,
      )
      return
    }

    const debugEnabled = debugMode
    const skipCompression = debugEnabled && debugSkipCompression
    const timings = new Map<string, { ms: number; count: number }>()
    const timed = async <T,>(label: string, task: () => Promise<T>): Promise<T> => {
      if (!debugEnabled) {
        return task()
      }
      const start = performance.now()
      try {
        return await task()
      } finally {
        const entry = timings.get(label) ?? { ms: 0, count: 0 }
        entry.ms += performance.now() - start
        entry.count += 1
        timings.set(label, entry)
      }
    }
    if (debugEnabled) {
      setCompressionLogs([])
      setDebugUploadMs(null)
      setDebugTimings([])
      uploadTimerRef.current = performance.now()
    }

    const totalSteps = 1 + uploadFiles.length + chunks.length + 1
    let completedSteps = 0
    const advanceProgress = () => {
      completedSteps += 1
      const percent = Math.min(100, Math.round((completedSteps / totalSteps) * 100))
      setUploadProgress(percent)
    }

    setUploadProgress(0)
    setUploading(true)
    try {
      setUploadStatus('URLを予約中...')
      // Check authentication before uploading any images.
      const agent = new Agent(session)
      const reserveAuthHeader = await timed('認証トークン取得', () =>
        getServiceAuthHeader(agent),
      )
      const { reserveResponse, reserveData } = await timed('URL予約', async () => {
        const response = await fetch('/api/manga/reserve', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: reserveAuthHeader,
          },
          body: JSON.stringify({
            startSide,
            title: comicTitle.trim() || undefined,
          }),
        })
        const data = (await response.json().catch(() => null)) as
          | (GenerateResponse & { error?: string })
          | null
        return { reserveResponse: response, reserveData: data }
      })
      if (!reserveResponse.ok || !reserveData) {
        const message = reserveData?.error || 'URLの予約に失敗しました。'
        throw new Error(`[${reserveResponse.status}] ${message}`)
      }

      const viewerUrl = reserveData.viewerUrl
      const selfLabels =
        contentRating === 'r18'
          ? {
              $type: 'com.atproto.label.defs#selfLabels',
              values: [{ val: 'porn' }],
            }
          : null
      let root: { uri: string; cid: string } | null = null
      let parent: { uri: string; cid: string } | null = null
      const postRefs: StrongRef[] = []
      let postedImageCount = 0
      const skippedFiles: string[] = []
      // Preserve the underlying error if every image upload fails.
      let firstUploadError: unknown = null
      advanceProgress()

      for (let index = 0; index < chunks.length; index += 1) {
        setUploadStatus(`ポスト中 ${index + 1}/${chunks.length}`)
        const chunk = chunks[index]
        const images = []
        for (const file of chunk) {
          try {
            const compressed = await timed('画像圧縮', () =>
              compressForBluesky(file, { skipCompression }),
            )
            const encoding = compressed.blob.type || compressed.mime
            const blob = await timed('画像アップロード', () =>
              withRetry(
                () => agent.uploadBlob(compressed.blob, { encoding }),
                (attempt) => {
                  setUploadStatus(
                    `ポスト中 ${index + 1}/${chunks.length} (再試行 ${attempt}/${RETRY_LIMIT})`,
                  )
                },
              ),
            )
            images.push({
              image: blob.data.blob,
              alt: '',
              aspectRatio: {
                width: compressed.width,
                height: compressed.height,
              },
            })
            if (debugEnabled) {
              setCompressionLogs((prev) => [
                ...prev,
                {
                  name: file.name,
                  originalWidth: compressed.originalWidth,
                  originalHeight: compressed.originalHeight,
                  outputWidth: compressed.width,
                  outputHeight: compressed.height,
                  originalBytes: compressed.originalBytes,
                  outputBytes: compressed.outputBytes,
                  mime: compressed.mime,
                  strategy: compressed.strategy,
                  quality: compressed.quality,
                },
              ])
            }
          } catch (err) {
            console.error(`画像のアップロードに失敗: ${file.name}`, err)
            if (firstUploadError === null) {
              firstUploadError = err
            }
            skippedFiles.push(file.name)
          }
          advanceProgress()
        }

        if (!images.length) {
          // Only the first chunk carries the viewer URL; it cannot be skipped.
          if (index === 0) {
            throw (
              firstUploadError ??
              new Error('1ポスト目の画像をアップロードできませんでした。')
            )
          }
          advanceProgress()
          continue
        }

        const text = buildPostText({
          body: uploadText,
          viewerUrl,
          index,
          total: chunks.length,
        })
        const richText = new RichText({ text })
        await timed('テキスト解析', () => richText.detectFacets(agent))
        const facets =
          richText.facets && richText.facets.length ? richText.facets : undefined

        const embed =
          images.length >= GALLERY_MIN_IMAGES
            ? {
                $type: 'app.bsky.embed.gallery' as const,
                items: images.map((item) => ({
                  $type: 'app.bsky.embed.gallery#image' as const,
                  ...item,
                })),
              }
            : {
                $type: 'app.bsky.embed.images' as const,
                images,
              }

        const record: Parameters<typeof agent.post>[0] = {
          text: richText.text,
          facets,
          langs: ['ja'],
          embed,
          via: POST_VIA,
        }

        if (selfLabels) {
          record.labels = selfLabels
        }

        if (root && parent) {
          record.reply = { root, parent }
        }

        const response = await timed('ポスト作成', () =>
          withRetry(
            () => agent.post(record),
            (attempt) => {
              setUploadStatus(
                `ポスト中 ${index + 1}/${chunks.length} (再試行 ${attempt}/${RETRY_LIMIT})`,
              )
            },
          ),
        )
        const ref = { uri: response.uri, cid: response.cid }
        if (!root) {
          root = ref
        }
        parent = ref
        postRefs.push(ref)
        postedImageCount += images.length
        advanceProgress()
      }

      if (!root) {
        throw firstUploadError ?? new Error('ポストに失敗しました。')
      }
      const rootRef: StrongRef = root

      setUploadStatus('リーダーと紐づけ中...')
      // Fall back to service-auth completion if record writing or verification fails.
      let recordRef: { uri: string; cid: string } | null = null
      try {
        recordRef = await timed('レコード作成', () =>
          withRetry(() =>
            putComicRecord(agent, session.did, {
              subject: rootRef,
              url: viewerUrl,
              posts: postRefs,
              title: comicTitle.trim() || undefined,
              startSide,
              language: 'ja',
              labelValues: contentRating === 'r18' ? ['porn'] : undefined,
              pageCount: postedImageCount || undefined,
            }),
          ),
        )
      } catch (recordErr) {
        console.error('comic record write failed', recordErr)
      }
      let completeResult: GenerateResponse
      let recordNotice: string | null = null
      if (recordRef) {
        const verifiedRef = recordRef
        try {
          completeResult = await timed('リンク紐づけ', () =>
            completeLink({
              id: reserveData.id,
              recordUri: verifiedRef.uri,
              recordCid: verifiedRef.cid,
            }),
          )
        } catch (completeErr) {
          console.error('record-based completion failed', completeErr)
          recordNotice = RECORD_VERIFY_NOTICE
          completeResult = await timed('リンク紐づけ', () =>
            completeLink(
              { id: reserveData.id, postUrl: rootRef.uri },
              () => getServiceAuthHeader(agent),
            ),
          )
        }
      } else {
        recordNotice = RECORD_FAILURE_NOTICE
        completeResult = await timed('リンク紐づけ', () =>
          completeLink(
            { id: reserveData.id, postUrl: rootRef.uri },
            () => getServiceAuthHeader(agent),
          ),
        )
      }
      advanceProgress()

      const postUrl = toBskyPostUrl(root.uri, session.did)
      setUploadResult({
        id: completeResult.id,
        viewerUrl: completeResult.viewerUrl,
        pending: completeResult.pending,
        postUrl,
      })
      const warnings: string[] = []
      if (skippedFiles.length) {
        warnings.push(
          `以下の画像はアップロードに失敗したためスキップされました：${skippedFiles.join('、')}`,
        )
      }
      if (recordNotice) {
        warnings.push(recordNotice)
      }
      if (warnings.length) {
        setUploadError(warnings.join('\n'))
      }
    } catch (err) {
      setUploadError(formatUploadError(err))
    } finally {
      if (debugEnabled && uploadTimerRef.current !== null) {
        setDebugUploadMs(Math.round(performance.now() - uploadTimerRef.current))
        uploadTimerRef.current = null
        setDebugTimings(
          Array.from(timings, ([label, entry]) => ({
            label,
            ms: entry.ms,
            count: entry.count,
          })),
        )
      }
      setUploading(false)
      setUploadStatus(null)
      setUploadProgress(null)
    }
  }

  const handleCopy = async (key: string, url?: string) => {
    if (!url) {
      return
    }
    let ok = true
    try {
      await navigator.clipboard.writeText(url)
    } catch {
      ok = false
    }
    setCopyFeedback({ key, ok })
    if (copyTimerRef.current !== null) {
      window.clearTimeout(copyTimerRef.current)
    }
    copyTimerRef.current = window.setTimeout(() => setCopyFeedback(null), 2000)
  }

  const copyLabel = (key: string, label: string) =>
    copyFeedback?.key === key
      ? copyFeedback.ok
        ? 'コピーしました'
        : 'コピーできませんでした'
      : label

  const handleShare = (url?: string) => {
    if (!url) {
      return
    }
    const shareUrl = `https://bsky.app/intent/compose?text=${encodeURIComponent(
      url,
    )}`
    window.open(shareUrl, 'skybind-share', 'width=600,height=700,menubar=no,toolbar=no')
  }

  const renderDebugTimings = () => {
    const totalLine = (
      <div className="mt-2 text-[11px] text-ink/60">
        ポスト時間:{' '}
        {uploading && uploadTimerRef.current !== null
          ? '計測中...'
          : debugUploadMs !== null
            ? `${(debugUploadMs / 1000).toFixed(2)}s`
            : '未計測'}
      </div>
    )
    if (debugUploadMs === null || !debugTimings.length) {
      return totalLine
    }
    const measuredMs = debugTimings.reduce((acc, entry) => acc + entry.ms, 0)
    const otherMs = Math.max(0, debugUploadMs - measuredMs)
    const rows =
      otherMs >= 1
        ? [...debugTimings, { label: 'その他', ms: otherMs, count: 1 }]
        : debugTimings
    return (
      <>
        {totalLine}
        <div className="mt-2 space-y-1 border-t border-ink/10 pt-2">
          {rows.map((entry) => (
            <div
              key={entry.label}
              className="flex items-center justify-between gap-3 text-[11px] text-ink/60"
            >
              <span>
                {entry.label}
                {entry.count > 1 ? (
                  <span className="ml-1 text-[10px] text-ink/40">×{entry.count}</span>
                ) : null}
              </span>
              <span className="tabular-nums">
                {(entry.ms / 1000).toFixed(2)}s (
                {debugUploadMs > 0 ? Math.round((entry.ms / debugUploadMs) * 100) : 0}
                %)
              </span>
            </div>
          ))}
        </div>
      </>
    )
  }

  const renderResult = (
    result: GenerateResponse,
    options?: { share?: boolean; postUrl?: string },
  ) => {
    const embedUrl = toEmbedUrl(result.viewerUrl)
    const embedCode = buildEmbedCode(embedUrl)
    const embedId = `embed-panel-${result.id}`

    return (
      <div className="mt-6 rounded-2xl border border-ink/10 bg-paper/70 px-4 py-4">
        <div className="text-xs uppercase tracking-[0.3em] text-ink/50">リーダー用リンク作成</div>
        <p className="mt-2 break-all text-sm text-ink/70">{result.viewerUrl}</p>
        {result.pending ? (
          <div className="mt-2 text-xs text-ink/50">
            Bluesky側の反映に時間がかかる場合があります。数分後にアクセスしてください。
          </div>
        ) : null}
        <div className="mt-3 flex flex-wrap gap-2">
          <a
            href={result.viewerUrl}
            className="rounded-full bg-ink px-4 py-2 text-xs font-semibold uppercase tracking-[0.3em] text-paper"
          >
            開く
          </a>
          <button
            type="button"
            onClick={() => handleCopy(`${result.id}-viewer`, result.viewerUrl)}
            className="rounded-full border border-ink/10 bg-paper/70 px-4 py-2 text-xs font-semibold uppercase tracking-[0.3em] text-ink/70"
          >
            {copyLabel(`${result.id}-viewer`, 'コピー')}
          </button>
          {options?.postUrl ? (
            <a
              href={options.postUrl}
              target="_blank"
              rel="noreferrer"
              className="rounded-full border border-ink/10 bg-paper/70 px-4 py-2 text-xs font-semibold uppercase tracking-[0.3em] text-ink/70"
            >
              ポストを開く
            </a>
          ) : null}
          {options?.share ? (
            <button
              type="button"
              onClick={() => handleShare(result.viewerUrl)}
              className="rounded-full border border-ink/10 bg-paper/70 px-4 py-2 text-xs font-semibold uppercase tracking-[0.3em] text-ink/70"
            >
              Blueskyにポストする
            </button>
          ) : null}
        </div>

        <div className="mt-5 border-t border-ink/10 pt-4">
          <button
            type="button"
            onClick={() => setEmbedOpen((prev) => !prev)}
            className="flex w-full items-center justify-between text-xs uppercase tracking-[0.3em] text-ink/60"
            aria-expanded={embedOpen}
            aria-controls={embedId}
          >
            <span className="normal-case">ブログ向けCSS埋め込みコード(β版)</span>
            <span className="flex items-center gap-2 text-[11px] tracking-[0.2em] text-ink/45">
              <span className="min-w-[3.5rem] text-right">{embedOpen ? '閉じる' : '開く'}</span>
              <span
                className={`inline-flex h-4 w-4 items-center justify-center transition-transform duration-200 ${
                  embedOpen ? 'rotate-180' : ''
                }`}
                aria-hidden="true"
              >
                <svg
                  viewBox="0 0 10 6"
                  className="h-2.5 w-2.5 fill-current"
                  role="presentation"
                >
                  <path d="M1 0.75L5 4.75L9 0.75H1Z" />
                </svg>
              </span>
            </span>
          </button>
          {embedOpen ? (
            <div id={embedId} className="mt-3">
              <p className="break-all text-sm text-ink/70">{embedUrl}</p>
              <pre className="mt-3 whitespace-pre-wrap rounded-2xl border border-ink/10 bg-white/70 px-3 py-3 text-[11px] text-ink/70">{embedCode}</pre>
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => handleCopy(`${result.id}-embed-code`, embedCode)}
                  className="rounded-full border border-ink/10 bg-paper/70 px-4 py-2 text-xs font-semibold uppercase tracking-[0.3em] text-ink/70"
                >
                  {copyLabel(`${result.id}-embed-code`, 'コードをコピー')}
                </button>
                <button
                  type="button"
                  onClick={() => handleCopy(`${result.id}-embed-url`, embedUrl)}
                  className="rounded-full border border-ink/10 bg-paper/70 px-4 py-2 text-xs font-semibold uppercase tracking-[0.3em] text-ink/70"
                >
                  {copyLabel(`${result.id}-embed-url`, 'URLのみコピー')}
                </button>
              </div>
              <div className="mt-2 text-[11px] text-ink/50">
                URLの末尾に「?layout=single|spread」「&page=2」を付けると、表示方式/開始ページを調整できます。
              </div>
            </div>
          ) : null}
        </div>
      </div>
    )
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
    return null
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-6 py-12">
      <div className="w-full max-w-xl animate-soft-in rounded-3xl border border-ink/10 bg-white/70 p-8 shadow-frame backdrop-blur-sm">
        <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.4em] text-ink/50">
          <button
            type="button"
            onClick={handleBrandClick}
            className="cursor-default select-none uppercase tracking-[0.4em] text-ink/50"
          >
            SKYBIND
          </button>
          {debugMode ? (
            <span className="rounded-full bg-ink/10 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[0.3em] text-ink/60">
              Debug
            </span>
          ) : null}
        </div>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-[11px] text-ink/50">
          <span className="tracking-[0.2em]">{handleLabel}</span>
          <div className="flex items-center gap-3">
            <ManageGearLink disabled={uploading} />
            <button
              type="button"
              onClick={signOut}
              disabled={uploading}
              className="rounded-full border border-ink/10 bg-paper/70 px-4 py-2 text-[10px] font-semibold uppercase tracking-[0.3em] text-ink/70 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Logout
            </button>
          </div>
        </div>

        <div className="mt-6">
          <div className="text-sm font-semibold text-ink/80">漫画は？</div>
          <div className="mt-2 flex flex-wrap gap-2">
            {([
              ['link', 'ポスト済み！'],
              ['upload', 'これからポスト！'],
            ] as const).map(([value, label]) => (
              <button
                key={value}
                type="button"
                disabled={uploading}
                onClick={() => setMode(value)}
                className={`rounded-full px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.25em] transition disabled:cursor-not-allowed disabled:opacity-50 ${
                  mode === value
                    ? 'bg-ink text-paper'
                    : 'border border-ink/10 bg-paper/70 text-ink/70'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {mode === 'link' ? (
          <div className="mt-6">
            <h1 className="text-2xl font-semibold text-ink">リーダー用リンク作成</h1>
            <p className="mt-2 text-sm text-ink/60">
              {linkResult
                ? 'リンク作成が完了しました。'
                : '漫画の1ページ目のポストURLを入力してください。'}
            </p>

            {(linkError || error) && (
              <div
                role="alert"
                className="mt-4 rounded-2xl border border-accent/30 bg-accent/10 px-4 py-3 text-sm text-accent"
              >
                {linkError || error}
              </div>
            )}

            {linkNotice ? (
              <div
                role="status"
                className="mt-4 rounded-2xl border border-ink/10 bg-paper/70 px-4 py-3 text-xs text-ink/70"
              >
                {linkNotice}
              </div>
            ) : null}

            {linkResult ? (
              <>
                {renderResult(linkResult, { share: true })}
                <button
                  type="button"
                  onClick={handleStartNewLink}
                  className="mt-4 w-full rounded-2xl border border-ink/15 bg-paper/70 px-6 py-3 text-xs font-semibold uppercase tracking-[0.3em] text-ink/70 shadow-sm transition hover:bg-white"
                >
                  新しいリンクを作成する
                </button>
              </>
            ) : (
            <form className="mt-6 space-y-4" onSubmit={handleGenerate}>
              <input
                type="url"
                aria-label="漫画の1ページ目のポストURL"
                placeholder="https://bsky.app/profile/.../post/..."
                value={postUrl}
                onChange={(event) => setPostUrl(event.target.value)}
                className="w-full rounded-2xl border border-ink/10 bg-paper/80 px-4 py-3 text-sm shadow-sm focus:border-ink/40 focus:outline-none"
                required
              />
              <TitleInput
                value={comicTitle}
                onChange={setComicTitle}
                disabled={linkLoading}
              />
              <StartSidePicker value={startSide} onChange={setStartSide} />
              <button
                type="submit"
                disabled={linkLoading}
                className="w-full rounded-2xl bg-ink px-6 py-3 text-xs font-semibold uppercase tracking-[0.3em] text-paper shadow transition hover:bg-ink/90 disabled:cursor-not-allowed disabled:opacity-70"
              >
                {linkLoading ? '作成中...' : 'リンク作成'}
              </button>
            </form>
            )}
          </div>
        ) : (
          <div className="mt-6">
            <h1 className="text-2xl font-semibold text-ink">漫画をポスト & リーダー用リンク作成</h1>
            <p className="mt-2 text-sm text-ink/60">
              {uploadResult
                ? 'ポストとリンク作成が完了しました。'
                : '連番ファイル (例：xxxxx_001.png) を選択してください。'}
            </p>

            {(uploadError || error) && (
              <div
                role="alert"
                className="mt-4 rounded-2xl border border-accent/30 bg-accent/10 px-4 py-3 text-sm text-accent"
              >
                {uploadError || error}
              </div>
            )}

            {uploadStatus ? (
              <div
                role="status"
                aria-live="polite"
                className="mt-4 rounded-2xl border border-ink/10 bg-paper/70 px-4 py-3 text-xs text-ink/70"
              >
                {uploadStatus}
              </div>
            ) : null}

            {uploadResult ? (
              <>
                {renderResult(uploadResult, { postUrl: uploadResult.postUrl })}
                {debugMode ? (
                  <div className="mt-4 rounded-2xl border border-ink/10 bg-white/70 px-4 py-3 text-xs text-ink/70">
                    <div className="text-[10px] font-semibold uppercase tracking-[0.3em] text-ink/50">
                      Timing Debug
                    </div>
                    {renderDebugTimings()}
                  </div>
                ) : null}
                <button
                  type="button"
                  onClick={handleStartNewUpload}
                  className="mt-4 w-full rounded-2xl border border-ink/15 bg-paper/70 px-6 py-3 text-xs font-semibold uppercase tracking-[0.3em] text-ink/70 shadow-sm transition hover:bg-white"
                >
                  新しい漫画をポストする
                </button>
              </>
            ) : (
            <form className="mt-6 space-y-4" onSubmit={handleUpload}>
              <div>
                <div className="text-sm font-semibold text-ink/80">画像ファイル</div>
                <div
                  className="mt-2 rounded-2xl border border-dashed border-ink/20 bg-paper/60 px-4 py-3"
                  onDrop={handleDrop}
                  onDragOver={handleDragOver}
                >
                  <div className="flex flex-wrap items-center gap-3">
                    <button
                      type="button"
                      disabled={uploading}
                      onClick={() => fileInputRef.current?.click()}
                      className="rounded-full border border-ink/10 bg-paper/70 px-4 py-2 text-xs font-semibold uppercase tracking-[0.3em] text-ink/70 transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {uploadFiles.length ? '画像を追加' : '画像を選択'}
                    </button>
                    {uploadFiles.length ? (
                      <button
                        type="button"
                        onClick={handleClearFiles}
                        disabled={uploading}
                        className="rounded-full border border-ink/10 bg-paper/70 px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.3em] text-ink/60 transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        クリア
                      </button>
                    ) : null}
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      multiple
                      disabled={uploading}
                      onChange={handleFileChange}
                      className="sr-only"
                    />
                    <span className="text-[11px] text-ink/45">
                      PNG・JPEG・WebP / ドラッグ＆ドロップ対応
                    </span>
                  </div>
                </div>
                {uploadFiles.length ? (
                  <div className="mt-2 text-xs text-ink/60">
                    {`選択: ${uploadFiles.length}枚 / ポスト数: ${totalPosts}件`}
                  </div>
                ) : null}
                {previewChunks.length ? (
                  <div className="mt-4">
                    {previewChunks.reduce<{
                      elements: JSX.Element[]
                      offset: number
                    }>(
                      (acc, chunk, chunkIndex) => {
                        const isLast = chunkIndex === previewChunks.length - 1
                        const chunkStart = acc.offset
                        acc.offset += chunk.length
                        acc.elements.push(
                          <div key={`preview-${chunkIndex}`} className="flex flex-col">
                            <div className="rounded-2xl border border-ink/10 bg-white/60 px-4 py-3">
                              <div className="text-xs font-semibold uppercase tracking-[0.3em] text-ink/60">
                                ポスト{chunkIndex + 1}
                                <span className="ml-2 text-[10px] font-normal text-ink/40">
                                  {chunk.length}枚
                                </span>
                              </div>
                              <div className="mt-2 flex flex-wrap gap-2">
                                {chunk.map((item, itemIndex) => {
                                  const globalIndex = chunkStart + itemIndex
                                  const pairIndex = getPairIndex(globalIndex, startSide)
                                  const color =
                                    PREVIEW_PAIR_COLORS[
                                      pairIndex % PREVIEW_PAIR_COLORS.length
                                    ]
                                  return (
                                    <div
                                      key={item.url}
                                      className="group relative h-20 w-20 overflow-hidden rounded-xl border-2 bg-paper/60"
                                      style={{ borderColor: color }}
                                    >
                                      <img
                                        src={item.url}
                                        alt={item.file.name}
                                        className="h-full w-full object-contain"
                                        draggable={false}
                                      />
                                      <span
                                        aria-hidden="true"
                                        className="pointer-events-none absolute bottom-1 left-1 rounded-full bg-ink/70 px-1.5 py-0.5 text-[9px] font-semibold text-paper"
                                      >
                                        {globalIndex + 1}
                                      </span>
                                      <button
                                        type="button"
                                        disabled={uploading}
                                        onClick={() => handleRemoveFile(item.file)}
                                        aria-label={`${item.file.name}を選択から外す`}
                                        title="この画像を外す"
                                        className="absolute right-1 top-1 flex h-6 w-6 items-center justify-center rounded-full bg-ink/75 text-sm leading-none text-paper shadow-sm transition hover:bg-ink focus:outline-none focus:ring-2 focus:ring-paper disabled:cursor-not-allowed disabled:opacity-40 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100"
                                      >
                                        <span aria-hidden="true">×</span>
                                      </button>
                                    </div>
                                  )
                                })}
                              </div>
                            </div>
                            {!isLast ? (
                              <div className="relative h-4">
                                <span
                                  aria-hidden="true"
                                  className="absolute left-6 top-0 h-4 w-px bg-ink/20"
                                />
                              </div>
                            ) : null}
                          </div>,
                        )
                        return acc
                      },
                      { elements: [], offset: 0 },
                    ).elements}
                  </div>
                ) : null}
                {debugMode ? (
                  <div className="mt-4 rounded-2xl border border-ink/10 bg-white/70 px-4 py-3 text-xs text-ink/70">
                    <div className="text-[10px] font-semibold uppercase tracking-[0.3em] text-ink/50">
                      Compression Debug
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-ink/60">
                      <span>圧縮</span>
                      <button
                        type="button"
                        disabled={uploading}
                        onClick={() => setDebugSkipCompression((prev) => !prev)}
                        className={`rounded-full border px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.25em] transition ${
                          debugSkipCompression
                            ? 'border-accent/40 text-accent/80'
                            : 'border-ink/20 text-ink/60'
                        } disabled:cursor-not-allowed disabled:opacity-50`}
                      >
                        {debugSkipCompression ? '圧縮: OFF' : '圧縮: ON'}
                      </button>
                    </div>
                    {renderDebugTimings()}
                    {compressionLogs.length ? (
                      <div className="mt-2 space-y-2">
                        {compressionLogs.map((log, index) => (
                          <div
                            key={`${log.name}-${index}`}
                            className="rounded-xl border border-ink/10 bg-paper/60 px-3 py-2"
                          >
                            <div className="text-[11px] font-semibold text-ink/70">
                              {log.name}
                            </div>
                            <div className="mt-1 text-[11px] text-ink/60">
                              {log.originalWidth}x{log.originalHeight} → {log.outputWidth}x
                              {log.outputHeight}
                            </div>
                            <div className="text-[11px] text-ink/60">
                              {formatBytes(log.originalBytes)} → {formatBytes(log.outputBytes)}
                            </div>
                            <div className="mt-1 text-[10px] uppercase tracking-[0.25em] text-ink/50">
                              {log.mime} / {log.strategy} / q={log.quality.toFixed(2)}
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="mt-2 text-[11px] text-ink/50">
                        まだ圧縮ログがありません。
                      </div>
                    )}
                  </div>
                ) : null}
              </div>
              <div>
                <div className="flex items-center justify-between gap-3">
                  <div className="text-sm font-semibold text-ink/80">ポスト1の本文</div>
                  <div
                    className={`text-[11px] tabular-nums ${
                      postTextLength > 300 ? 'font-semibold text-accent' : 'text-ink/45'
                    }`}
                    aria-live="polite"
                  >
                    {postTextLength} / 300文字
                  </div>
                </div>
                <div className="mt-2 rounded-2xl border border-ink/10 bg-paper/80 px-4 py-3 text-sm shadow-sm focus-within:border-ink/40">
                  <textarea
                    ref={uploadTextRef}
                    value={uploadText}
                    onChange={handleUploadTextChange}
                    placeholder="本文をここに入力しよう..."
                    rows={1}
                    disabled={uploading}
                    className="textarea-autogrow w-full resize-none bg-transparent text-sm leading-[1.35] text-ink placeholder:text-ink/40 focus:outline-none"
                  />
                  <div className="mt-1 text-sm leading-[1.35] text-ink/70 whitespace-pre-line">
                    {PREVIEW_VIEWER_URL}
                    {'\n'}
                    (1/{previewTotal})
                  </div>
                </div>
              </div>
              <TitleInput
                value={comicTitle}
                onChange={setComicTitle}
                disabled={uploading}
              />
              <PostSplitPicker
                value={postSplit}
                onChange={setPostSplit}
                disabled={uploading}
              />
              <StartSidePicker
                value={startSide}
                onChange={setStartSide}
                disabled={uploading}
              />
              <ContentRatingPicker
                value={contentRating}
                onChange={setContentRating}
                disabled={uploading}
              />
              <button
                type="submit"
                disabled={uploading}
                className="relative w-full overflow-hidden rounded-2xl bg-ink px-6 py-3 text-xs font-semibold uppercase tracking-[0.3em] text-paper shadow transition hover:bg-ink/90 disabled:cursor-not-allowed disabled:opacity-70"
              >
                {uploading && uploadProgress !== null ? (
                  <span
                    className="absolute inset-y-0 left-0 bg-paper/20 transition-[width] duration-300"
                    style={{ width: `${uploadProgress}%` }}
                    aria-hidden="true"
                  />
                ) : null}
                <span className="relative z-10">
                  {uploading
                    ? `ポスト中...${uploadProgress !== null ? ` ${uploadProgress}%` : ''}`
                    : '漫画をポストしてリンクを作成'}
                </span>
              </button>
            </form>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
