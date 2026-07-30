// Tool-call rows use the available Discord desktop width; result payloads use a tighter
// independent budget because Discord renders their indented rows wider.
// row is capped to it via truncateDisplayWidth, so wide glyphs count as 2.
export const TRACE_ROW_MAX = 76
export const TRACE_RESULT_PAYLOAD_MAX = 73
const TRACE_BODY_CHAR_BUDGET = 1800
const SECRET_RE = /[A-Za-z0-9_\-]{32,256}/g
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
const WIDE_RE = /\p{Extended_Pictographic}|[\u1100-\u115f\u2329\u232a\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/u

export function displayWidth(value: string): number {
  let width = 0
  for (const { segment } of graphemes.segment(value)) {
    if (/^[\p{Mark}\p{Format}]+$/u.test(segment)) continue
    width += WIDE_RE.test(segment) ? 2 : 1
  }
  return width
}

export function truncateDisplayWidth(value: string, maxWidth: number): string {
  if (displayWidth(value) <= maxWidth) return value
  return truncateDisplayWidthClean(value, maxWidth - 1) + '…'
}

export function truncateDisplayWidthClean(value: string, maxWidth: number): string {
  if (displayWidth(value) <= maxWidth) return value
  let out = ''
  let width = 0
  for (const { segment } of graphemes.segment(value)) {
    const next = displayWidth(segment)
    if (width + next > maxWidth) break
    out += segment
    width += next
  }
  return out
}

export function truncateDigest(value: string, maxLength: number): string {
  return value.length > maxLength ? value.slice(0, Math.max(0, maxLength)) : value
}

export function formatAggregateTraceMarker(dropped: number): string {
  return `…(+${dropped} earlier call${dropped === 1 ? '' : 's'})`
}

export type TraceDisplayMode = 'off' | 'on' | 'live' | 'collapse'

function lineCost(lines: string[]): number {
  return lines.reduce((total, line, index) => total + line.length + (index ? 1 : 0), 0)
}

function splitTraceBlocks(lines: string[]): string[][] {
  const blocks: string[][] = []
  let block: string[] = []
  for (const line of lines) {
    if (/^[+-] ● /.test(line) && block.length) {
      blocks.push(block)
      block = []
    }
    block.push(line)
  }
  if (block.length) blocks.push(block)
  return blocks.length ? blocks : [['']]
}

function paginateTraceBlocks(blocks: string[][]): string[][] {
  const pages: string[][] = []
  let page: string[] = []
  const pushPage = () => {
    if (!page.length) return
    pages.push(page)
    page = []
  }

  for (const block of blocks) {
    const separator = page.length ? 1 : 0
    if (page.length && lineCost(page) + separator + lineCost(block) > TRACE_BODY_CHAR_BUDGET) {
      pushPage()
    }
    if (lineCost(block) <= TRACE_BODY_CHAR_BUDGET) {
      page.push(...block)
      continue
    }
    for (const line of block) {
      const lineSeparator = page.length ? 1 : 0
      if (page.length && lineCost(page) + lineSeparator + line.length > TRACE_BODY_CHAR_BUDGET) {
        pushPage()
      }
      page.push(line)
    }
  }
  pushPage()
  return pages.length ? pages : [['']]
}

function rollingTracePage(blocks: string[][]): string[] {
  const page: string[] = []
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i]
    const separator = page.length ? 1 : 0
    if (lineCost(block) + separator + lineCost(page) <= TRACE_BODY_CHAR_BUDGET) {
      page.unshift(...block)
      continue
    }
    if (!page.length) {
      const header = block[0]
      const tail: string[] = []
      for (let j = block.length - 1; j >= 1; j--) {
        const candidate = [header, '… earlier rows omitted', block[j], ...tail]
        if (lineCost(candidate) > TRACE_BODY_CHAR_BUDGET) break
        tail.unshift(block[j])
      }
      page.push(header, '… earlier rows omitted', ...tail)
    }
    break
  }
  return page.length ? page : ['']
}

export function renderTraceCards(rawLines: string[], mode: TraceDisplayMode): string[] {
  if (mode === 'off') return []
  const lines = rawLines.map(line => truncateDisplayWidth(line, TRACE_ROW_MAX))
  const blocks = splitTraceBlocks(lines)
  const pages = mode === 'live'
    ? [rollingTracePage(blocks)]
    : paginateTraceBlocks(blocks)

  return pages.map((page, index) => {
    const body = page.join('\n').replace(SECRET_RE, '<REDACTED>')
    const header = index === 0 ? '🔧 **Tool trace**\n' : ''
    return `${header}\`\`\`diff\n${body}\n\`\`\``
  })
}

export const DEFAULT_LIVE_END_LINGER_MS = 10_000
