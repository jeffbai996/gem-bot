import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { OllamaSummaryClient } from '../../src/summarization/ollama-client.ts'

describe('OllamaSummaryClient', () => {
  test('sends a non-streaming, non-thinking chat request to the resident model', async () => {
    let capturedUrl = ''
    let capturedInit: RequestInit | undefined
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(url)
      capturedInit = init
      return new Response(JSON.stringify({ message: { content: 'summary text' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch

    const client = new OllamaSummaryClient({
      baseUrl: 'http://127.0.0.1:11434/',
      model: 'qwen3.8:27b',
      fetchFn,
    })

    assert.equal(await client.completeText('system', 'user'), 'summary text')
    assert.equal(capturedUrl, 'http://127.0.0.1:11434/api/chat')
    const body = JSON.parse(String(capturedInit?.body))
    assert.deepEqual(body, {
      model: 'qwen3.8:27b',
      messages: [
        { role: 'system', content: 'system' },
        { role: 'user', content: 'user' },
      ],
      stream: false,
      think: false,
      keep_alive: -1,
    })
  })

  test('reports bounded Ollama errors without accepting an empty response', async () => {
    const failedFetch = (async () => new Response('backend unavailable', { status: 503 })) as typeof fetch
    const failed = new OllamaSummaryClient({ baseUrl: 'http://ollama', model: 'qwen', fetchFn: failedFetch })
    await assert.rejects(() => failed.completeText('s', 'u'), /503.*backend unavailable/)

    const emptyFetch = (async () => new Response(JSON.stringify({ message: { content: '  ' } }), { status: 200 })) as typeof fetch
    const empty = new OllamaSummaryClient({ baseUrl: 'http://ollama', model: 'qwen', fetchFn: emptyFetch })
    await assert.rejects(() => empty.completeText('s', 'u'), /did not contain message content/)
  })
})
