const PRESENCE_DIRECTIVE = /\[\[presence:\s*([^\]]*?)\s*\]\]/gi
const PRESENCE_MARKER = '[[presence:'
const MAX_PRESENCE_LENGTH = 128

function stripTrailingDirectiveFragment(reply: string): string {
  const start = reply.lastIndexOf('[[')
  if (start < 0) return reply

  const tail = reply.slice(start).toLowerCase()
  if (PRESENCE_MARKER.startsWith(tail) || tail.startsWith(PRESENCE_MARKER)) {
    return reply.slice(0, start).trimEnd()
  }
  return reply
}

export function normalizePresenceText(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, MAX_PRESENCE_LENGTH)
}

export function extractPresenceDirective(
  reply: string | null | undefined,
): { reply: string | null; presence: string | null } {
  if (reply == null) return { reply: null, presence: null }

  let presence: string | null = null
  const visibleReply = reply.replace(PRESENCE_DIRECTIVE, (_directive, rawPresence: string) => {
    const normalized = normalizePresenceText(rawPresence)
    if (normalized) presence = normalized
    return ''
  })

  return {
    reply: stripTrailingDirectiveFragment(visibleReply).trim(),
    presence,
  }
}
