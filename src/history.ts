import type { TextChannel, DMChannel, ThreadChannel } from 'discord.js'
import { uriCache } from './attachments.ts'

export interface HistoryAttachment {
  name: string
  url: string
  mimeType: string | null
}

export interface HistoryMessage {
  authorId: string
  authorName: string
  content: string
  attachments: HistoryAttachment[]
}

export interface GeminiContent {
  role: 'user' | 'model'
  parts: Array<{ text: string } | { fileData: { mimeType: string, fileUri: string } }>
}

const HISTORY_LIMIT = 20

export async function fetchHistory(
  channel: TextChannel | DMChannel | ThreadChannel,
  beforeMessageId: string
): Promise<HistoryMessage[]> {
  const fetched = await channel.messages.fetch({ limit: HISTORY_LIMIT, before: beforeMessageId })
  const arr: HistoryMessage[] = []
  for (const m of fetched.values()) {
    arr.push({
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
