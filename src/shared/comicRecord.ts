// Shared between the browser uploader (record writer) and the Pages Function
// (record verifier). Keep in sync with lexicons/blue/skybind/comic.json.

export const COMIC_COLLECTION = 'blue.skybind.comic'

// Service auth: the browser asks the user's PDS for a short-lived JWT with
// this audience/method, and the API verifies it to prove account control.
// The audience is a DID *service reference* (DID + service id fragment) as
// required by the rpc permission scope; it must match the service entry in
// public/.well-known/did.json and the scope in public/client-metadata.json
// (where the '#' is percent-encoded as %23).
export const SERVICE_AUTH_AUD = 'did:web:skybind.blue#skybind_api'
// Capability identifier for link management, not a published XRPC method:
// it only scopes the service-auth token to SkyBind's link endpoints.
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
