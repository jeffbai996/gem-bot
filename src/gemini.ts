import { GoogleGenerativeAI, type Content, type Part } from '@google/generative-ai'
import type { GeminiContent } from './history.ts'
import type { MediaPart } from './attachments.ts'
import type { ThinkingMode } from './access.ts'

// Appended to every system prompt. Needed because tools (googleSearch +
// codeExecution) are incompatible with responseMimeType:'application/json' +
// responseSchema, so we can't rely on API-level schema enforcement. Instruct
// the model to emit the JSON we want; parseResponse then tolerates wrappers.
const RESPONSE_FORMAT_BASE = `
## Response format (mandatory)

Your entire response must be a single JSON object with exactly these three string-or-null fields, and nothing else — no markdown fences, no preamble, no commentary outside the JSON:

{"react": <single emoji or null>, "thinking": <optional scratchpad string or null>, "reply": <your message to Discord or null>}

- \`react\`: a single emoji to react with, or null. Most messages should be null.
- \`thinking\`: optional private scratchpad; renders as a quoted block prefixed with 💭 in Discord. Use only when genuinely useful — don't narrate every reply.
- \`reply\`: your actual Discord message, or null if you only want to react. Markdown formatting inside the string is fine.

Do NOT wrap this JSON in \`\`\`json ... \`\`\`. Do NOT print anything before or after. Emit the raw JSON object.`

const THINKING_ALWAYS_ADDENDUM = `

## Thinking override — THIS CHANNEL

This channel has thinking mode forced to ALWAYS. You MUST populate the \`thinking\` field with a non-empty scratchpad explaining your reasoning for every reply, no matter how simple. Even for trivial replies, give at least one sentence of reasoning.`

const THINKING_NEVER_ADDENDUM = `

## Thinking override — THIS CHANNEL

This channel has thinking mode forced to NEVER. Set the \`thinking\` field to null on every reply. Do not populate it under any circumstances.`

export function formatSystemPrompt(base: string, mode: ThinkingMode): string {
  let out = base + '\n\n' + RESPONSE_FORMAT_BASE
  if (mode === 'always') out += THINKING_ALWAYS_ADDENDUM
  else if (mode === 'never') out += THINKING_NEVER_ADDENDUM
  return out
}

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

export interface GroundingSource {
  uri: string
  title: string
}

export interface CodeExecArtifact {
  code: string
  language: string
  output: string | null
  outcome: string | null   // e.g. "OUTCOME_OK", "OUTCOME_FAILED"
}

export interface UsageMetadata {
  promptTokens: number
  responseTokens: number
  totalTokens: number
}

export interface FlaggedSafetyRating {
  category: string
  probability: string  // "NEGLIGIBLE" | "LOW" | "MEDIUM" | "HIGH"
}

// Walk groundingMetadata.groundingChunks[*].web.{uri,title}. The SDK types
// this loosely, so we probe defensively. Dedupe by URI — one source per row.
export function extractGroundingSources(candidate: any): GroundingSource[] {
  const chunks = candidate?.groundingMetadata?.groundingChunks
  if (!Array.isArray(chunks)) return []
  const seen = new Set<string>()
  const out: GroundingSource[] = []
  for (const c of chunks) {
    const web = c?.web
    if (!web?.uri) continue
    if (seen.has(web.uri)) continue
    seen.add(web.uri)
    out.push({ uri: web.uri, title: typeof web.title === 'string' ? web.title : web.uri })
  }
  return out
}

// Pair executableCode parts with the codeExecutionResult that follows them.
// Order in candidate.content.parts is: text? → executableCode → codeExecutionResult → text?
// An executableCode without a following result is still reported (output: null).
export function extractCodeArtifacts(parts: any[] | undefined): CodeExecArtifact[] {
  if (!parts) return []
  const out: CodeExecArtifact[] = []
  let pending: CodeExecArtifact | null = null
  for (const p of parts) {
    if (p?.executableCode) {
      if (pending) out.push(pending)
      pending = {
        code: typeof p.executableCode.code === 'string' ? p.executableCode.code : '',
        language: typeof p.executableCode.language === 'string' ? p.executableCode.language.toLowerCase() : 'python',
        output: null,
        outcome: null
      }
    } else if (p?.codeExecutionResult) {
      if (pending) {
        pending.output = typeof p.codeExecutionResult.output === 'string' ? p.codeExecutionResult.output : null
        pending.outcome = typeof p.codeExecutionResult.outcome === 'string' ? p.codeExecutionResult.outcome : null
        out.push(pending)
        pending = null
      }
    }
  }
  if (pending) out.push(pending)
  return out
}

export function extractUsage(response: any): UsageMetadata | null {
  const u = response?.usageMetadata
  if (!u) return null
  return {
    promptTokens: u.promptTokenCount ?? 0,
    responseTokens: u.candidatesTokenCount ?? 0,
    totalTokens: u.totalTokenCount ?? 0
  }
}

// Only report safety ratings above LOW (MEDIUM / HIGH). The model rarely
// flags stuff we don't already see get censored, so NEGLIGIBLE/LOW is noise.
export function extractFlaggedSafety(candidate: any): FlaggedSafetyRating[] {
  const ratings = candidate?.safetyRatings
  if (!Array.isArray(ratings)) return []
  return ratings
    .filter((r: any) => r?.probability === 'MEDIUM' || r?.probability === 'HIGH')
    .map((r: any) => ({ category: String(r.category ?? 'UNKNOWN'), probability: String(r.probability) }))
}

export interface RespondMetadata {
  groundingSources: GroundingSource[]
  codeArtifacts: CodeExecArtifact[]
  usage: UsageMetadata | null
  finishReason: string | null
  flaggedSafety: FlaggedSafetyRating[]
}

export interface RespondResult {
  parsed: ParsedResponse
  meta: RespondMetadata
}

export interface BuildRequestArgs {
  systemPrompt: string
  history: GeminiContent[]
  userMessageText: string
  userMediaParts: MediaPart[]
  userName: string
  thinkingMode?: ThinkingMode  // default "auto"
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

  async respond(args: BuildRequestArgs): Promise<RespondResult> {
    const userTurn = buildUserTurn(args)
    const systemText = formatSystemPrompt(args.systemPrompt, args.thinkingMode ?? 'auto')
    const result = await this.model.generateContent({
      systemInstruction: { role: 'system', parts: [{ text: systemText }] },
      contents: [...args.history, userTurn]
    })
    const candidate = result.response.candidates?.[0]
    const parts = candidate?.content?.parts as any[] | undefined
    const text = extractModelText(parts)
    const parsed = parseResponse(text)
    const meta: RespondMetadata = {
      groundingSources: extractGroundingSources(candidate),
      codeArtifacts: extractCodeArtifacts(parts),
      usage: extractUsage(result.response),
      finishReason: typeof candidate?.finishReason === 'string' ? candidate.finishReason : null,
      flaggedSafety: extractFlaggedSafety(candidate)
    }
    return { parsed, meta }
  }
}
