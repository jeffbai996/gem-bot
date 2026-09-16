import type { SummaryClient } from './summarizer.ts'

interface OllamaChatResponse {
  message?: {
    content?: unknown
  }
}

export interface OllamaSummaryClientOptions {
  baseUrl: string
  model: string
  timeoutMs?: number
  fetchFn?: typeof fetch
}

// Deliberately small Ollama adapter for the low-frequency summary path. It
// does not probe or warm the model at startup; the first actual compaction is
// the first request. keep_alive=-1 preserves the already-resident shared model
// instead of inviting another SSD-backed model shuffle.
export class OllamaSummaryClient implements SummaryClient {
  private readonly baseUrl: string
  private readonly model: string
  private readonly timeoutMs: number
  private readonly fetchFn: typeof fetch

  constructor(options: OllamaSummaryClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.model = options.model
    this.timeoutMs = options.timeoutMs ?? 300_000
    this.fetchFn = options.fetchFn ?? fetch
  }

  async completeText(systemPrompt: string, userPrompt: string): Promise<string> {
    const response = await this.fetchFn(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        stream: false,
        think: false,
        keep_alive: -1,
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    })

    if (!response.ok) {
      const detail = (await response.text()).trim().slice(0, 500)
      throw new Error(`Ollama summary request failed (${response.status})${detail ? `: ${detail}` : ''}`)
    }

    const payload = await response.json() as OllamaChatResponse
    const content = payload.message?.content
    if (typeof content !== 'string' || content.trim() === '') {
      throw new Error('Ollama summary response did not contain message content')
    }
    return content
  }
}
