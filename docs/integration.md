# クライアント連携

SkyBindは、Blueskyのセルフリプライで連なった画像付きポストを見開きで読むリーダーです。
リンクを作成すると、作者自身のリポジトリに`blue.skybind.comic`レコードが記録されます。
このレコードから、クライアントが作品へのリンクを取得できます。
レコードの書き込みに失敗しても閲覧リンクは作成されるため、レコードがない作品もあります。

- スキーマ: https://lexicon.garden/lexicon/did:plc:zvnmkrwdc4j4nwsyquoadf7c/blue.skybind.comic
- スキーマの管理元: `skybind.blue`（DNS `_lexicon.skybind.blue`で確認できます）

## レコードの位置

`app.bsky.feed.threadgate`と同様に、rkeyは漫画のルートポストと共通です。

```text
ルートポスト  at://<did>/app.bsky.feed.post/<rkey>
レコード      at://<did>/blue.skybind.comic/<rkey>
```

ポストのrkeyで`com.atproto.repo.getRecord`を引けば、漫画レコードを取得できます。

## フィールド

```jsonc
{
  "$type": "blue.skybind.comic",
  "subject": {                    // 漫画のルートポスト
    "uri": "at://did:plc:.../app.bsky.feed.post/3msd622mepv26",
    "cid": "bafyrei..."
  },
  "url": "https://skybind.blue/v/f3AwfKihYN",   // リーダーURL
  "posts": [                      // 任意: 作成時点のページ順スナップショット
    { "uri": "at://...", "cid": "bafyrei..." }
  ],
  "title": "作品タイトル",         // 任意
  "startSide": "left",            // 任意: 見開き時の1ページ目の位置 right | left
  "language": "ja",               // 任意
  "pageCount": 22,                // 任意: 作成時点の画像枚数
  "labels": {                     // 任意: 作品全体の自己ラベル
    "$type": "com.atproto.label.defs#selfLabels",
    "values": [{ "val": "porn" }]
  },
  "createdAt": "2026-08-05T09:00:42.465Z"
}
```

必須は`subject` / `url` / `createdAt`です。

## 取得

```ts
async function resolvePds(did: string): Promise<string> {
  const doc = await fetch(
    did.startsWith('did:plc:')
      ? `https://plc.directory/${did}`
      : `https://${did.slice('did:web:'.length)}/.well-known/did.json`,
  ).then((r) => r.json())
  return doc.service.find(
    (s: any) => s.type === 'AtprotoPersonalDataServer',
  ).serviceEndpoint
}

async function getComic(did: string, postRkey: string) {
  const pds = await resolvePds(did)
  const res = await fetch(
    `${pds}/xrpc/com.atproto.repo.getRecord?repo=${did}` +
      `&collection=blue.skybind.comic&rkey=${postRkey}`,
  )
  if (!res.ok) return null
  return (await res.json()).value
}
```

作者の作品一覧は`com.atproto.repo.listRecords`（`collection=blue.skybind.comic`）で取得できます。

フィードで全ポストを照会する場合は、[Slingshot](https://slingshot.microcosm.blue/)などの
レコードキャッシュ経由での取得を検討してください。

## 検証

レコードの存在やスキーマの管理元は、SkyBindによる個々のレコードの検証を意味しません。表示前に以下を確認してください。

- `$type`が`blue.skybind.comic`で、公開スキーマに対して構造が妥当
- レコードのリポジトリDIDと`subject`のDIDが一致
- レコードのrkeyと`subject`のrkeyが一致
- `subject.cid`が実際のポストのCIDと一致（プロフィール起点の場合も対象ポストを取得して照合）
- `posts`がある場合、`posts[0]`が`subject`とURI・CIDともに一致し、全要素が同一DIDの`app.bsky.feed.post`参照でURIに重複がない
- `url`がHTTPS

SkyBind名義のボタンとして表示する場合は、`url`のoriginが`https://skybind.blue`、
パスが`^/v/[A-Za-z0-9_-]{10}$`であることも確認してください。
一致しないものは、ドメインを明示した汎用リンクとして表示するか無視してください。

## ページの並び

`posts`は作成時点のスナップショットです。各ポストのembed
（`app.bsky.embed.images` / `app.bsky.embed.gallery`）の画像を掲載順に並べます。
画像はレコードに複製されません。

`posts`がない場合や、レコード作成後に続きが投稿された場合は、
`subject`から同一作者のセルフリプライをたどってページを収集します。

`startSide`は見開き時の1ページ目の位置で、読み進める方向とは別の値です。
画像のNSFW判定は各ポストのラベルが正で、レコードの`labels`は一覧表示用のミラーです。

## SkyBind API

リーダーが表示するページ一覧は、認証なしで取得できます。

```http
GET https://skybind.blue/api/manga/{id}
```

`id`はレコードの`url`の`/v/`以降です。

```jsonc
{
  "id": "f3AwfKihYN",
  "title": "作品タイトル",
  "pages": ["https://cdn.bsky.app/.../fullsize/...", "..."],
  "startSide": "left",
  "originalPostUri": "at://did:plc:.../app.bsky.feed.post/...",
  "hasSensitive": false,
  "author": { "did": "...", "handle": "...", "displayName": "...", "avatar": "..." },
  "recordCid": "bafyrei..."
}
```

`recordCid`はSkyBindが最後にリンクとレコードを照合した時点のCIDです。
PDS上でのレコード更新・削除を自動では反映しないため、現在のレコードを取得して再照合してください。
レコードが存在しない場合、CIDが一致しない場合、`recordCid`がない場合は未検証として扱います。

SkyBindは所有者DID、rkey、閲覧URL、レコードの構造と`posts`の整合性を検証します。
実際のポストとのCID照合は`subject`のみです。`posts`を利用するクライアントは、
各ポストを取得した際にCIDの不一致や削除を確認してください。
