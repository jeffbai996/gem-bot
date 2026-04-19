import { GoogleGenerativeAI, type Content, type Part } from '@google/generative-ai'
import type { GeminiContent } from './history.ts'
import type { MediaPart } from './attachments.ts'

// Appended to every system prompt. Needed because tools (googleSearch +
// codeExecution) are incompatible with responseMimeType:'application/json' +
// responseSchema, so we can't rely on API-level schema enforcement. Instruct
// the model to emit the JSON we want; parseResponse then tolerates wrappers.
const RESPONSE_FORMAT_INSTRUCTION = `
## Response format (mandatory)

Your entire response must be a single JSON object with exactly these three string-or-null fields, and nothing else — no markdown fences, no preamble, no commentary outside the JSON:

{"react": <single emoji or null>, "thinking": <optional scratchpad string or null>, "reply": <your message to Discord or null>}

- \`react\`: a single emoji to react with, or null. Most messages should be null.
- \`thinking\`: optional private scratchpad; renders as a quoted block prefixed with 💭 in Discord. Use only when genuinely useful — don't narrate every reply.
- \`reply\`: your actual Discord message, or null if you only want to react. Markdown formatting inside the string is fine.

Do NOT wrap this JSON in \`\`\`json ... \`\`\`. Do NOT print anything before or after. Emit the raw JSON object.`

export interface ParsedResponse {
  react: string | null
  thinking: string | null
  reply: string | null
}

function normalize(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}

// Find the last balanced top-level {...} block in `s`. Needed because with
// tools enabled (googleSearch/codeExecution), Gemini can't be held to strict
// JSON output — it may wrap in ```json fences, prepend preamble text, or leak
// code-execution output alongside the JSON. Returns the JSON substring or null.
function extractJsonObject(s: string): string | null {
  // Cheap path: whole string is already valid JSON
  const trimmed = s.trim()
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) return trimmed

  // Walk from the end backward to find the last balanced {...}. Last, not first,
  // because code-exec output can contain earlier {} noise; the model's final
  // JSON answer comes after.
  let depth = 0
  let end = -1
  for (let i = s.length - 1; i >= 0; i--) {
    const c = s[i]
    if (c === '}') {
      if (end === -1) end = i
      depth++
    } else if (c === '{') {
      depth--
      if (depth === 0 && end !== -1) return s.slice(i, end + 1)
    }
  }
  return null
}

export function parseResponse(text: string): ParsedResponse {
  // Strip common code-fence wrappers Gemini adds when tools are enabled and
  // strict JSON mode is not. ```json ... ``` or bare ``` ... ```.
  let cleaned = text.trim()
  const fence = cleaned.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i)
  if (fence) cleaned = fence[1].trim()

  const jsonStr = extractJsonObject(cleaned)
  if (jsonStr) {
    try {
      const obj = JSON.parse(jsonStr)
      return {
        react: normalize(obj.react),
        thinking: normalize(obj.thinking),
        reply: normalize(obj.reply)
      }
    } catch {
      // fall through to plain-text fallback
    }
  }
  return { react: null, thinking: null, reply: cleaned || null }
}

// When tools (googleSearch/codeExecution) are enabled, the response is a
// multi-part Content: tool-output parts (executableCode, codeExecutionResult,
// functionCall) interleaved with the model's final text. `response.text()`
// concatenates ALL text-ish parts, which includes code-exec output — that
// breaks JSON parsing. Extract ONLY the text parts; drop everything else.
export function extractModelText(parts: Array<{ text?: string, executableCode?: unknown, codeExecutionResult?: unknown, functionCall?: unknown }> | undefined): string {
  if (!parts) return ''
  const chunks: string[] = []
  for (const p of parts) {
    if (typeof p.text === 'string' && !p.executableCode && !p.codeExecutionResult && !p.functionCall) {
      chunks.push(p.text)
    }
  }
  return chunks.join('\n').trim()
}

export interface BuildRequestArgs {
  systemPrompt: string
  history: GeminiContent[]
  userMessageText: string
  userMediaParts: MediaPart[]
  userName: string
}

export function buildUserTurn(args: BuildRequestArgs): Content {
  const textBody = `${args.userName}: ${args.userMessageText || '(no text)'}`
  const parts: Part[] = [{ text: textBody }, ...args.userMediaParts]
  return { role: 'user', parts }
}

export class GeminiClient {
  private model: ReturnType<GoogleGenerativeAI['getGenerativeModel']>

  constructor(apiKey: string, modelName: string = 'gemini-2.0-flash') {
    const genAI = new GoogleGenerativeAI(apiKey)
    // Can't use responseMimeType:'application/json' + responseSchema together
    // with tools — Gemini rejects that combo. Structured output comes from the
    // system prompt instruction + permissive parseResponse.
    this.model = genAI.getGenerativeModel({
      model: modelName,
      tools: [{ googleSearch: {} }, { codeExecution: {} }]
    })
  }

  async respond(args: BuildRequestArgs): Promise<ParsedResponse> {
    const userTurn = buildUserTurn(args)
    const systemText = args.systemPrompt + '\n\n' + RESPONSE_FORMAT_INSTRUCTION
    const result = await this.model.generateContent({
      systemInstruction: { role: 'system', parts: [{ text: systemText }] },
      contents: [...args.history, userTurn]
    })
    const parts = result.response.candidates?.[0]?.content?.parts as any[] | undefined
    const text = extractModelText(parts)
    return parseResponse(text)
  }
}
