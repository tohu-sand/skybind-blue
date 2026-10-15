import type { Context } from 'hono'
import { HTTPException } from 'hono/http-exception'

// Caller identity comes from service auth or the verified record, never the payload.
type GeneratePayload = {
  postUrl: string
  title?: string
  startSide: 'right' | 'left'
}

type ReservePayload = {
  title?: string
  startSide: 'right' | 'left'
}

// A failed record write falls back to postUrl with service auth.
type CompletePayload =
  | { kind: 'record'; id: string; recordUri: string; recordCid: string }
  | { kind: 'legacy'; id: string; postUrl: string }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

// Cap actual bytes before parsing; Content-Length may be missing or incorrect.
const MAX_BODY_BYTES = 16 * 1024

const readJsonBody = async (c: Context): Promise<Record<string, unknown>> => {
  const declaredLength = Number(c.req.header('content-length') ?? 0)
  if (declaredLength > MAX_BODY_BYTES) {
    throw new HTTPException(413, { message: 'リクエストが大きすぎます。' })
  }
  const stream = c.req.raw.body
  let text = ''
  if (stream) {
    const reader = stream.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) {
          break
        }
        total += value.byteLength
        if (total > MAX_BODY_BYTES) {
          await reader.cancel().catch(() => {})
          throw new HTTPException(413, { message: 'リクエストが大きすぎます。' })
        }
        chunks.push(value)
      }
    } finally {
      reader.releaseLock()
    }
    const merged = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      merged.set(chunk, offset)
      offset += chunk.byteLength
    }
    text = new TextDecoder().decode(merged)
  }

  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    throw new HTTPException(400, { message: 'JSONの形式が正しくありません。' })
  }

  if (!isRecord(body)) {
    throw new HTTPException(400, { message: 'リクエストが不正です。' })
  }

  return body
}

const readStartSide = (value: unknown) => (value === 'left' ? 'left' : 'right')

const MAX_TITLE_LENGTH = 100

const readTitle = (value: unknown) =>
  value ? String(value).trim().slice(0, MAX_TITLE_LENGTH) || undefined : undefined

export async function readGeneratePayload(c: Context): Promise<GeneratePayload> {
  const body = await readJsonBody(c)

  const postUrl = String(body.postUrl || '').trim()
  const title = readTitle(body.title)
  const startSide = readStartSide(body.startSide)

  if (!postUrl) {
    throw new HTTPException(400, { message: 'postUrlが必要です。' })
  }

  return {
    postUrl,
    title,
    startSide,
  }
}

export async function readReservePayload(c: Context): Promise<ReservePayload> {
  const body = await readJsonBody(c)

  const title = readTitle(body.title)
  const startSide = readStartSide(body.startSide)

  return {
    title,
    startSide,
  }
}

// Bound ID length because IDs are retained as rate-limit map keys.
export const LINK_ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

export async function readCompletePayload(c: Context): Promise<CompletePayload> {
  const body = await readJsonBody(c)

  const id = String(body.id || '').trim()
  if (!id) {
    throw new HTTPException(400, { message: 'idが必要です。' })
  }
  if (!LINK_ID_PATTERN.test(id)) {
    throw new HTTPException(400, { message: 'idが不正です。' })
  }

  const recordUri = String(body.recordUri || '').trim()
  if (recordUri) {
    // Pin verification to the version the client wrote.
    const recordCid = String(body.recordCid || '').trim()
    if (!recordCid) {
      throw new HTTPException(400, { message: 'recordCidが必要です。' })
    }
    return { kind: 'record', id, recordUri, recordCid }
  }

  const postUrl = String(body.postUrl || '').trim()

  if (!postUrl) {
    throw new HTTPException(400, { message: 'postUrlまたはrecordUriが必要です。' })
  }

  return { kind: 'legacy', id, postUrl }
}
