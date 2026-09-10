import { JSDOM } from 'jsdom'
import { Readability } from '@mozilla/readability'
import { BlockList, isIP } from 'node:net'

export interface ValidatedUrl { url: URL }

export function validateUrl(raw: string): ValidatedUrl {
  let url: URL
  try { url = new URL(raw) } catch { throw new Error('invalid URL') }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`unsupported scheme "${url.protocol}"`)
  }
  return { url }
}

const NON_GLOBAL_V4 = new BlockList()
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10],
  ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) NON_GLOBAL_V4.addSubnet(network, prefix, 'ipv4')

const GLOBAL_V6 = new BlockList()
GLOBAL_V6.addSubnet('2000::', 3, 'ipv6')
const NON_GLOBAL_V6 = new BlockList()
for (const [network, prefix] of [
  ['2001::', 23],       // protocol assignments, including Teredo
  ['2001:db8::', 32],   // documentation
  ['2002::', 16],       // 6to4 can tunnel otherwise blocked IPv4
  ['3fff::', 20],       // documentation
] as const) NON_GLOBAL_V6.addSubnet(network, prefix, 'ipv6')

// Fail closed for every non-global address, not only the common RFC1918 set.
export function isPrivateIp(ip: string): boolean {
  const value = ip.replace(/^\[|\]$/g, '')
  const family = isIP(value)
  if (family === 4) return NON_GLOBAL_V4.check(value, 'ipv4')
  if (family === 6) {
    // IPv4-mapped, NAT64, ULA, link-local, multicast, and unspecified forms
    // all sit outside the currently allocated global-unicast 2000::/3 block.
    return !GLOBAL_V6.check(value, 'ipv6') || NON_GLOBAL_V6.check(value, 'ipv6')
  }
  return true
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
