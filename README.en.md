# SkyBind

A spread-view comic reader and uploader for Bluesky.

Live at **https://skybind.blue/**

[日本語](README.md) | English

---

![SkyBind viewer showing a two-page spread](docs/screenshot.jpg)

SkyBind is a viewer that lets you read comic threads posted on
[Bluesky](https://bsky.app/) as two-page spreads. An author signs in with their Bluesky account, points
SkyBind at one of their posts, and gets a short viewer URL like
`https://skybind.blue/v/xxxxxxxxxx` to share. Readers who open the link read
the pages in a spread layout.

For comics that have not been posted yet, SkyBind also ships with an
**uploader**. It handles client-side compression, splitting the pages into a
thread of up to 10 images per post, and issuing the viewer URL in one go, so
even many-page comics can be posted to Bluesky comfortably.

A short introduction article (in Japanese) is available on the author's blog:
https://tohu-sand.com/blog/2025-12-23/

## How it works

- The viewer fetches the thread live from Bluesky's public API and displays
  the images in it. Image binaries are never stored or proxied by the server;
  the database keeps only minimal metadata (link id, author DID, post URI,
  title, reading direction).
- Viewer links can only be created by the author of the post, verified via
  AT Protocol OAuth. OAuth tokens live in the browser only and are never sent
  to the server.
- The uploader posts images directly from the browser to Bluesky, splitting
  them into a thread (up to 10 images per post; 5 or more images in a post use
  the gallery/carousel embed, 4 or fewer use the classic grid embed). Images
  are compressed client-side to fit Bluesky's 2 MB blob limit.
- An `/embed/:id` route provides a compact viewer suitable for embedding in
  external pages.
- When a link is created, the comic's metadata is recorded in the author's own
  Bluesky account as a public `blue.skybind.comic` record. See the
  [integration guide](docs/integration.md) (in Japanese) for how third-party
  clients can consume it.

## Stack

- Frontend: React + Vite + Tailwind CSS (`src/client/`)
- Backend: Hono on Cloudflare Pages Functions (`src/server/`, `functions/`)
- Database: Cloudflare D1 (`schema.sql`)
- Auth: AT Protocol OAuth (`@atproto/oauth-client-browser`)

## Development

Requirements: Node.js 22, npm

```sh
npm install
cp .dev.vars.example .dev.vars

# client-only dev server (no API)
npm run dev

# full stack: build, apply the D1 schema locally, then serve with wrangler
npm run build
npm run db:apply
npx wrangler pages dev dist --port 8788
```

Login from `127.0.0.1` works through the OAuth loopback client. For testing
uploads (blob scopes) reliably, expose the dev server through a tunnel such as
`cloudflared tunnel --url http://127.0.0.1:8788`.

## Deploying your own instance

1. Create a D1 database (`npx wrangler d1 create skybind-db`) and put its id
   into `wrangler.toml`.
2. Change `APP_URL` in `wrangler.toml` to your domain, and replace every
   `https://skybind.blue` URL in `public/client-metadata.json` with your
   domain. The OAuth client metadata must be served from the exact URL given
   as `client_id`, so the uploader will not work until this matches.
3. Apply the schema and deploy:

```sh
npm run db:apply:remote
npm run build
npm run deploy
```

## License

This project is released under the MIT License. See the [LICENSE](LICENSE)
file for details.

The manga artwork contained in the screenshot (`docs/screenshot.jpg`) is
© tohu_sand and is not covered by the MIT License. All rights reserved.

For the licenses of the third-party software SkyBind uses (@atproto/api,
@atproto/oauth-client-browser, Hono, React, React Router, webfonts), see
[THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md).
