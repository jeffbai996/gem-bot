import type { TextChannel, DMChannel, ThreadChannel } from 'discord.js'
import { uriCache, isAllowedMime } from './attachments.ts'
import { selectWithinBudget } from './token-budget.ts'
import type { GeminiClient } from './gemini.ts'

export interface HistoryAttachment {
  name: string
  url: string
  mimeType: string | null
}

export interface HistoryMessage {
  id: string
  authorId: string
  authorName: string
  content: string
  attachments: HistoryAttachment[]
}

export interface GeminiContent {
  role: 'user' | 'model'
  parts: Array<{ text: string } | { fileData: { mimeType: string, fileUri: string } }>
}

// Upper bound for the raw Discord fetch. Actual history length is then
// trimmed by token budget in buildContextHistory(). Discord caps fetch at
// 100 messages per call, so don't exceed this without pagination.
const HISTORY_RAW_LIMIT = 100

export async function fetchHistory(
  channel: TextChannel | DMChannel | ThreadChannel,
  beforeMessageId: string
): Promise<HistoryMessage[]> {
  const fetched = await channel.messages.fetch({ limit: HISTORY_RAW_LIMIT, before: beforeMessageId })
  const arr: HistoryMessage[] = []
  for (const m of fetched.values()) {
    arr.push({
      id: m.id,
      authorId: m.author.id,
      authorName: m.author.username,
      content: m.content,
      attachments: [...m.attachments.values()].map(a => ({
        name: a.name,
        url: a.url,
        mimeType: a.contentType
      }))
    })
  }
  // Discord returns newest-first; reverse to chronological order
  return arr.reverse()
}

function describeAttachment(att: HistoryAttachment): string {
  const mime = att.mimeType ?? ''
  const kind = mime.startsWith('image/') ? 'image'
    : mime.startsWith('video/') ? 'video'
    : mime.startsWith('audio/') ? 'audio'
    : 'file'
  return `[previous ${kind}: ${att.name}]`
}

// Strip metadata lines we add to bot replies (token footer, source links,
// max-token warnings, search-query block, native reasoning, etc.) before
// feeding the bot's own past messages back into context. Without this, the
// model pattern-matches its own footer format and starts hallucinating
// `↑ X · ↓ Y · » Zs` lines inside its reply text — which then get appended
// alongside the real footer that gemma.ts adds, producing duplicates.
//
// Discord's `-# ` directive is reserved for our metadata in this bot, so any
// line starting with that prefix is safe to drop. Also drop the `🧠 Reasoning`
// and `🔍 Web search` blocks since those are renderer output, not the model's
// authored content. The "💭 Thinking:" block IS authored (parsed.thinking) so
// we keep it.
export function stripBotMetadata(text: string): string {
  if (!text) return text
  const lines = text.split('\n')
  const out: string[] = []
  let inMetadataBlock = false
  for (const line of lines) {
    if (line.startsWith('-# ')) {
      inMetadataBlock = false
      continue  // drop small-text directive lines (footer, sources, warnings)
    }
    if (line.startsWith('🧠 **Reasoning:**') || line.startsWith('🔍 **Web search**')) {
      inMetadataBlock = true
      continue
    }
    if (inMetadataBlock) {
      // Continuation lines of a metadata block are blockquoted (`> ...`) or
      // indented bullets (`> · ...`). End the block on the first blank line.
      if (line.trim() === '') {
        inMetadataBlock = false
      }
      continue
    }
    out.push(line)
  }
  // Collapse trailing blank lines that the strip leaves behind.
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()
}

export function formatHistory(messages: HistoryMessage[], selfId: string): GeminiContent[] {
  return messages.map(m => {
    const isSelf = m.authorId === selfId
    const parts: GeminiContent['parts'] = []
    
    const unCachedAttachments: HistoryAttachment[] = []

    // Inject cached files natively; defer others to text descriptions.
    // Re-validate mime against the allowlist — Discord can report weird
    // sub-track mimes (e.g. `video/text/timestamp`) that Gemini's codeExecution
    // tool 400s the entire request on. Drop those to a text description so
    // they never reach the request payload.
    for (const att of m.attachments) {
      if (uriCache.has(att.url) && att.mimeType && isAllowedMime(att.mimeType)) {
        parts.push({ fileData: { mimeType: att.mimeType, fileUri: uriCache.get(att.url)! } })
      } else {
        unCachedAttachments.push(att)
      }
    }

    const attachmentText = unCachedAttachments.map(describeAttachment).join(' ')
    let text: string
    if (isSelf) {
      // Strip footer/sources/reasoning/web-search blocks from our own past
      // replies so the model doesn't pattern-match and re-emit them. See
      // stripBotMetadata for what gets dropped and why.
      const cleanedContent = stripBotMetadata(m.content)
      text = [cleanedContent, attachmentText].filter(Boolean).join(' ')
    } else {
      const body = [m.content, attachmentText].filter(Boolean).join(' ')
      text = `${m.authorName}: ${body}`
    }

    parts.unshift({ text })

    return { role: isSelf ? 'model' : 'user', parts }
  })
}

// Fetch + format + token-budget trim in one call. Use this from gemma.ts;
// the individual pieces remain exported for testing and future reuse.
//
// `since` (optional): when set, drops raw messages with id <= since before
// formatting. Used by the conversation-summarization flow to avoid feeding
// already-summarized messages back into the live context.
export async function buildContextHistory(
  channel: TextChannel | DMChannel | ThreadChannel,
  beforeMessageId: string,
  gemini: GeminiClient,
  selfId: string,
  budget: number,
  since?: string | null
): Promise<GeminiContent[]> {
  const raw = await fetchHistory(channel, beforeMessageId)
  // Discord snowflake IDs are sortable numerically via BigInt comparison.
  const filtered = since
    ? raw.filter(m => {
        try { return BigInt(m.id) > BigInt(since) } catch { return true }
      })
    : raw
  const formatted = formatHistory(filtered, selfId)
  if (budget <= 0) {
    return formatted.length > 20 ? formatted.slice(-20) : formatted
  }
  return selectWithinBudget(formatted, c => gemini.countTokens(c as any), { budget })
}
