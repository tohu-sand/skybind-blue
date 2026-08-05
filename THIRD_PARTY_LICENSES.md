# Third-Party Licenses

This file lists third-party software used by this repository (direct
dependencies bundled into the built site or the Pages Functions worker, and
resources loaded at runtime) and provides their license texts and required
notices. The complete list of npm packages included in the production build,
including transitive dependencies, is kept in `public/THIRD_PARTY_NOTICES.txt`
and served by the site at `/THIRD_PARTY_NOTICES.txt`.

## Packages By License

### MIT

- @atproto/api@0.20.11 (npm, bundled into the client) — Copyright (c) 2022-2026 Bluesky Social PBC, and Contributors
- @atproto/oauth-client-browser@0.4.1 (npm, bundled into the client) — Copyright (c) 2022-2026 Bluesky Social PBC, and Contributors
- @noble/curves@2.2.0 (npm, bundled into the worker) — Copyright (c) 2022 Paul Miller (https://paulmillr.com)
- @scure/base@2.2.0 (npm, bundled into the worker) — Copyright (c) 2022 Paul Miller (https://paulmillr.com)
- hono@4.11.1 (npm, bundled into the worker) — Copyright (c) 2021 - present, Yusuke Wada and Hono contributors
- react@18.3.1 (npm, bundled into the client) — Copyright (c) Facebook, Inc. and its affiliates
- react-dom@18.3.1 (npm, bundled into the client) — Copyright (c) Facebook, Inc. and its affiliates
- react-router-dom@6.30.2 (npm, bundled into the client) — Copyright (c) React Training LLC 2015-2019, Copyright (c) Remix Software Inc. 2020-2021, Copyright (c) Shopify Inc. 2022-2023

### OFL-1.1

- IBM Plex Sans (loaded at runtime from Google Fonts) — Copyright © 2017 IBM Corp. with Reserved Font Name "Plex"
- Zen Kaku Gothic Antique (loaded at runtime from Google Fonts) — Copyright 2021 The Zen Project Authors

## License Texts

### MIT

```text
MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### OFL-1.1

The webfonts are not distributed with this repository; the site links to them
at runtime via Google Fonts. Both families are licensed under the SIL Open
Font License, Version 1.1. The full license text is available at
https://openfontlicense.org/open-font-license-official-text/ and from each
family's page on Google Fonts.
