type MentionedUser = {
  id: string
  bot?: boolean
}

const USER_MENTION_RE = /<@!?(\d+)>/g

export function isAddressedToAnotherBot(
  selfId: string,
  mentionedUsers: Iterable<MentionedUser>,
  content?: string,
  repliedAuthor?: MentionedUser | null,
): boolean {
  if (content !== undefined) {
    const explicitIds = new Set([...content.matchAll(USER_MENTION_RE)].map(match => match[1]))
    if (explicitIds.size > 0) return !explicitIds.has(selfId)
  }
  if (repliedAuthor?.bot) return repliedAuthor.id !== selfId

  let mentionsSelf = false
  let mentionsAnotherBot = false

  for (const user of mentionedUsers) {
    if (user.id === selfId) mentionsSelf = true
    else if (user.bot) mentionsAnotherBot = true
  }

  return mentionsAnotherBot && !mentionsSelf
}
