import type { Context } from 'hono'
import { HTTPException } from 'hono/http-exception'

type GeneratePayload = {
  postUrl: string
  title?: string
  startSide: 'right' | 'left'
  authorDid: string
}

type ReservePayload = {
  title?: string
  startSide: 'right' | 'left'
  authorDid: string
}

type CompletePayload = {
  id: string
  postUrl: string
  authorDid: string
}

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

export async function readGeneratePayload(c: Context): Promise<GeneratePayload> {
  const body = await readJsonBody(c)

  const postUrl = String(body.postUrl || '').trim()
  const authorDid = String(body.authorDid || '').trim()
  const title = body.title ? String(body.title).trim() : undefined
  const startSide = readStartSide(body.startSide)

  if (!postUrl) {
    throw new HTTPException(400, { message: 'postUrlが必要です。' })
  }

  if (!authorDid) {
    throw new HTTPException(401, { message: 'authorDidが必要です。' })
  }

  return {
    postUrl,
    title,
    startSide,
    authorDid,
  }
}

export async function readReservePayload(c: Context): Promise<ReservePayload> {
  const body = await readJsonBody(c)

  const authorDid = String(body.authorDid || '').trim()
  const title = body.title ? String(body.title).trim() : undefined
  const startSide = readStartSide(body.startSide)

  if (!authorDid) {
    throw new HTTPException(401, { message: 'authorDidが必要です。' })
  }

  return {
    title,
    startSide,
    authorDid,
  }
}

export async function readCompletePayload(c: Context): Promise<CompletePayload> {
  const body = await readJsonBody(c)

  const id = String(body.id || '').trim()
  const postUrl = String(body.postUrl || '').trim()
  const authorDid = String(body.authorDid || '').trim()

  if (!id) {
    throw new HTTPException(400, { message: 'idが必要です。' })
  }

  if (!postUrl) {
    throw new HTTPException(400, { message: 'postUrlが必要です。' })
  }

  if (!authorDid) {
    throw new HTTPException(401, { message: 'authorDidが必要です。' })
  }

  return {
    id,
    postUrl,
    authorDid,
  }
}
