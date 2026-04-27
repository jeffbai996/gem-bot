# fetch_url Tool — Design

**Date:** 2026-04-27
**Status:** Approved (auto mode)

## Motivation

`googleSearch` (built-in Gemini tool) returns synthesized snippets. When the user pastes a URL — a 10-K, a SeekingAlpha post, a tweet thread, a docs page — they often want Gemma to actually read the page, not paraphrase what Google already paraphrased. Add a `fetch_url` tool that downloads and extracts main text content.

## Goals

1. Tool registered as `fetch_url` in the tool registry.
2. Args: `{url: string, maxChars?: number}`. URL required.
3. HTML → main article text via `@mozilla/readability` + `jsdom`. Plain text and markdown pass-through. JSON pretty-printed.
4. SSRF defenses: reject non-http(s) schemes; reject private IP ranges before connect.
5. Resource caps: 15s timeout, 5MB body cap, max 5 redirects, default maxChars=8000 (hard cap 50000).
6. Output format: `# <title>\n<url>\n\n<content>` so the model has source attribution inline.
7. Tests: all local; no live internet calls.

## Non-Goals (Stashed)

- Headless browser / JS-rendered page support.
- Auth, cookies, custom headers.
- Caching of fetched content.
- robots.txt enforcement (the model won't fetch a URL the user didn't paste; user-instigated fetches are out of scope for robots.txt).
- PDF text extraction (return "unsupported" for now).

## Architecture

### Module layout

```
src/tools/
  fetch-url.ts            — fetchUrlTool: Tool, plus exported helpers for tests
  fetch-url-internal.ts   — pure helpers: validateUrl, isPrivateIp, extractContent, truncate
src/tools/index.ts        — registers fetchUrlTool after searchMemoryTool
tests/tools/
  fetch-url-internal.test.ts  — pure-function tests (no network)
  fetch-url.test.ts           — integration tests against a local HTTP server
```

The split keeps the SSRF / extraction logic testable without spinning up an HTTP server.

### Dependencies

Add: `@mozilla/readability`, `jsdom`. Both pin-acceptable npm versions.

### Interfaces

```typescript
// src/tools/fetch-url-internal.ts
export interface ValidatedUrl { url: URL }
export function validateUrl(raw: string): ValidatedUrl   // throws on invalid scheme
export function isPrivateIp(host: string): boolean       // for resolved IPs
export interface ExtractedContent {
  title: string | null
  body: string
  contentType: 'html' | 'text' | 'markdown' | 'json' | 'unsupported'
}
export function extractContent(buffer: Buffer, contentType: string, url: string): ExtractedContent
export function truncate(s: string, maxChars: number): string
```

```typescript
// src/tools/fetch-url.ts
import type { Tool } from './registry.ts'
export const fetchUrlTool: Tool = {
  name: 'fetch_url',
  declaration: {
    name: 'fetch_url',
    description: '...',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        url: { type: STRING, description: 'http(s) URL to fetch and extract main text from' },
        maxChars: { type: NUMBER, description: 'Optional max chars in output. Default 8000, hard cap 50000.' }
      },
      required: ['url']
    }
  },
  async execute(args, _ctx) { /* validate -> fetch -> extract -> truncate -> format */ }
}
```

### SSRF defense

Two-stage:

1. **Scheme allowlist**: only `http:` and `https:`. Anything else throws "unsupported scheme".
2. **Pre-connect IP check**: resolve hostname via `dns.lookup`. If it resolves to a private/loopback range, throw "blocked: private network address".

Private ranges (IPv4): `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `127.0.0.0/8`, `169.254.0.0/16` (link-local), `0.0.0.0/8`.
IPv6: `::1`, `fc00::/7` (ULA), `fe80::/10` (link-local), `::ffff:0:0/96` (mapped IPv4 — apply IPv4 rules to the embedded address).

This still has a TOCTOU window (DNS could rebind between check and fetch), but for our threat model — Gemma running on a single-user box with no sensitive private services on `localhost` other than IBKR MCP and possibly the bot itself — it's adequate. We log every fetch with the resolved IP for forensic visibility.

### Fetch behavior

Use Node's built-in `fetch` (Node 18+):

```typescript
const res = await fetch(url, {
  signal: AbortSignal.timeout(15_000),
  redirect: 'follow',  // up to 5 by default in undici
  headers: {
    'User-Agent': 'gemma-discord-bot/1.0 (+https://github.com/jeffbai/gem-discord-bot)',
    'Accept': 'text/html,text/plain,text/markdown,application/json,*/*;q=0.8'
  }
})
```

After receiving response: stream body with a 5MB cap; abort if exceeded.

### Content extraction

Decision tree on `Content-Type` header:
- `text/html` (or response that looks like HTML by sniffing first bytes): `new JSDOM(html).window.document` → `new Readability(doc).parse()` → use `.title` and `.textContent`.
- `text/plain` / `text/markdown` / `text/*`: use raw decoded text.
- `application/json`: parse + `JSON.stringify(parsed, null, 2)`.
- Anything else: return `{ contentType: 'unsupported', body: `[unsupported content type: ${type}]`, title: null }`.

### Output format

```
# <title>
<url>

<truncated content>

[truncated to N chars]   # only if truncation happened
```

Title is omitted if extraction didn't find one (plain text, JSON).

### Errors

| Failure | Returned string |
|---|---|
| invalid URL | `"fetch_url: invalid URL"` |
| unsupported scheme | `"fetch_url: only http/https URLs are allowed"` |
| private IP | `"fetch_url: refusing to fetch private network address"` |
| DNS failure | `"fetch_url: could not resolve host"` |
| connect refused | `"fetch_url: connection refused"` |
| timeout | `"fetch_url: timed out after 15s"` |
| body too large | `"fetch_url: response body exceeded 5MB cap"` |
| HTTP 4xx/5xx | `"fetch_url: HTTP <status> <statusText>"` |
| extraction failed | `"fetch_url: could not extract content"` |

All caught and returned as strings — `ToolRegistry.dispatch` doesn't see exceptions.

## Tests

`fetch-url-internal.test.ts`:
- `validateUrl` rejects ftp://, file://, javascript:, malformed strings; accepts http(s).
- `isPrivateIp` returns true for the listed ranges, false for public IPs.
- `extractContent`: HTML article extraction yields title + body. Plain text passes through. JSON pretty-prints. Unknown returns unsupported.
- `truncate`: under-cap unchanged; over-cap returns first N chars + truncation note.

`fetch-url.test.ts`:
- Local HTTP server on a random port serves test fixtures.
- Test: 200 HTML article → returns extracted text with title.
- Test: 200 plain text → returns text body.
- Test: 200 JSON → returns formatted JSON.
- Test: 404 → returns "HTTP 404" string.
- Test: redirect chain → follows.
- Test: oversized body → returns size error.
- Test: server hang → timeout error (use a short timeout for the test).

Note on private-IP testing: localhost (127.0.0.1) IS private. The local-server tests pass `IBKR_MCP_URL`-style URLs to a `127.0.0.1` server, which the SSRF check would block. Solution: the SSRF check has a `_allowPrivate?: boolean` test-only flag (set via env var `FETCH_URL_TESTING_ALLOW_PRIVATE=1` so it can't be flipped by accident in production).

## Migration plan

1. `npm install @mozilla/readability jsdom @types/jsdom`.
2. Implement `fetch-url-internal.ts` + tests.
3. Implement `fetch-url.ts` + tests against local server.
4. Register in `buildDefaultRegistry()` between `searchMemory` and IBKR.
5. Run full suite. Done.

## Open questions resolved

- **Why not headless browser?** YAGNI. Vast majority of pages we'd want to fetch (10-Ks, blogs, docs) work fine with static HTML.
- **Why allow `_allowPrivate` flag at all?** To make the local-server tests work without spinning up a public DNS endpoint. Production never sets this.
- **Why hard cap maxChars at 50000?** Gemma's context budget already limits this elsewhere; this just protects against the model passing `maxChars: 1000000`.
