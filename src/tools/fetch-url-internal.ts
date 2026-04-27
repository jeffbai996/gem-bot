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

// IPv4 private/loopback/link-local + IPv6 equivalents.
export function isPrivateIp(ip: string): boolean {
  // IPv4-mapped IPv6 like "::ffff:127.0.0.1" — fall through to IPv4 check.
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)
  if (mapped) return isPrivateIp(mapped[1])

  if (ip.includes(':')) {
    const lower = ip.toLowerCase()
    if (lower === '::1' || lower === '::') return true
    if (/^fc[0-9a-f]{2}:/.test(lower) || /^fd[0-9a-f]{2}:/.test(lower)) return true  // ULA fc00::/7
    if (/^fe[89ab][0-9a-f]:/.test(lower)) return true                                  // link-local fe80::/10
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
    // Fallback: strip tags via DOM textContent.
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
