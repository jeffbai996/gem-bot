import { GoogleGenerativeAI, type Content, type Part } from '@google/generative-ai'
import type { GeminiContent } from './history.ts'
import type { MediaPart } from './attachments.ts'
import type { ThinkingMode } from './access.ts'
import { ToolRegistry } from './tools/registry.ts'

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

// Gemini's streaming output routinely violates JSON spec in two ways:
// 1. Literal newlines between structural tokens (even between `"` and the
//    first char of a key — breaks JSON.parse and the "key" regex)
// 2. Literal newlines inside string VALUES (JSON spec requires \n escape)
//
// This pre-normalizer state-machines the input: outside strings, drops
// whitespace between tokens; inside strings, escapes control chars so
// JSON.parse accepts them (and we get the original newlines back via the
// parse's own unescaping).
export function normalizeJsonWhitespace(s: string): string {
  let out = ''
  let inString = false
  let escaped = false
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (inString) {
      if (escaped) {
        out += c
        escaped = false
        continue
      }
      if (c === '\\') {
        out += c
        escaped = true
        continue
      }
      if (c === '"') {
        out += c
        inString = false
        continue
      }
      // Control chars INSIDE strings need to be escaped to produce valid JSON.
      // Tab stays as-is because it's legal in JSON strings (well, actually
      // also technically not — per RFC 8259 U+0000..U+001F must be escaped —
      // but JSON.parse accepts raw tabs in practice).
      if (c === '\n') { out += '\\n'; continue }
      if (c === '\r') { out += '\\r'; continue }
      out += c
    } else {
      if (c === '"') {
        inString = true
        out += c
      } else if (c === '\n' || c === '\r' || c === '\t') {
        // drop — whitespace between tokens, not inside a value
      } else {
        out += c
      }
    }
  }
  return out
}

export function parseResponse(text: string, isPartial: boolean = false): ParsedResponse {
  let cleaned = text.trim()
  const fence = cleaned.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?(?:```)?$/i)
  if (fence) cleaned = fence[1].trim()

  const jsonStr = extractJsonObject(cleaned)
  if (jsonStr) {
    try {
      // Normalize structural whitespace (newlines between tokens). This
      // leaves string contents untouched — only whitespace OUTSIDE string
      // literals is dropped.
      const obj = JSON.parse(normalizeJsonWhitespace(jsonStr))
      // Gemini sometimes inserts whitespace INSIDE key names too —
      // e.g. `{"\nreact": ...}` parses as key "\nreact", not "react".
      // Trim keys and reassemble so obj.react lookups work.
      const trimmed: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(obj)) trimmed[k.trim()] = v
      return {
        react: normalize(trimmed.react),
        thinking: normalize(trimmed.thinking),
        reply: normalize(trimmed.reply)
      }
    } catch {
      // fall through to regex extraction (handles cases where the model
      // emitted literal newlines INSIDE a value string — JSON spec forbids
      // that, so normalize + JSON.parse still fails)
    }
  }

  // Regex extraction fallback: works for partial streams AND broken JSON (e.g. literal newlines in strings)
  const extractString = (key: string) => {
    // Match the key, then capture everything until the next key or the end of the JSON object.
    // We look for a trailing quote followed by either a comma, a closing brace, or end of string.
    const regex = new RegExp(`"${key}"\\s*:\\s*"([^]*?)(?<!\\\\)"(?:\\s*,|\\s*})`, 'i')
    const match = cleaned.match(regex)
    if (match) {
      try { 
        // We use JSON.parse here to unescape \n, \", etc.
        // But if the model put literal newlines, JSON.parse fails.
        // So we sanitize literal newlines into escaped \n for the parse step.
        const sanitized = match[1].replace(/\n/g, '\\n').replace(/\r/g, '\\r')
        return JSON.parse(`"${sanitized}"`) 
      } catch { 
        return match[1] 
      }
    }
    
    // If it's partial and the value is still open
    if (isPartial) {
      const openRegex = new RegExp(`"${key}"\\s*:\\s*"([^]*)`, 'i')
      const openMatch = cleaned.match(openRegex)
      if (openMatch) {
        let val = openMatch[1]
        if (val.endsWith('}')) val = val.slice(0, -1).trim()
        if (val.endsWith('"')) val = val.slice(0, -1)
        try { 
          const sanitized = val.replace(/\n/g, '\\n').replace(/\r/g, '\\r')
          return JSON.parse(`"${sanitized}"`) 
        } catch { 
          return val 
        }
      }
    }
    return null
  }

  const react = extractString('react')
  const thinking = extractString('thinking')
  const reply = extractString('reply')

  // If we couldn't extract a reply via regex AND we aren't partial,
  // it means the model completely ignored the JSON instruction. Return raw text.
  if (!reply && !isPartial && !react && !thinking) {
    return { react: null, thinking: null, reply: cleaned || null }
  }

  return { react, thinking, reply }
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
  channelId?: string       // Passed so we can execute channel-specific search_memory
  thinkingMode?: ThinkingMode  // default "auto"
}

export function buildUserTurn(args: BuildRequestArgs): Content {
  const textBody = `${args.userName}: ${args.userMessageText || '(no text)'}`
  const parts: Part[] = [{ text: textBody }, ...args.userMediaParts]
  return { role: 'user', parts }
}

export class GeminiClient {
  private model: ReturnType<GoogleGenerativeAI['getGenerativeModel']>
  private registry: ToolRegistry

  constructor(apiKey: string, modelName: string = 'gemini-2.0-flash', registry: ToolRegistry) {
    const genAI = new GoogleGenerativeAI(apiKey)
    this.registry = registry
    this.model = genAI.getGenerativeModel({
      model: modelName,
      tools: [
        { googleSearch: {} },
        { codeExecution: {} },
        { functionDeclarations: registry.getDeclarations() }
      ]
    })
  }

  async embed(text: string): Promise<number[]> {
    // Note: embedContent requires an embedding model. We instantiate a separate model for this.
    const genAI = new GoogleGenerativeAI(this.model.apiKey)
    const embeddingModel = genAI.getGenerativeModel({ model: 'text-embedding-004' })
    const result = await embeddingModel.embedContent(text)
    return result.embedding.values
  }

  async countTokens(contents: Content[]): Promise<number> {
    const result = await this.model.countTokens({ contents })
    return result.totalTokens
  }

  // One round-trip with the model. Handles both streaming (when onProgress
  // provided) and non-streaming, returning a unified shape so the caller's
  // tool loop doesn't branch on streaming vs not.
  private async runOneTurn(
    systemText: string,
    activeContents: Content[],
    onProgress?: (partial: ParsedResponse) => void
  ): Promise<{
    functionCall: any | null
    candidate: any
    response: any
    text: string
  }> {
    if (onProgress) {
      const result = await this.model.generateContentStream({
        systemInstruction: { role: 'system', parts: [{ text: systemText }] },
        contents: activeContents
      })

      let accumulatedText = ''
      let functionCallReceived: any = null

      for await (const chunk of result.stream) {
        const parts = chunk.candidates?.[0]?.content?.parts as any[] | undefined
        const fnCallPart = parts?.find(p => p.functionCall)
        if (fnCallPart) functionCallReceived = fnCallPart.functionCall
        const textChunk = extractModelText(parts)
        if (textChunk && !functionCallReceived) {
          accumulatedText += textChunk
          onProgress(parseResponse(accumulatedText, true))
        }
      }

      const response = await result.response
      const candidate = response.candidates?.[0]
      const parts = candidate?.content?.parts as any[] | undefined
      // Prefer streamed accumulated text; fall back to joined parts if the
      // stream yielded nothing text-ish (e.g., pure function-call turn).
      const text = accumulatedText || extractModelText(parts)
      const fnCall = functionCallReceived || parts?.find(p => p.functionCall)?.functionCall || null
      return { functionCall: fnCall, candidate, response, text }
    }

    const result = await this.model.generateContent({
      systemInstruction: { role: 'system', parts: [{ text: systemText }] },
      contents: activeContents
    })
    const candidate = result.response.candidates?.[0]
    const parts = candidate?.content?.parts as any[] | undefined
    const fnCall = parts?.find(p => p.functionCall)?.functionCall || null
    const text = extractModelText(parts)
    return { functionCall: fnCall, candidate, response: result.response, text }
  }

  async respond(
    args: BuildRequestArgs,
    onProgress?: (partial: ParsedResponse) => void
  ): Promise<RespondResult> {
    const userTurn = buildUserTurn(args)
    const systemText = formatSystemPrompt(args.systemPrompt, args.thinkingMode ?? 'auto')

    const activeContents: Content[] = [...args.history, userTurn]
    let meta: RespondMetadata | null = null
    let finalParsed: ParsedResponse = { react: null, thinking: null, reply: null }

    // Tool-call loop. Capped at 3 iterations to avoid runaway cost if the
    // model keeps calling tools in a cycle.
    for (let iteration = 0; iteration < 3; iteration++) {
      const turn = await this.runOneTurn(systemText, activeContents, onProgress)

      if (!turn.functionCall) {
        finalParsed = parseResponse(turn.text)
        meta = {
          groundingSources: extractGroundingSources(turn.candidate),
          codeArtifacts: extractCodeArtifacts(turn.candidate?.content?.parts),
          usage: extractUsage(turn.response),
          finishReason: typeof turn.candidate?.finishReason === 'string' ? turn.candidate.finishReason : null,
          flaggedSafety: extractFlaggedSafety(turn.candidate)
        }
        break
      }

      // Record the model's function call, dispatch via the registry, and feed
      // the result back to the model for the next iteration.
      activeContents.push({ role: 'model', parts: [{ functionCall: turn.functionCall }] })
      const result = await this.registry.dispatch(
        turn.functionCall.name,
        (turn.functionCall.args ?? {}) as Record<string, unknown>,
        { channelId: args.channelId, gemini: this }
      )
      activeContents.push({
        role: 'user',
        parts: [{ functionResponse: { name: turn.functionCall.name, response: { result } } }]
      })
    }

    if (!meta) {
      throw new Error('Failed to complete response after maximum function call iterations.')
    }

    return { parsed: finalParsed, meta }
  }
}
