// Keep in sync with lexicons/blue/skybind/comic.json.

export const COMIC_COLLECTION = 'blue.skybind.comic'

// RPC scopes require a DID service reference. Match public/.well-known/did.json
// and public/client-metadata.json, where the fragment separator is encoded as %23.
export const SERVICE_AUTH_AUD = 'did:web:skybind.blue#skybind_api'
// Token scope for link management; this is not a published XRPC method.
export const SERVICE_AUTH_LXM = 'blue.skybind.manageLink'

export type StrongRef = {
  uri: string
  cid: string
}

export type ComicSelfLabels = {
  $type: 'com.atproto.label.defs#selfLabels'
  values: { val: string }[]
}

export type ComicRecord = {
  $type: typeof COMIC_COLLECTION
  subject: StrongRef
  url: string
  posts?: StrongRef[]
  title?: string
  startSide?: 'right' | 'left'
  language?: string
  labels?: ComicSelfLabels
  pageCount?: number
  createdAt: string
}

export const POST_URI_PATTERN = /^at:\/\/(did:[^/]+)\/app\.bsky\.feed\.post\/([^/?#]+)$/

export const comicRecordUri = (did: string, rkey: string) =>
  `at://${did}/${COMIC_COLLECTION}/${rkey}`

export const parseComicRecordUri = (uri: string) => {
  const match = new RegExp(
    `^at://(did:[^/]+)/${COMIC_COLLECTION.replace(/\./g, '\\.')}/([^/?#]+)$`,
  ).exec(uri)
  return match ? { did: match[1], rkey: match[2] } : null
}

export const parsePostUri = (uri: string) => {
  const match = POST_URI_PATTERN.exec(uri)
  return match ? { did: match[1], rkey: match[2] } : null
}
