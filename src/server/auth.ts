import type { Context } from 'hono'
import { HTTPException } from 'hono/http-exception'

// The caller's DID is NOT part of any payload: reserve/generate/legacy-complete
// take it from the verified service-auth JWT, and record-complete derives it
// from the record itself.
type GeneratePayload = {
  postUrl: string
  title?: string
  startSide: 'right' | 'left'
}

type ReservePayload = {
  title?: string
  startSide: 'right' | 'left'
}

// New clients complete by pointing at the blue.skybind.comic record they wrote
// (ownership proof: only the account holder can write to their own repo).
// Legacy shape (postUrl) remains as a fallback for runs where the record
// write failed; it requires service auth instead.
type CompletePayload =
  | { kind: 'record'; id: string; recordUri: string; recordCid: string }
  | { kind: 'legacy'; id: string; postUrl: string }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const readJsonBody = async (c: Context): Promise<Record<string, unknown>> => {
  let body: unknown
  try {
    body = await c.req.json()
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

export async function readCompletePayload(c: Context): Promise<CompletePayload> {
  const body = await readJsonBody(c)

  const id = String(body.id || '').trim()
  if (!id) {
    throw new HTTPException(400, { message: 'idが必要です。' })
  }

  const recordUri = String(body.recordUri || '').trim()
  if (recordUri) {
    // Required so the server can pin verification to the exact version the
    // client wrote (TOCTOU detection).
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
