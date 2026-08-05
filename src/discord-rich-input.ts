import type { InputAttachment } from './attachments.ts'

interface Values<T> { values(): IterableIterator<T> }
interface Asset { url?: string | null; proxyURL?: string | null; contentType?: string | null }
interface RichMessage {
  content?: string | null
  embeds?: Values<{ title?: string | null; description?: string | null; url?: string | null; provider?: { name?: string | null } | null; thumbnail?: Asset | null; image?: Asset | null; video?: Asset | null }> | null
  stickers?: Values<{ id: string; name: string; format?: number; url?: string }> | null
  attachments?: Values<{ name: string; url: string; size: number; contentType: string | null }> | null
  messageSnapshots?: Values<RichMessage> | null
  poll?: { question?: { text?: string | null } | null; answers?: Values<{ id?: number; text?: string | null; voteCount?: number; emoji?: { name?: string | null } | null }> | null; allowMultiselect?: boolean; expiresTimestamp?: number | null; resultsFinalized?: boolean } | null
}

const vals = <T>(v: Values<T> | null | undefined): T[] => v ? [...v.values()] : []
function ext(url: string): string { try { return new URL(url).pathname.match(/\.([a-z0-9]{2,5})$/i)?.[1]?.toLowerCase() ?? '' } catch { return '' } }
function mime(url: string, fallback = 'image/png'): string {
  const x = ext(url)
  if (x === 'gif') return 'image/gif'
  if (x === 'webp') return 'image/webp'
  if (x === 'jpg' || x === 'jpeg') return 'image/jpeg'
  if (x === 'mp4' || x === 'webm') return `video/${x}`
  if (x === 'png') return 'image/png'
  return fallback
}
function stickerExt(format?: number): string | null { return format === 4 ? 'gif' : format === 3 ? null : 'png' }

export function extractRichMedia(message: RichMessage): InputAttachment[] {
  const out: InputAttachment[] = []; const seen = new Set<string>()
  const add = (a: InputAttachment) => { if (a.url && !seen.has(a.url)) { seen.add(a.url); out.push(a) } }
  const visit = (source: RichMessage, snapshot = false) => {
    if (snapshot) for (const a of vals(source.attachments)) add(a)
    for (const s of vals(source.stickers)) {
      const x = stickerExt(s.format); if (!x) continue
      add({ name: `sticker-${s.name}.${x}`, url: s.url || `https://cdn.discordapp.com/stickers/${s.id}.${x}`, size: 0, contentType: x === 'gif' ? 'image/gif' : 'image/png' })
    }
    for (const [i, e] of vals(source.embeds).entries()) {
      const a = e.video ?? e.image ?? e.thumbnail; const url = a?.proxyURL ?? a?.url
      if (!url) continue
      const m = a?.contentType ?? mime(url, e.video ? 'video/mp4' : 'image/png')
      add({ name: `${snapshot ? 'forwarded-' : ''}embed-${i + 1}.${ext(url) || (m === 'video/mp4' ? 'mp4' : 'png')}`, url, size: 0, contentType: m })
    }
    for (const s of vals(source.messageSnapshots)) visit(s, true)
  }
  visit(message); return out
}

export function formatRichContext(message: RichMessage): string {
  const blocks: string[] = []
  const stickers = vals(message.stickers)
  if (stickers.length) blocks.push('[Discord stickers — actual visual media is attached]\n' + stickers.map(s => `- ${s.name} (id ${s.id})`).join('\n'))
  for (const s of vals(message.messageSnapshots)) blocks.push('[Discord forwarded-message snapshot — original author is unavailable]\n' + JSON.stringify({
    content: s.content ?? '',
    attachments: vals(s.attachments).map(a => ({ name: a.name, content_type: a.contentType, size: a.size })),
    stickers: vals(s.stickers).map(x => ({ id: x.id, name: x.name })),
    embeds: vals(s.embeds).map(e => ({ title: e.title ?? null, description: e.description ?? null, provider: e.provider?.name ?? null, url: e.url ?? null })),
  }))
  if (message.poll) blocks.push('[Discord poll]\n' + JSON.stringify({
    question: message.poll.question?.text ?? '',
    answers: vals(message.poll.answers).map(a => ({ id: a.id ?? null, emoji: a.emoji?.name ?? null, text: a.text ?? '', votes: a.voteCount ?? null })),
    allow_multiselect: Boolean(message.poll.allowMultiselect),
    expires_at: message.poll.expiresTimestamp ? new Date(message.poll.expiresTimestamp).toISOString() : null,
    results_finalized: Boolean(message.poll.resultsFinalized),
  }))
  return blocks.join('\n\n')
}
