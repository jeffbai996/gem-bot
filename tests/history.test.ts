import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { formatHistory, stripBotMetadata, type HistoryMessage } from '../src/history.ts'
import { stripToolTraceCard } from '../src/render-cleanup.ts'

// Narrow a parts entry to the text variant so .text access typechecks.
// formatHistory always emits exactly one text part as parts[0]; the fileData
// variants come from cached attachments which these tests don't exercise.
function textOf(part: { text: string } | { fileData: { mimeType: string, fileUri: string } }): string {
  if (!('text' in part)) throw new Error('expected text part, got fileData')
  return part.text
}

describe('formatHistory', () => {
  const SELF = 'bot-id-gemma'

  test('empty history returns empty array', () => {
    assert.deepEqual(formatHistory([], SELF), [])
  })

  test('formats user and bot messages with correct roles', () => {
    const msgs: HistoryMessage[] = [
      { id: 'm1', authorId: 'U1', authorName: 'Alice', content: 'hello', attachments: [] },
      { id: 'm2', authorId: SELF, authorName: 'Gemma', content: 'hi there', attachments: [] },
      { id: 'm3', authorId: 'U1', authorName: 'Alice', content: 'how are you', attachments: [] }
    ]
    const result = formatHistory(msgs, SELF)
    assert.equal(result.length, 3)
    assert.equal(result[0].role, 'user')
    assert.equal(textOf(result[0].parts[0]), 'Alice: hello')
    assert.equal(result[1].role, 'model')
    assert.equal(textOf(result[1].parts[0]), 'hi there')
    assert.equal(result[2].role, 'user')
    assert.equal(textOf(result[2].parts[0]), 'Alice: how are you')
  })

  test('references attachments in text without uploading', () => {
    const msgs: HistoryMessage[] = [
      {
        id: 'm1',
        authorId: 'U1',
        authorName: 'Alice',
        content: 'check this out',
        attachments: [{ name: 'chart.png', url: 'https://cdn.example/chart.png', mimeType: 'image/png' }]
      }
    ]
    const result = formatHistory(msgs, SELF)
    assert.equal(textOf(result[0].parts[0]), 'Alice: check this out [previous image: chart.png]')
  })

  test('handles message with only attachment (no text)', () => {
    const msgs: HistoryMessage[] = [
      {
        id: 'm1',
        authorId: 'U1',
        authorName: 'Alice',
        content: '',
        attachments: [{ name: 'clip.mp4', url: 'https://cdn.example/clip.mp4', mimeType: 'video/mp4' }]
      }
    ]
    const result = formatHistory(msgs, SELF)
    assert.equal(textOf(result[0].parts[0]), 'Alice: [previous video: clip.mp4]')
  })

  test('handles multiple attachments', () => {
    const msgs: HistoryMessage[] = [
      {
        id: 'm1',
        authorId: 'U1',
        authorName: 'Alice',
        content: 'screenshots',
        attachments: [
          { name: 'a.png', url: 'https://cdn.example/a.png', mimeType: 'image/png' },
          { name: 'b.png', url: 'https://cdn.example/b.png', mimeType: 'image/png' }
        ]
      }
    ]
    const result = formatHistory(msgs, SELF)
    assert.equal(
      textOf(result[0].parts[0]),
      'Alice: screenshots [previous image: a.png] [previous image: b.png]'
    )
  })
})

describe('stripBotMetadata', () => {
  test('strips reasoning block with blockquoted paragraphs', () => {
    const input = `🧠 **Reasoning:**
> Analyzing bot response behavior
>
> I'm thinking that the code path could lead to it appearing dead.

Formulating a response
Since the user asked "why is that," I want to provide a thoughtful answer.`

    assert.equal(
      stripBotMetadata(input),
      `Formulating a response
Since the user asked "why is that," I want to provide a thoughtful answer.`,
    )
  })

  test('strips thinking block with unquoted blank lines between blockquoted paragraphs', () => {
    const input = `💭 ✓ **Thought for 12s**
> paragraph 1

> paragraph 2

Here is the actual reply.`

    assert.equal(
      stripBotMetadata(input),
      'Here is the actual reply.',
    )
  })

  test('strips a leading tool trace card from reply text', () => {
    const input = `🔧 **Tool trace**
\`\`\`diff
+ ● search_squad_memory
+ ● shell
\`\`\`

actual answer`

    assert.equal(stripToolTraceCard(input), 'actual answer')
  })

  test('strips numbered and quoted tool trace cards from reply text', () => {
    const input = `> 🔧 **Tool trace 2/2**
> \`\`\`diff
> + ● Edit
> - ● Bash FAILED
> \`\`\`

actual answer`

    assert.equal(stripToolTraceCard(input), 'actual answer')
  })

  test('strips embedded tool trace card without eating surrounding prose', () => {
    const input = `first chunk

🔧 **Tool trace**
\`\`\`diff
+ ● Search
\`\`\`

second chunk`

    assert.equal(stripToolTraceCard(input), `first chunk

second chunk`)
  })

  test('strips malformed leaked trace body when the fence marker rendered as text', () => {
    const input = `actual answer

Tool trace 2/2
diff
+ ● apply_patch(src/gemma.ts)
+ ● tsc
  ⎿ passed

next answer line`

    assert.equal(stripToolTraceCard(input), `actual answer

next answer line`)
  })

  test('strips repeated trace headers without hanging', () => {
    const input = `Tool trace
Tool trace 2/2
diff
+ ● shell

reply`

    assert.equal(stripToolTraceCard(input), 'reply')
  })

  test('keeps a dash-bulleted answer that follows an unfenced trace card', () => {
    // Regression: the trace-body matcher treated any `-`/`+` line as diff
    // content, so the scan ran off the end of the trace and ate the answer.
    // The reply reached Discord as "(Empty response)".
    const input = `🔧 Tool trace
+ ● Read(pyproject.toml)
  ⎿ 40 lines

- **Version single-sourcing**: check README against pyproject
- **Analysis retention**: look for a rotation rule`

    assert.equal(stripToolTraceCard(input), `- **Version single-sourcing**: check README against pyproject
- **Analysis retention**: look for a rotation rule`)
  })

  test('keeps a dash-bulleted answer directly under a numbered trace header', () => {
    const input = `**Tool trace 2/2**

- first point
- second point`

    assert.equal(stripToolTraceCard(input), `- first point
- second point`)
  })

  test('still strips real diff content inside a fenced trace card', () => {
    const input = `🔧 **Tool trace**
\`\`\`diff
+new line
-old line
- ● Bash FAILED
\`\`\`

actual answer`

    assert.equal(stripToolTraceCard(input), 'actual answer')
  })

  test('strips leaked trace cards from bot history', () => {
    const input = `🔧 **Tool trace 2/2**
\`\`\`diff
+ ● Search
\`\`\`

real reply

-# \` ◷ 1.2s \``

    assert.equal(stripBotMetadata(input), 'real reply')
  })
})
