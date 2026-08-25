import type { CompactionObserver } from './summarization/scheduler.ts'

export const AUTOMATIC_COMPACTION_STATUS = '📝 ✶ **Compacting context…**'

interface DeletableMessage {
  delete(): Promise<unknown>
}
type SendStatus = (content: string) => Promise<DeletableMessage | null>

/** Show automatic rollups without leaving a permanent bookkeeping message. */
export function createCompactionObserver(
  sendStatus: SendStatus,
  onError: (error: unknown) => void = error => console.error('[summarization] compaction indicator failed:', error),
): CompactionObserver {
  let statusMessage: DeletableMessage | null = null

  return {
    onStart: async () => {
      try {
        statusMessage = await sendStatus(AUTOMATIC_COMPACTION_STATUS)
      } catch (error) {
        onError(error)
      }
    },
    onFinish: async () => {
      const message = statusMessage
      statusMessage = null
      if (!message) return
      try {
        await message.delete()
      } catch (error) {
        onError(error)
      }
    },
  }
}
