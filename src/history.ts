import type { TextChannel, DMChannel, ThreadChannel } from 'discord.js'

export interface HistoryAttachment {
  name: string
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
  parts: { text: string }[]
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
    const attachmentText = m.attachments.map(describeAttachment).join(' ')
    let text: string
    if (isSelf) {
      // Bot's own messages: no username prefix
      text = [m.content, attachmentText].filter(Boolean).join(' ')
    } else {
      // Other users: prefix with username
      const body = [m.content, attachmentText].filter(Boolean).join(' ')
      text = `${m.authorName}: ${body}`
    }
    return { role: isSelf ? 'model' : 'user', parts: [{ text }] } as GeminiContent
  })
}
