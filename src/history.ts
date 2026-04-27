import type { TextChannel, DMChannel, ThreadChannel } from 'discord.js'
import { uriCache } from './attachments.ts'
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

export function formatHistory(messages: HistoryMessage[], selfId: string): GeminiContent[] {
  return messages.map(m => {
    const isSelf = m.authorId === selfId
    const parts: GeminiContent['parts'] = []
    
    const unCachedAttachments: HistoryAttachment[] = []

    // Inject cached files natively; defer others to text descriptions
    for (const att of m.attachments) {
      if (uriCache.has(att.url) && att.mimeType) {
        parts.push({ fileData: { mimeType: att.mimeType, fileUri: uriCache.get(att.url)! } })
      } else {
        unCachedAttachments.push(att)
      }
    }

    const attachmentText = unCachedAttachments.map(describeAttachment).join(' ')
    let text: string
    if (isSelf) {
      text = [m.content, attachmentText].filter(Boolean).join(' ')
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
