import type { GeminiClient } from '../gemini.ts'

export interface SummarizableMessage {
  authorName: string
  content: string
  timestamp: string
  messageId: string
}

const SYSTEM_PROMPT = `You are summarizing a Discord channel for context preservation. Produce a tight, factual summary that captures:
- Key decisions and conclusions
- Recurring themes or running jokes
- Important named entities (people, places, projects)
- Open questions or pending items
- The general tone of the channel

Constraints:
- Maximum ~500 words.
- Plain prose, no headers or bullets unless necessary for clarity.
- Don't editorialize. Report what was discussed.

If a previous summary is provided, incorporate it. Old facts that are still relevant stay; old facts that have been superseded by newer messages are updated. Don't double-count.

Output ONLY the summary text. No preamble, no metadata.`

// Build the prompt and run a one-shot completion to produce a fresh summary.
// Returns the trimmed summary text + the message ID of the newest input
// message (the new "last_summarized_message_id" for the store).
export async function runSummarization(
  oldSummary: string | null,
  newMessages: SummarizableMessage[],
  gemini: Pick<GeminiClient, 'completeText'>
): Promise<{ summary: string; lastMessageId: string }> {
  if (newMessages.length === 0) throw new Error('runSummarization called with empty newMessages')

  const formattedMessages = newMessages
    .map(m => `[${m.timestamp}] ${m.authorName}: ${m.content}`)
    .join('\n')

  const userText = `PREVIOUS SUMMARY:\n${oldSummary ?? '(none)'}\n\nNEW MESSAGES SINCE PREVIOUS SUMMARY:\n${formattedMessages}`

  const summary = (await gemini.completeText(SYSTEM_PROMPT, userText)).trim()
  const lastMessageId = newMessages[newMessages.length - 1].messageId
  return { summary, lastMessageId }
}
