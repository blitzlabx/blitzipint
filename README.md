# blitzipint

**blitzipint** is a small but solid TypeScript service that pulls downloadable media links out of public Pinterest pins.  
It talks to klickpin under the hood, grabs the result page, and extracts the real video / image / GIF URLs.

Built by **Blitz**.

---

## Why this exists

Most “Pinterest downloaders” are either browser extensions that break every other month or huge scrapers that need headless browsers and proxies.  
blitzipint keeps it simple:

- one HTTP call in
- structured JSON out
- no browser automation
- no login required
- works with normal pin URLs and pin.it short links

It’s meant for personal tools, bots, or small internal services that just need the media links.

---

## Author

- **Blitz**
- X: [https://x.com/blitzlabx](https://x.com/blitzlabx)
- GitHub: [https://github.com/blitzlabx](https://github.com/blitzlabx)

If you ship something with this, a star or a mention is appreciated but not required.

---

## Features

- Resolve single public Pinterest pins
- Batch mode (up to 12 URLs)
- Automatic CSRF handling
- Multiple extraction strategies (video tags, anchors, images, regex fallback)
- Quality scoring so the “best” link is easy to pick
- Clean error codes (`PRIVATE_OR_RESTRICTED`, `NO_MEDIA`, `INVALID_URL`, etc.)
- Ready for local Node or Vercel
- Zero external API keys

---

## Quick start

```bash
git clone <your-repo>
cd blitzipint
npm install
npm run dev
```

Server starts on `http://0.0.0.0:3000`.

Test it:

```bash
curl "http://localhost:3000/api/media?url=https://www.pinterest.com/pin/664281013778109217/"
```

Or run the built-in test:

```bash
npm run test
```

---

## API

### `GET /`

Basic info + endpoint list.

### `GET /health`

Liveness + version + memory stats.

### `GET /api/info`

Longer description of capabilities and limits.

### `GET /api/media?url=<pinterest_url>`

### `POST /api/media`

```json
{ "url": "https://www.pinterest.com/pin/..." }
```

Returns a full `BlitzResult` object.

### `GET /api/resolve?url=...`

Alias of the media endpoint.

### `GET /api/best?url=...`

Same resolution but only returns the highest-scoring media item.

### `POST /api/batch`

```json
{
  "urls": [
    "https://www.pinterest.com/pin/111/",
    "https://pin.it/abc"
  ],
  "concurrency": 2
}
```

Max 12 URLs. Returns an array of results plus a short summary.

### `GET /api/filename?url=...`

Resolves the pin and suggests download filenames.

### `GET /api/retry?url=...&retries=1`

Tries the same pin again on failure (useful for flaky upstream responses).

### `GET /api/ping` / `GET /api/version` / `GET /api/stats`

Small utility routes.

---

## Response shape

```json
{
  "ok": true,
  "input": "https://www.pinterest.com/pin/664281013778109217/",
  "title": "...",
  "medias": [
    {
      "type": "video",
      "url": "https://v1.pinimg.com/videos/mc/720p/....mp4",
      "quality": "720p",
      "source": "video-tag",
      "score": 78,
      "poster": "https://i.pinimg.com/..."
    }
  ],
  "best": { ... },
  "thumbnail": "...",
  "tookMs": 1840,
  "engine": "blitzipint",
  "author": "Blitz"
}
```

On failure:

```json
{
  "ok": false,
  "error": "no downloadable media found for this pin",
  "code": "NO_MEDIA",
  "engine": "blitzipint",
  "author": "Blitz"
}
```

---

## How it works (short version)

1. Fetch a CSRF token from klickpin’s token endpoint.
2. POST the Pinterest URL to their download form.
3. Parse the returned HTML with several collectors:
   - `<video>` / `<source>` tags
   - anchor tags (including their download proxy links)
   - high-res `i.pinimg.com` images
   - regex sweep for any remaining pinimg URLs
4. Score each media item and sort.
5. Return the list.

No media is downloaded or stored by blitzipint itself — it only returns the direct CDN links.

---

## Environment variables

| Variable         | Default | Meaning                          |
|------------------|---------|----------------------------------|
| `PORT`           | 3000    | HTTP port                        |
| `HOST`           | 0.0.0.0 | Bind address                     |
| `BLITZ_TIMEOUT`  | 22000   | Upstream request timeout (ms)    |
| `LOG_LEVEL`      | info    | Fastify log level                |
| `VERCEL`         | –       | Set automatically on Vercel      |

---

## Deploy on Vercel

blitzipint is written so it works both as a normal Node server and as a Vercel Function.

```bash
npm i -g vercel
vercel login
cd blitzipint
vercel
vercel --prod
```

Or connect the GitHub repo in the Vercel dashboard.  
The entry file is `src/index.ts`, which matches Vercel’s Fastify detection.

---

## Local development tips

```bash
npm run dev          # tsx watch-style run
npm run build        # tsc → dist/
npm start            # node dist/index.js
npm run test         # live test against a known public pin
```

If the upstream site changes their form or HTML structure, most of the work will be in `src/scraper.ts` (the collectors and the CSRF helper).

---

## Limits & reality check

- Only **public** pins work.
- Private, invitation-only, or deleted pins will return an error code.
- Quality is whatever Pinterest (via klickpin) actually serves. There is no upscaling.
- Don’t hammer the upstream service. Add your own rate limiting if you expose this publicly.
- This is not affiliated with Pinterest or klickpin.

---

## Project layout

```
blitzipint/
├── package.json
├── tsconfig.json
├── README.md
└── src/
    ├── index.ts      # Fastify server + routes
    ├── scraper.ts    # core resolver & parsers
    └── test.ts       # quick live test
```

---

## Changelog (short)

- **1.2.4** – current public version, expanded collectors, batch, filename helpers, Vercel-ready
- earlier internal builds used for testing the klickpin flow

---

## License

MIT

---

Made by Blitz · @blitzlabx
