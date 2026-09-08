import { Type } from '@google/genai'
import dns from 'dns/promises'
import type { LookupAddress } from 'node:dns'
import { Agent, fetch as undiciFetch } from 'undici'
import type { Tool } from './registry.ts'
import { validateUrl, isPrivateIp, extractContent, truncate } from './fetch-url-internal.ts'

const DEFAULT_MAX_CHARS = 8000
const HARD_MAX_CHARS = 50_000
const FETCH_TIMEOUT_MS = 15_000
const MAX_BODY_BYTES = 5 * 1024 * 1024

type LookupAll = (
  hostname: string,
  options: { all: true, verbatim: true },
) => Promise<LookupAddress[]>

export interface FetchUrlDependencies {
  lookup?: LookupAll
}

function normalizedHostname(value: string): string {
  return value.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase()
}

export function makePinnedLookup(hostname: string, records: LookupAddress[]) {
  const expected = normalizedHostname(hostname)
  return ((requested: string, options: any, callback: (...args: any[]) => void) => {
    if (normalizedHostname(requested) !== expected) {
      const error = Object.assign(new Error('pinned DNS hostname mismatch'), { code: 'ENOTFOUND' })
      callback(error)
      return
    }
    const family = typeof options === 'object' ? Number(options?.family) || 0 : Number(options) || 0
    const eligible = family === 4 || family === 6
      ? records.filter(record => record.family === family)
      : records
    if (eligible.length === 0) {
      const error = Object.assign(new Error('no pinned address for requested family'), { code: 'ENOTFOUND' })
      callback(error)
      return
    }
    if (typeof options === 'object' && options?.all) callback(null, eligible)
    else callback(null, eligible[0].address, eligible[0].family)
  }) as any
}

async function resolvePublicAddresses(hostname: string, lookup: LookupAll): Promise<LookupAddress[]> {
  const records = await lookup(normalizedHostname(hostname), { all: true, verbatim: true })
  if (!records.length) throw new Error('DNS returned no addresses')
  if (process.env.FETCH_URL_TESTING_ALLOW_PRIVATE !== '1') {
    if (records.some(record => isPrivateIp(record.address))) {
      throw new Error('refusing to fetch private network address')
    }
  }
  return records
}

function pinnedAgent(hostname: string, records: LookupAddress[]): Agent {
  return new Agent({
    connect: { lookup: makePinnedLookup(hostname, records) },
    autoSelectFamily: records.length > 1,
  })
}

// Stream the response body with a hard byte cap. Returns null if the cap is
// exceeded, otherwise the full buffer.
async function readBodyWithCap(
  res: Awaited<ReturnType<typeof undiciFetch>>,
): Promise<Buffer | null> {
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

export function makeFetchUrlTool(deps: FetchUrlDependencies = {}): Tool {
  const lookup: LookupAll = deps.lookup ?? ((hostname, options) => dns.lookup(hostname, options))
  return {
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

    // Manual redirect handling: re-validate EVERY hop so a 3xx Location can't
    // bounce us to an internal/metadata address. The approved DNS answers are
    // pinned into this hop's socket lookup, closing DNS-rebinding TOCTOU.
    const MAX_REDIRECTS = 5
    let current = url
    try {
      for (let hop = 0; ; hop++) {
        let records: LookupAddress[]
        try {
          records = await resolvePublicAddresses(current.hostname, lookup)
        } catch (e: any) {
          const detail = e?.code ?? e?.message ?? 'DNS failure'
          return `fetch_url: could not resolve public host (${detail})`
        }
        const dispatcher = pinnedAgent(current.hostname, records)
        try {
          const res = await undiciFetch(current.toString(), {
            dispatcher,
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
            redirect: 'manual',
            headers: {
              'User-Agent': 'gemma-discord-bot/1.0',
              'Accept': 'text/html,text/plain,text/markdown,application/json,*/*;q=0.8'
            }
          })
          const loc = res.headers.get('location')
          if (res.status >= 300 && res.status < 400 && loc) {
            await res.body?.cancel()
            if (hop >= MAX_REDIRECTS) return 'fetch_url: too many redirects'
            let next: URL
            try { next = validateUrl(new URL(loc, current).toString()).url }
            catch (e: any) { return `fetch_url: invalid redirect target (${e?.message ?? 'bad URL'})` }
            current = next
            continue
          }

          if (!res.ok) {
            await res.body?.cancel()
            return `fetch_url: HTTP ${res.status} ${res.statusText}`
          }

          const buf = await readBodyWithCap(res)
          if (buf === null) return 'fetch_url: response body exceeded 5MB cap'

          const ctHeader = res.headers.get('content-type') ?? ''
          const extracted = extractContent(buf, ctHeader, current.toString())
          const titleLine = extracted.title ? `# ${extracted.title}\n` : ''
          const head = `${titleLine}${url.toString()}\n\n`
          return head + truncate(extracted.body, maxChars)
        } finally {
          await dispatcher.destroy().catch(() => {})
        }
      }
    } catch (e: any) {
      const msg = e?.message ?? String(e)
      if (e?.name === 'TimeoutError' || /timeout/i.test(msg)) return 'fetch_url: timed out after 15s'
      if (/refused/i.test(msg)) return 'fetch_url: connection refused'
      return `fetch_url: ${msg}`
    }
  },
  }
}

export const fetchUrlTool = makeFetchUrlTool()
