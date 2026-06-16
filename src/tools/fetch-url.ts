import { Type } from '@google/genai'
import dns from 'dns/promises'
import type { Tool } from './registry.ts'
import { validateUrl, isPrivateIp, extractContent, truncate } from './fetch-url-internal.ts'

const DEFAULT_MAX_CHARS = 8000
const HARD_MAX_CHARS = 50_000
const FETCH_TIMEOUT_MS = 15_000
const MAX_BODY_BYTES = 5 * 1024 * 1024

// Stream the response body with a hard byte cap. Returns null if the cap is
// exceeded, otherwise the full buffer.
async function readBodyWithCap(res: Response): Promise<Buffer | null> {
  if (!res.body) return Buffer.alloc(0)
  const reader = (res.body as any).getReader()
  const chunks: Buffer[] = []
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
    chunks.push(Buffer.from(value))
  }
  return Buffer.concat(chunks)
}

export const fetchUrlTool: Tool = {
  name: 'fetch_url',
  declaration: {
    name: 'fetch_url',
    description: 'Fetch a URL and return its main text content. Use when the user pastes a link or asks you to read a webpage. Supports HTML (article extraction), plain text, markdown, and JSON. Returns up to 8000 chars by default.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        url: { type: Type.STRING, description: 'http(s) URL to fetch' },
        maxChars: { type: Type.NUMBER, description: 'Optional cap on output size in characters. Default 8000, hard cap 50000.' }
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

    // SSRF guard: resolve a hostname and refuse any private address.
    const assertPublic = async (hostname: string): Promise<string | null> => {
      if (process.env.FETCH_URL_TESTING_ALLOW_PRIVATE === '1') return null
      try {
        const lookups = await dns.lookup(hostname, { all: true })
        for (const l of lookups) {
          if (isPrivateIp(l.address)) return 'fetch_url: refusing to fetch private network address'
        }
      } catch (e: any) {
        return `fetch_url: could not resolve host (${e?.code ?? e?.message ?? 'DNS failure'})`
      }
      return null
    }

    // Manual redirect handling: re-validate EVERY hop so a 3xx Location can't
    // bounce us to an internal/metadata address (SSRF via redirect).
    const MAX_REDIRECTS = 5
    let current = url
    let res: Response
    try {
      for (let hop = 0; ; hop++) {
        const ssrfErr = await assertPublic(current.hostname)
        if (ssrfErr) return ssrfErr
        res = await fetch(current.toString(), {
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
          redirect: 'manual',
          headers: {
            'User-Agent': 'gemma-discord-bot/1.0',
            'Accept': 'text/html,text/plain,text/markdown,application/json,*/*;q=0.8'
          }
        })
        const loc = res.headers.get('location')
        if (res.status >= 300 && res.status < 400 && loc) {
          if (hop >= MAX_REDIRECTS) return 'fetch_url: too many redirects'
          let next: URL
          try { next = validateUrl(new URL(loc, current).toString()).url }
          catch (e: any) { return `fetch_url: invalid redirect target (${e?.message ?? 'bad URL'})` }
          current = next
          continue
        }
        break
      }
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
