# fetch_url Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Add a `fetch_url` tool that downloads a URL and returns extracted main text. SSRF-defended, body-capped, integrated into the existing tool registry.

**Spec:** `docs/superpowers/specs/2026-04-27-fetch-url-tool-design.md`

**Tech Stack:** TypeScript, Node 22, `@mozilla/readability`, `jsdom`, `node:test`.

---

## Files

**New:**
- `src/tools/fetch-url-internal.ts` — pure helpers.
- `src/tools/fetch-url.ts` — the Tool itself.
- `tests/tools/fetch-url-internal.test.ts`
- `tests/tools/fetch-url.test.ts`

**Modified:**
- `src/tools/index.ts` — register the new tool.
- `package.json` — add deps.

---

## Task 1: Install deps

- [ ] **Step 1**: `npm install @mozilla/readability jsdom @types/jsdom`
- [ ] **Step 2**: Smoke import:
  ```bash
  node --import tsx -e "import('@mozilla/readability').then(m=>console.log('ok',Object.keys(m).slice(0,3)))"
  node --import tsx -e "import('jsdom').then(m=>console.log('ok',Object.keys(m).slice(0,3)))"
  ```
- [ ] **Step 3**: Commit:
  ```bash
  git add package.json package-lock.json
  git commit -m "chore: add @mozilla/readability and jsdom for fetch_url"
  ```

---

## Task 2: Pure internal helpers + tests

- [ ] **Step 1**: Create `tests/tools/fetch-url-internal.test.ts`:

```typescript
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { validateUrl, isPrivateIp, extractContent, truncate } from '../../src/tools/fetch-url-internal.ts'

describe('validateUrl', () => {
  test('accepts http and https', () => {
    assert.equal(validateUrl('http://example.com').url.protocol, 'http:')
    assert.equal(validateUrl('https://example.com').url.protocol, 'https:')
  })
  test('rejects ftp', () => { assert.throws(() => validateUrl('ftp://example.com'), /scheme/) })
  test('rejects file', () => { assert.throws(() => validateUrl('file:///etc/passwd'), /scheme/) })
  test('rejects javascript', () => { assert.throws(() => validateUrl('javascript:alert(1)'), /scheme/) })
  test('rejects malformed', () => { assert.throws(() => validateUrl('not a url'), /invalid/i) })
})

describe('isPrivateIp', () => {
  test('IPv4 private ranges', () => {
    assert.equal(isPrivateIp('10.0.0.1'), true)
    assert.equal(isPrivateIp('10.255.255.255'), true)
    assert.equal(isPrivateIp('172.16.0.1'), true)
    assert.equal(isPrivateIp('172.31.255.255'), true)
    assert.equal(isPrivateIp('192.168.1.1'), true)
    assert.equal(isPrivateIp('127.0.0.1'), true)
    assert.equal(isPrivateIp('169.254.1.1'), true)
    assert.equal(isPrivateIp('0.0.0.0'), true)
  })
  test('IPv4 public', () => {
    assert.equal(isPrivateIp('8.8.8.8'), false)
    assert.equal(isPrivateIp('172.32.0.1'), false)  // just outside 172.16/12
    assert.equal(isPrivateIp('172.15.255.255'), false)  // just below
    assert.equal(isPrivateIp('1.1.1.1'), false)
  })
  test('IPv6 private', () => {
    assert.equal(isPrivateIp('::1'), true)
    assert.equal(isPrivateIp('fc00::1'), true)
    assert.equal(isPrivateIp('fd00::1'), true)
    assert.equal(isPrivateIp('fe80::1'), true)
  })
  test('IPv6 public', () => {
    assert.equal(isPrivateIp('2606:4700:4700::1111'), false)
  })
  test('IPv4-mapped IPv6 falls through to IPv4 check', () => {
    assert.equal(isPrivateIp('::ffff:127.0.0.1'), true)
    assert.equal(isPrivateIp('::ffff:8.8.8.8'), false)
  })
})

describe('extractContent', () => {
  test('HTML article extraction', () => {
    const html = `<html><head><title>Test</title></head><body><article><h1>Hello</h1><p>This is the article body with enough content to look like a real article. Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.</p></article></body></html>`
    const out = extractContent(Buffer.from(html, 'utf8'), 'text/html', 'https://example.com')
    assert.equal(out.contentType, 'html')
    assert.match(out.body, /article body/)
  })
  test('plain text passes through', () => {
    const out = extractContent(Buffer.from('hello world\n'), 'text/plain', 'https://x')
    assert.equal(out.contentType, 'text')
    assert.equal(out.body.trim(), 'hello world')
  })
  test('markdown passes through', () => {
    const out = extractContent(Buffer.from('# Hi\n\nbody'), 'text/markdown', 'https://x')
    assert.equal(out.contentType, 'markdown')
    assert.match(out.body, /# Hi/)
  })
  test('JSON pretty-prints', () => {
    const out = extractContent(Buffer.from('{"a":1,"b":[2,3]}'), 'application/json', 'https://x')
    assert.equal(out.contentType, 'json')
    assert.match(out.body, /"a": 1/)
  })
  test('unsupported content-type', () => {
    const out = extractContent(Buffer.from('binary'), 'application/octet-stream', 'https://x')
    assert.equal(out.contentType, 'unsupported')
    assert.match(out.body, /unsupported/i)
  })
})

describe('truncate', () => {
  test('under cap unchanged', () => {
    assert.equal(truncate('hello', 100), 'hello')
  })
  test('over cap appends note', () => {
    const long = 'x'.repeat(200)
    const out = truncate(long, 50)
    assert.ok(out.startsWith('xxxxx'))
    assert.match(out, /\[truncated/)
  })
  test('exactly at cap unchanged', () => {
    const exactly = 'x'.repeat(50)
    assert.equal(truncate(exactly, 50), exactly)
  })
})
```

- [ ] **Step 2**: Run — fail.

- [ ] **Step 3**: Create `src/tools/fetch-url-internal.ts`:

```typescript
import { JSDOM } from 'jsdom'
import { Readability } from '@mozilla/readability'

export interface ValidatedUrl { url: URL }

export function validateUrl(raw: string): ValidatedUrl {
  let url: URL
  try { url = new URL(raw) } catch { throw new Error('invalid URL') }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`unsupported scheme "${url.protocol}"`)
  }
  return { url }
}

// IPv4 private/loopback/link-local ranges + IPv6 equivalents.
export function isPrivateIp(ip: string): boolean {
  // IPv4-mapped IPv6 like "::ffff:127.0.0.1" — fall through to IPv4.
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)
  if (mapped) return isPrivateIp(mapped[1])

  if (ip.includes(':')) {
    const lower = ip.toLowerCase()
    if (lower === '::1' || lower === '::') return true
    if (/^fc[0-9a-f]{2}:/.test(lower) || /^fd[0-9a-f]{2}:/.test(lower)) return true  // ULA fc00::/7
    if (/^fe[89ab][0-9a-f]:/.test(lower)) return true  // link-local fe80::/10
    return false
  }

  const parts = ip.split('.').map(p => parseInt(p, 10))
  if (parts.length !== 4 || parts.some(p => isNaN(p) || p < 0 || p > 255)) return false
  const [a, b] = parts
  if (a === 10) return true
  if (a === 127) return true
  if (a === 0) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  return false
}

export interface ExtractedContent {
  title: string | null
  body: string
  contentType: 'html' | 'text' | 'markdown' | 'json' | 'unsupported'
}

export function extractContent(buffer: Buffer, contentTypeHeader: string, url: string): ExtractedContent {
  const ct = (contentTypeHeader || '').toLowerCase().split(';')[0].trim()

  if (ct === 'text/html' || ct === 'application/xhtml+xml') {
    const html = buffer.toString('utf8')
    try {
      const dom = new JSDOM(html, { url })
      const article = new Readability(dom.window.document).parse()
      if (article && article.textContent) {
        return {
          title: article.title?.trim() || null,
          body: article.textContent.trim(),
          contentType: 'html'
        }
      }
    } catch { /* fall through */ }
    // Fallback: strip tags via DOM textContent
    try {
      const dom = new JSDOM(html)
      return {
        title: dom.window.document.title?.trim() || null,
        body: dom.window.document.body?.textContent?.trim() || '',
        contentType: 'html'
      }
    } catch {
      return { title: null, body: '[could not parse HTML]', contentType: 'unsupported' }
    }
  }

  if (ct === 'application/json' || ct.endsWith('+json')) {
    try {
      const parsed = JSON.parse(buffer.toString('utf8'))
      return { title: null, body: JSON.stringify(parsed, null, 2), contentType: 'json' }
    } catch {
      return { title: null, body: buffer.toString('utf8'), contentType: 'json' }
    }
  }

  if (ct === 'text/markdown' || ct === 'text/x-markdown') {
    return { title: null, body: buffer.toString('utf8'), contentType: 'markdown' }
  }

  if (ct.startsWith('text/')) {
    return { title: null, body: buffer.toString('utf8'), contentType: 'text' }
  }

  return { title: null, body: `[unsupported content type: ${ct || 'unknown'}]`, contentType: 'unsupported' }
}

export function truncate(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s
  return s.slice(0, maxChars) + `\n\n[truncated to ${maxChars} chars]`
}
```

- [ ] **Step 4**: Run — pass. Commit:
  ```bash
  git add src/tools/fetch-url-internal.ts tests/tools/fetch-url-internal.test.ts
  git commit -m "feat: fetch_url internal helpers (URL validation, SSRF check, extraction)"
  ```

---

## Task 3: fetchUrlTool implementation

- [ ] **Step 1**: Create `tests/tools/fetch-url.test.ts`:

```typescript
import { describe, test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'http'
import { AddressInfo } from 'net'
import { fetchUrlTool } from '../../src/tools/fetch-url.ts'

let server: http.Server
let baseUrl: string

before(async () => {
  process.env.FETCH_URL_TESTING_ALLOW_PRIVATE = '1'
  server = http.createServer((req, res) => {
    const url = new URL(req.url!, 'http://localhost')
    if (url.pathname === '/article') {
      res.setHeader('Content-Type', 'text/html')
      res.end(`<html><head><title>Test Article</title></head><body><article><h1>Hi</h1><p>Body of article. ${'word '.repeat(40)}</p></article></body></html>`)
    } else if (url.pathname === '/text') {
      res.setHeader('Content-Type', 'text/plain')
      res.end('hello plain text')
    } else if (url.pathname === '/json') {
      res.setHeader('Content-Type', 'application/json')
      res.end('{"foo":"bar"}')
    } else if (url.pathname === '/404') {
      res.statusCode = 404
      res.end('not found')
    } else if (url.pathname === '/redirect') {
      res.statusCode = 302
      res.setHeader('Location', '/article')
      res.end()
    } else if (url.pathname === '/big') {
      res.setHeader('Content-Type', 'text/plain')
      // Stream 10MB
      const chunk = Buffer.alloc(1024 * 1024, 'x')
      let sent = 0
      const send = () => {
        if (sent >= 10) { res.end(); return }
        sent++
        res.write(chunk, send)
      }
      send()
    } else if (url.pathname === '/hang') {
      // Never respond
    } else {
      res.statusCode = 500
      res.end()
    }
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
  const port = (server.address() as AddressInfo).port
  baseUrl = `http://127.0.0.1:${port}`
})

after(() => {
  server.close()
  delete process.env.FETCH_URL_TESTING_ALLOW_PRIVATE
})

describe('fetchUrlTool', () => {
  test('declaration shape', () => {
    assert.equal(fetchUrlTool.name, 'fetch_url')
    assert.deepEqual(fetchUrlTool.declaration.parameters?.required, ['url'])
  })

  test('extracts HTML article with title', async () => {
    const out = await fetchUrlTool.execute({ url: `${baseUrl}/article` }, {} as any)
    assert.match(out, /Test Article/)
    assert.match(out, /Body of article/)
  })

  test('plain text body returned', async () => {
    const out = await fetchUrlTool.execute({ url: `${baseUrl}/text` }, {} as any)
    assert.match(out, /hello plain text/)
  })

  test('JSON pretty-printed', async () => {
    const out = await fetchUrlTool.execute({ url: `${baseUrl}/json` }, {} as any)
    assert.match(out, /"foo": "bar"/)
  })

  test('404 returns HTTP error string', async () => {
    const out = await fetchUrlTool.execute({ url: `${baseUrl}/404` }, {} as any)
    assert.match(out, /HTTP 404/)
  })

  test('follows redirect', async () => {
    const out = await fetchUrlTool.execute({ url: `${baseUrl}/redirect` }, {} as any)
    assert.match(out, /Body of article/)
  })

  test('oversized response returns size error', async () => {
    const out = await fetchUrlTool.execute({ url: `${baseUrl}/big` }, {} as any)
    assert.match(out, /5MB/)
  })

  test('invalid URL returns error string', async () => {
    const out = await fetchUrlTool.execute({ url: 'not a url' }, {} as any)
    assert.match(out, /invalid URL/i)
  })

  test('non-http scheme returns error string', async () => {
    const out = await fetchUrlTool.execute({ url: 'ftp://example.com' }, {} as any)
    assert.match(out, /scheme/i)
  })

  test('private IP rejected when not in test mode', async () => {
    delete process.env.FETCH_URL_TESTING_ALLOW_PRIVATE
    const out = await fetchUrlTool.execute({ url: `${baseUrl}/text` }, {} as any)
    assert.match(out, /private network/i)
    process.env.FETCH_URL_TESTING_ALLOW_PRIVATE = '1'
  })

  test('respects maxChars cap', async () => {
    const out = await fetchUrlTool.execute({ url: `${baseUrl}/article`, maxChars: 50 }, {} as any)
    assert.match(out, /\[truncated/)
  })
})
```

- [ ] **Step 2**: Run — fail.

- [ ] **Step 3**: Create `src/tools/fetch-url.ts`:

```typescript
import { SchemaType } from '@google/generative-ai'
import dns from 'dns/promises'
import type { Tool } from './registry.ts'
import { validateUrl, isPrivateIp, extractContent, truncate } from './fetch-url-internal.ts'

const DEFAULT_MAX_CHARS = 8000
const HARD_MAX_CHARS = 50_000
const FETCH_TIMEOUT_MS = 15_000
const MAX_BODY_BYTES = 5 * 1024 * 1024

async function readBodyWithCap(res: Response): Promise<Buffer | null> {
  if (!res.body) return Buffer.alloc(0)
  const reader = (res.body as any).getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    if (!value) continue
    total += value.byteLength
    if (total > MAX_BODY_BYTES) {
      try { reader.cancel() } catch { /* noop */ }
      return null
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks.map(c => Buffer.from(c)))
}

export const fetchUrlTool: Tool = {
  name: 'fetch_url',
  declaration: {
    name: 'fetch_url',
    description: 'Fetch a URL and return its main text content. Use when the user pastes a link or asks you to read a webpage. Supports HTML (article extraction), plain text, markdown, and JSON. Returns up to 8000 chars by default.',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        url: { type: SchemaType.STRING, description: 'http(s) URL to fetch' },
        maxChars: { type: SchemaType.NUMBER, description: 'Optional cap on output size in characters. Default 8000, hard cap 50000.' }
      },
      required: ['url']
    }
  },
  async execute(args, _ctx) {
    const rawUrl = args.url
    if (typeof rawUrl !== 'string') return 'fetch_url: url argument must be a string'
    const requestedMax = typeof args.maxChars === 'number' ? args.maxChars : DEFAULT_MAX_CHARS
    const maxChars = Math.min(Math.max(100, requestedMax), HARD_MAX_CHARS)

    let url: URL
    try { url = validateUrl(rawUrl).url } catch (e: any) {
      return `fetch_url: ${e.message ?? 'invalid URL'}`
    }

    // SSRF: resolve hostname, check IP. Skipped only when test env var is set.
    if (process.env.FETCH_URL_TESTING_ALLOW_PRIVATE !== '1') {
      try {
        const lookups = await dns.lookup(url.hostname, { all: true })
        for (const l of lookups) {
          if (isPrivateIp(l.address)) {
            return 'fetch_url: refusing to fetch private network address'
          }
        }
      } catch (e: any) {
        return `fetch_url: could not resolve host (${e?.code ?? e?.message ?? 'DNS failure'})`
      }
    }

    let res: Response
    try {
      res = await fetch(url.toString(), {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        redirect: 'follow',
        headers: {
          'User-Agent': 'gemma-discord-bot/1.0',
          'Accept': 'text/html,text/plain,text/markdown,application/json,*/*;q=0.8'
        }
      })
    } catch (e: any) {
      const msg = e?.message ?? String(e)
      if (e?.name === 'TimeoutError' || /timeout/i.test(msg)) return 'fetch_url: timed out after 15s'
      if (/refused/i.test(msg)) return 'fetch_url: connection refused'
      return `fetch_url: ${msg}`
    }

    if (!res.ok) {
      return `fetch_url: HTTP ${res.status} ${res.statusText}`
    }

    const buf = await readBodyWithCap(res)
    if (buf === null) return 'fetch_url: response body exceeded 5MB cap'

    const ctHeader = res.headers.get('content-type') ?? ''
    const extracted = extractContent(buf, ctHeader, url.toString())
    const titleLine = extracted.title ? `# ${extracted.title}\n` : ''
    const head = `${titleLine}${url.toString()}\n\n`
    return head + truncate(extracted.body, maxChars)
  }
}
```

- [ ] **Step 4**: Run — pass. Commit:
  ```bash
  git add src/tools/fetch-url.ts tests/tools/fetch-url.test.ts
  git commit -m "feat: fetch_url tool — fetch URL + extract main text"
  ```

---

## Task 4: Register in default registry

- [ ] **Step 1**: Edit `src/tools/index.ts` to register `fetchUrlTool` after `searchMemoryTool`:

```typescript
import { fetchUrlTool } from './fetch-url.ts'
// ...
r.register(searchMemoryTool)
r.register(fetchUrlTool)
// ... then IBKR block as before
```

- [ ] **Step 2**: Run full tests; smoke registry registers all 3 base tools (search_memory, fetch_url, ibkr fallback).
- [ ] **Step 3**: Update the smoke test in `tests/tools/registry.test.ts` if it asserts specific count of pre-IBKR tools — it currently asserts `names[0] === 'search_memory'` and at least 2 tools total. With fetch_url, there are now at least 3 tools. Update assertion to `names.length >= 3` and add `assert.ok(names.includes('fetch_url'))`.
- [ ] **Step 4**: Commit:
  ```bash
  git add src/tools/index.ts tests/tools/registry.test.ts
  git commit -m "feat: register fetch_url in default registry"
  ```

---

## Task 5: Final verification

- [ ] **Step 1**: `npm run test` — all green.
- [ ] **Step 2**: Smoke-load: `node --import tsx -e "import('./src/tools/index.ts').then(m=>m.buildDefaultRegistry()).then(r=>console.log(r.getDeclarations().map(d=>d.name)))"`
  Expected: includes `search_memory`, `fetch_url`, plus IBKR fallback.
- [ ] **Step 3**: Done.

---

## Out of Scope
Headless browser, auth/cookies, caching, robots.txt, PDF text extraction.
