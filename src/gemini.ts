import { GoogleGenAI, type Content, type Part } from '@google/genai'
import type { GeminiContent } from './history.ts'
import type { MediaPart } from './attachments.ts'
import { isAllowedMime } from './attachments.ts'
import type { ThinkingMode } from './access.ts'
import { ToolRegistry } from './tools/registry.ts'
import { GeminiCacheManager, type CachedRef } from './cache.ts'

// Thrown when Gemini rejects the request payload itself (HTTP 400). The
// gemma.ts message handler catches this to surface a specific error to the
// user instead of the generic "something broke" fallback. Don't retry — the
// payload is bad; same payload will fail the same way.
export class GeminiRequestRejected extends Error {
  readonly reason: string
  readonly status: number
  constructor(reason: string, status: number = 400) {
    super(`Gemini rejected request: ${reason}`)
    this.name = 'GeminiRequestRejected'
    this.reason = reason
    this.status = status
  }
}

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
//
// Concatenate with EMPTY string (not '\n'). Streaming responses split a
// single logical text output across multiple parts at token boundaries —
// joining with '\n' injects spurious newlines mid-string that then leak
// into Gemma's parsed reply. Also: do NOT .trim(), because the first
// char of a continuation part is often a meaningful space or \u escape
// continuation — trimming mangles unicode escapes split across parts.
export function extractModelText(parts: Array<{ text?: string, executableCode?: unknown, codeExecutionResult?: unknown, functionCall?: unknown, thought?: boolean }> | undefined): string {
  if (!parts) return ''
  const chunks: string[] = []
  for (const p of parts) {
    // Skip thought-summary parts (gemini-3 thinking models). They're surfaced
    // separately via extractNativeThoughts so they don't get glued into the
    // user-facing text.
    if (p.thought === true) continue
    if (typeof p.text === 'string' && !p.executableCode && !p.codeExecutionResult && !p.functionCall) {
      chunks.push(p.text)
    }
  }
  return chunks.join('')
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
  cachedTokens: number  // 0 when no cache hit; else the prefix size billed at cached rate
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
//
// Dedupe: Gemini's streaming-aggregated parts array sometimes contains the
// same executableCode twice (observed in prod 2026-04-28 — single run of
// `print(math.factorial(25))` rendered as two identical 🛠️ Code blocks in
// Discord, neither with an Output section). We collapse a duplicate when its
// (code, language) matches the most-recent artifact (pending or last pushed),
// preferring whichever copy ended up paired with a result.
//
// gemini-3-pro-preview emits duplicates with subtle whitespace differences
// (extra trailing newline, indent shift), so we normalize whitespace on the
// dedupe key — collapse all runs of whitespace and trim — without mutating
// the artifact's stored code (which still gets rendered verbatim).
function normalizeCodeForDedupe(code: string): string {
  return code.replace(/\s+/g, ' ').trim()
}

// gemini-3-pro-preview often emits the same code twice — once in its prose
// reply as a markdown fenced block, and once via the codeExecution tool as an
// executableCode part. The artifact path is rendered separately by gemma.ts
// when showCode is on; the prose copy is a duplicate that the user explicitly
// opted in to seeing once via the artifact rendering.
//
// When artifacts exist with a given language, strip ALL fenced blocks of that
// language from the reply text. Pro paraphrases the executed code with subtle
// edits (renamed vars, simplified print line) so byte-for-byte dedupe misses;
// the right call is to treat the artifact as canonical. Languages that didn't
// produce an artifact pass through untouched (rare edge — model writes a JS
// snippet alongside an executed Python artifact).
export function stripDuplicateCodeBlocks(reply: string, artifacts: CodeExecArtifact[]): string {
  if (!reply || artifacts.length === 0) return reply
  const stripLangs = new Set(artifacts.map(a => a.language.toLowerCase()))
  // Also strip unlabeled fenced blocks — pro often omits the language tag on
  // the duplicated copy.
  return reply.replace(/```([a-zA-Z0-9_+-]*)\n([\s\S]*?)\n?```/g, (full, lang: string, _body: string) => {
    const langKey = (lang || '').toLowerCase()
    return stripLangs.has(langKey) ? '' : full
  }).replace(/\n{3,}/g, '\n\n').trim()
}
export function extractCodeArtifacts(parts: any[] | undefined): CodeExecArtifact[] {
  if (!parts) return []
  const out: CodeExecArtifact[] = []
  let pending: CodeExecArtifact | null = null
  for (const p of parts) {
    if (p?.executableCode) {
      const code = typeof p.executableCode.code === 'string' ? p.executableCode.code : ''
      const language = typeof p.executableCode.language === 'string' ? p.executableCode.language.toLowerCase() : 'python'
      const codeKey = normalizeCodeForDedupe(code)

      // Drop a duplicate that matches the in-flight pending artifact — keep
      // pending so it can still pick up a following codeExecutionResult.
      if (pending && normalizeCodeForDedupe(pending.code) === codeKey && pending.language === language) {
        continue
      }
      // Drop a duplicate that matches the most-recently pushed artifact — that
      // copy already had its chance to pair with a result.
      const last = out[out.length - 1]
      if (!pending && last && normalizeCodeForDedupe(last.code) === codeKey && last.language === language) {
        continue
      }

      if (pending) out.push(pending)
      pending = { code, language, output: null, outcome: null }
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
    totalTokens: u.totalTokenCount ?? 0,
    cachedTokens: u.cachedContentTokenCount ?? 0,
  }
}

// Google's "search suggestion" chip — required by Gemini ToS to be shown
// whenever grounding is used. Returns the rendered HTML widget. Discord can't
// render HTML, but we can stash the URL the chip points at as a fallback link.
export function extractSearchEntryPointHtml(candidate: any): string | null {
  const html = candidate?.groundingMetadata?.searchEntryPoint?.renderedContent
  return typeof html === 'string' && html.length > 0 ? html : null
}

// True iff any part in any content has an audio/* or video/* mime, either
// inline (base64 in payload) or via fileData URI (uploaded to File API).
// Used to decide whether to drop the codeExecution tool for this turn —
// see GeminiClient.buildTools.
export function contentsHaveAudioVideo(contents: Array<{ parts?: Array<any> }>): boolean {
  for (const c of contents) {
    const parts = c?.parts
    if (!Array.isArray(parts)) continue
    for (const p of parts) {
      const inlineMime = p?.inlineData?.mimeType
      const fileMime = p?.fileData?.mimeType
      const m = (typeof inlineMime === 'string' ? inlineMime : '') ||
                (typeof fileMime === 'string' ? fileMime : '')
      if (m.startsWith('audio/') || m.startsWith('video/')) return true
    }
  }
  return false
}

// Compact preview of a tool result for in-chat display. Strings get truncated;
// objects are JSON-stringified and truncated. Long results would clutter the
// reply, so we cap aggressively.
export function previewToolResult(result: unknown): string {
  let s: string
  if (typeof result === 'string') {
    s = result
  } else {
    try { s = JSON.stringify(result) } catch { s = String(result) }
  }
  s = s.replace(/\s+/g, ' ').trim()
  return s.length > 120 ? s.slice(0, 117) + '...' : s
}

// Pull the queries Gemma actually typed into Google. Lets the user see when
// the model is misframing what it's looking up, and confirms grounding fired.
export function extractSearchQueries(candidate: any): string[] {
  const queries = candidate?.groundingMetadata?.webSearchQueries
  if (!Array.isArray(queries)) return []
  return queries.filter((q: unknown): q is string => typeof q === 'string' && q.trim().length > 0)
}

// Gemini 3 thinking models emit thought-summary parts with `thought: true`.
// extractModelText filters these out (they're not part of the user-facing
// text), so we pull them separately for optional rendering.
export function extractNativeThoughts(parts: Array<{ text?: string, thought?: boolean }> | undefined): string {
  if (!parts) return ''
  const chunks: string[] = []
  for (const p of parts) {
    if (p?.thought === true && typeof p.text === 'string') {
      chunks.push(p.text)
    }
  }
  return chunks.join('\n').trim()
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

export interface ToolCall {
  name: string
  args: Record<string, unknown>
  durationMs: number
  resultPreview: string
  failed: boolean
}

export interface RespondMetadata {
  groundingSources: GroundingSource[]
  codeArtifacts: CodeExecArtifact[]
  usage: UsageMetadata | null
  finishReason: string | null
  flaggedSafety: FlaggedSafetyRating[]
  searchQueries: string[]
  nativeThoughts: string | null
  toolCalls: ToolCall[]
  searchEntryPointHtml: string | null
}

export interface RespondResult {
  parsed: ParsedResponse
  meta: RespondMetadata
}

/**
 * Mid-stream lifecycle events emitted from gemini.ts. gemma.ts subscribes
 * via the `onEvent` callback to surface visible reactions.
 *
 * Fired at most once per type per `respond()` call (the underlying loop
 * may dispatch multiple tool calls, but the user only needs to see "she
 * used a tool" once — repeats would just thrash the reaction).
 */
export type LifecycleEvent =
  | { type: 'searching' }
  | { type: 'native_thinking' }
  | { type: 'tool_call_start', name: string }
  | { type: 'tool_call_end', name: string, failed: boolean }

export interface BuildRequestArgs {
  systemPrompt: string
  history: GeminiContent[]
  userMessageText: string
  userMediaParts: MediaPart[]
  userName: string
  channelId?: string       // Passed so we can execute channel-specific search_memory
  thinkingMode?: ThinkingMode  // default "auto"
  cacheEnabled?: boolean       // default false; opt-in via per-channel flag
  cacheTtlSec?: number         // override TTL when caching; falls back to manager default
}

export function buildUserTurn(args: BuildRequestArgs): Content {
  const textBody = `${args.userName}: ${args.userMessageText || '(no text)'}`
  const parts: Part[] = [{ text: textBody }, ...args.userMediaParts]
  return { role: 'user', parts }
}

// Strip fileData/inlineData parts whose mime is outside Gemini's allowlist.
// Belt-and-suspenders: attachments.ts filters at upload time and history.ts
// filters at cache-resurrect time, but a single rogue part anywhere in the
// request 400s the entire turn (seen with `video/text/timestamp` 2026-05-01).
// This is the last gate before the SDK call.
export function sanitizeContents(contents: Content[]): { sanitized: Content[]; dropped: Array<{ mime: string }> } {
  const dropped: Array<{ mime: string }> = []
  const sanitized = contents.map((c) => {
    const cleanedParts = (c.parts ?? []).filter((p: any) => {
      const mime = p?.fileData?.mimeType ?? p?.inlineData?.mimeType
      if (!mime) return true
      if (isAllowedMime(mime)) return true
      dropped.push({ mime })
      return false
    })
    return { ...c, parts: cleanedParts }
  })
  return { sanitized, dropped }
}

export class GeminiClient {
  private client: GoogleGenAI
  private modelName: string
  private registry: ToolRegistry
  private apiKey: string
  private cacheManager: GeminiCacheManager

  constructor(apiKey: string, modelName: string = 'gemini-2.0-flash', registry: ToolRegistry) {
    this.apiKey = apiKey
    this.registry = registry
    this.modelName = modelName
    // @google/genai is the maintained replacement for @google/generative-ai
    // (the legacy SDK was unmaintained, had a stream-parse bug, and stripped
    // unknown fields like thoughtSignature on response parsing — the latter
    // broke gemini-3 thinking models on tool-loop iteration 2 with
    // "Function call is missing a thought_signature" 400s).
    this.client = new GoogleGenAI({ apiKey })
    this.cacheManager = new GeminiCacheManager()
  }

  // Wipe in-process cache references. Called when persona reloads (so the
  // next turn rebuilds against the new persona) or when /gemini clear nukes
  // a channel's context (cache wasn't channel-specific, but clearing avoids
  // serving stale prefix to a channel that just reset).
  clearCache(): void {
    this.cacheManager.clear()
  }

  // Read-only handle for slash commands. /gemini cache info introspects
  // live cache state through here.
  listCaches(): CachedRef[] {
    return this.cacheManager.list()
  }

  // Tool list. codeExecution is omitted when the request payload contains
  // video or audio: gemini's codeExecution tool spec has stricter mime checks
  // than vanilla video understanding, and a .mov/.mp4 with embedded timed-text
  // tracks (common from QuickTime/screen recordings) trips a 400 with
  // `video/text/timestamp is not supported for code execution`. Dropping it
  // for media-bearing turns lets the model just *understand* the video
  // without the tool-spec rejecting the payload. Text-only turns keep all
  // three tools.
  private buildTools(dropCodeExec: boolean): any[] {
    const tools: any[] = [
      { googleSearch: {} },
      { functionDeclarations: this.registry.getDeclarations() }
    ]
    if (!dropCodeExec) {
      // Insert codeExecution between googleSearch and functionDeclarations to
      // preserve the order the API was previously seeing.
      tools.splice(1, 0, { codeExecution: {} })
    }
    return tools
  }

  async embed(text: string): Promise<number[]> {
    // gemini-embedding-001 is the current embedding model; text-embedding-004
    // returned 404 as of 2026-04-20. Requesting 768-dim output to match the
    // sqlite-vss schema (db.ts creates vss_messages with embedding(768)).
    // The JS SDK's embedContent doesn't expose outputDimensionality directly,
    // so we hit the REST endpoint manually.
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent?key=${this.apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: { parts: [{ text }] },
          outputDimensionality: 768
        })
      }
    )
    if (!res.ok) {
      throw new Error(`embedContent HTTP ${res.status}: ${await res.text()}`)
    }
    const data = await res.json() as { embedding?: { values?: number[] } }
    const values = data.embedding?.values
    if (!Array.isArray(values) || values.length !== 768) {
      throw new Error(`embedContent returned unexpected shape: ${JSON.stringify(data).slice(0, 200)}`)
    }
    return values
  }

  async countTokens(contents: Content[]): Promise<number> {
    const result = await this.client.models.countTokens({
      model: this.modelName,
      contents,
    })
    return result.totalTokens ?? 0
  }

  // Single-turn text completion. No streaming, no tool dispatch — used for
  // background tasks like summarization where we just want plain text out.
  async completeText(systemPrompt: string, userText: string): Promise<string> {
    const result = await this.client.models.generateContent({
      model: this.modelName,
      contents: [{ role: 'user', parts: [{ text: userText }] }],
      config: {
        systemInstruction: { role: 'system', parts: [{ text: systemPrompt }] },
      },
    })
    const candidate = result.candidates?.[0]
    const parts = (candidate?.content?.parts ?? []) as any[]
    return parts
      .filter(p => typeof p.text === 'string' && !p.executableCode && !p.codeExecutionResult && !p.functionCall)
      .map(p => p.text as string)
      .join('\n')
      .trim()
  }

  // Build the per-call config object common to both streaming and non-streaming.
  // When `cachedContentName` is provided, the cached prefix owns the
  // systemInstruction + tools + toolConfig — passing them again would
  // 400 ("cached_content cannot be set with...") so we omit them. Otherwise
  // they go on the call directly as before.
  private buildCallConfig(
    systemText: string,
    dropCodeExec: boolean,
    cachedContentName: string | null,
  ): any {
    if (cachedContentName) {
      return {
        cachedContent: cachedContentName,
        // maxOutputTokens stays per-call — it's a generation knob, not part
        // of the cached input.
        maxOutputTokens: 4096,
      }
    }
    return {
      systemInstruction: { role: 'system', parts: [{ text: systemText }] },
      tools: this.buildTools(dropCodeExec),
      // includeServerSideToolInvocations is required when mixing built-in
      // tools (googleSearch / codeExecution) with functionDeclarations.
      toolConfig: { includeServerSideToolInvocations: true } as any,
      // Hard cap to bound cost on degenerate-generation token loops (seen
      // 2026-04-29 with gemini-3-flash-preview emitting `5v57_5v57_…` to
      // max output). gemini-3-pro-preview rejects frequencyPenalty /
      // presencePenalty with 400 — rely on its instruction-following for
      // repetition resistance instead.
      maxOutputTokens: 4096,
    }
  }

  // One round-trip with the model. Handles both streaming (when onProgress
  // provided) and non-streaming, returning a unified shape so the caller's
  // tool loop doesn't branch on streaming vs not.
  //
  // onEvent fires for in-flight lifecycle signals: native thinking starts,
  // grounding-search results arrive, etc. Each event type fires at most
  // once per `runOneTurn` call (de-duped via the `emitted` set so streams
  // that yield N grounding chunks don't spam N reactions).
  private async runOneTurn(
    systemText: string,
    activeContents: Content[],
    cachedContentName: string | null,
    onProgress?: (partial: ParsedResponse) => void,
    onEvent?: (e: LifecycleEvent) => void
  ): Promise<{
    functionCall: any | null
    candidate: any
    response: any
    text: string
  }> {
    // Scan all contents — not just the latest — because tool-loop iterations
    // preserve the original media in activeContents.
    const dropCodeExec = contentsHaveAudioVideo(activeContents)
    const config = this.buildCallConfig(systemText, dropCodeExec, cachedContentName)
    const params = {
      model: this.modelName,
      contents: activeContents,
      config,
    }

    if (onProgress) {
      try {
        let accumulatedText = ''
        let functionCallReceived: any = null
        let lastChunk: any = null
        // De-dupe one-shot events across chunks within this turn.
        const emitted = new Set<LifecycleEvent['type']>()
        const emitOnce = (e: LifecycleEvent) => {
          if (emitted.has(e.type)) return
          emitted.add(e.type)
          if (onEvent) {
            try { onEvent(e) } catch (err) { console.error('[onEvent]', err) }
          }
        }
        const stream = await this.client.models.generateContentStream(params)
        for await (const chunk of stream) {
          lastChunk = chunk
          const candidate = chunk.candidates?.[0]
          const parts = candidate?.content?.parts as any[] | undefined
          // Native thinking parts: gemini-3 thinking models emit text parts
          // with `thought: true`. First time we see one, fire 🧠.
          if (parts?.some(p => p?.thought === true)) {
            emitOnce({ type: 'native_thinking' })
          }
          // Grounding search: candidate.groundingMetadata.webSearchQueries
          // populates as soon as the search runs server-side.
          if (extractSearchQueries(candidate).length > 0) {
            emitOnce({ type: 'searching' })
          }
          const fnCallPart = parts?.find(p => p.functionCall)
          if (fnCallPart) functionCallReceived = fnCallPart.functionCall
          const textChunk = extractModelText(parts)
          if (textChunk && !functionCallReceived) {
            accumulatedText += textChunk
            onProgress(parseResponse(accumulatedText, true))
          }
        }
        // The last chunk in @google/genai's stream carries the aggregated
        // candidate (including final usage_metadata). Older SDK had a
        // separate `result.response` object; the new one streams the same
        // shape and the trailing chunk is the canonical view.
        const candidate = lastChunk?.candidates?.[0]
        const parts = candidate?.content?.parts as any[] | undefined
        // Prefer streamed accumulated text; fall back to joined parts if the
        // stream yielded nothing text-ish (e.g., pure function-call turn).
        const text = accumulatedText || extractModelText(parts)
        const fnCall = functionCallReceived || parts?.find(p => p.functionCall)?.functionCall || null
        return { functionCall: fnCall, candidate, response: lastChunk, text }
      } catch (e: any) {
        const msg = e?.message ?? String(e)
        // @google/genai surfaces 400s as ApiError with status — same shape
        // for malformed parts, mime rejections, etc. Don't retry on the
        // non-streaming path; the same payload will fail the same way.
        if (e?.status === 400 || /\b400\b/.test(msg) || e?.name === 'ApiError') {
          // Pull the human-readable bit out of the SDK message.
          const reasonMatch = msg.match(/\[400[^\]]*\]\s*(.+?)(?:\n|$)/) || msg.match(/"message":\s*"([^"]+)"/)
          const reason = reasonMatch ? reasonMatch[1].trim() : msg
          console.error('[gemini 400]', reason)
          throw new GeminiRequestRejected(reason, 400)
        }
        throw e
      }
    }

    const result = await this.client.models.generateContent(params)
    const candidate = result.candidates?.[0]
    const parts = candidate?.content?.parts as any[] | undefined
    const fnCall = parts?.find(p => p.functionCall)?.functionCall || null
    const text = extractModelText(parts)
    return { functionCall: fnCall, candidate, response: result, text }
  }

  async respond(
    args: BuildRequestArgs,
    onProgress?: (partial: ParsedResponse) => void,
    onEvent?: (e: LifecycleEvent) => void
  ): Promise<RespondResult> {
    const userTurn = buildUserTurn(args)
    const systemText = formatSystemPrompt(args.systemPrompt, args.thinkingMode ?? 'auto')

    // Last-gate mime sanitization. Rogue mimes from history-cache resurrection
    // or unexpected sub-track types would 400 the entire request otherwise.
    const { sanitized: activeContents, dropped } = sanitizeContents([...args.history, userTurn])
    if (dropped.length > 0) {
      console.error(`[sanitize] dropped ${dropped.length} parts with disallowed mime: ${dropped.map(d => d.mime).join(', ')}`)
    }

    // If caching is opted into for this channel, try to resolve a cached
    // prefix name. dropCodeExec depends on activeContents, but the cache key
    // includes the tool list — for media-bearing turns we cache a different
    // tool subset, which means a separate cache. That's fine in practice
    // since most channels don't mix media into every turn.
    let cachedContentName: string | null = null
    if (args.cacheEnabled) {
      const dropCodeExec = contentsHaveAudioVideo(activeContents)
      const tools = this.buildTools(dropCodeExec)
      const toolConfig = { includeServerSideToolInvocations: true }
      cachedContentName = await this.cacheManager.getOrCreate(
        this.client, this.modelName, systemText, tools, toolConfig,
        args.cacheTtlSec,
      )
    }

    let meta: RespondMetadata | null = null
    let finalParsed: ParsedResponse = { react: null, thinking: null, reply: null }
    const toolCalls: ToolCall[] = []
    const searchQueriesAcc = new Set<string>()

    // Tool-call loop. Capped at 3 iterations to avoid runaway cost if the
    // model keeps calling tools in a cycle.
    for (let iteration = 0; iteration < 3; iteration++) {
      const turn = await this.runOneTurn(systemText, activeContents, cachedContentName, onProgress, onEvent)
      // Aggregate grounding-search queries across iterations — googleSearch can
      // fire on any turn, not just the final one.
      for (const q of extractSearchQueries(turn.candidate)) searchQueriesAcc.add(q)

      if (!turn.functionCall) {
        finalParsed = parseResponse(turn.text)
        const parts = turn.candidate?.content?.parts as any[] | undefined
        const nt = extractNativeThoughts(parts)
        const usage = extractUsage(turn.response)
        // Backfill the actual billed cached-token count so /gemini cache info
        // shows the API's real measurement instead of our char/4 estimate.
        if (cachedContentName && usage && usage.cachedTokens > 0) {
          this.cacheManager.recordCachedTokens(cachedContentName, usage.cachedTokens)
        }
        meta = {
          groundingSources: extractGroundingSources(turn.candidate),
          codeArtifacts: extractCodeArtifacts(parts),
          usage,
          finishReason: typeof turn.candidate?.finishReason === 'string' ? turn.candidate.finishReason : null,
          flaggedSafety: extractFlaggedSafety(turn.candidate),
          searchQueries: [...searchQueriesAcc],
          nativeThoughts: nt || null,
          toolCalls,
          searchEntryPointHtml: extractSearchEntryPointHtml(turn.candidate)
        }
        break
      }

      // Record the model's function call, dispatch via the registry with
      // timing + result-preview capture, and feed the result back for the next
      // iteration.
      //
      // CRITICAL: push the ORIGINAL part from the model's response, not a
      // reconstructed `{functionCall: ...}`. Gemini-3 thinking models emit a
      // `thoughtSignature` field alongside the functionCall — when we feed
      // the function response back in the next iteration, the API requires
      // that signature to verify the model's CoT lineage. Reconstructing the
      // part loses the signature and the next call 400s with
      //   "Function call is missing a thought_signature in functionCall parts"
      // (seen 2026-05-01 with gemini-3-flash-preview when fetch_url was the
      // first tool call). The legacy SDK's TS types don't expose
      // thoughtSignature but the field flows through the raw response.
      const turnParts = (turn.candidate?.content?.parts as any[] | undefined) ?? []
      const fnCallPart = turnParts.find(p => p?.functionCall) ?? { functionCall: turn.functionCall }
      activeContents.push({ role: 'model', parts: [fnCallPart] })
      const fnName = turn.functionCall.name
      const fnArgs = (turn.functionCall.args ?? {}) as Record<string, unknown>
      // Surface the tool call to the caller's lifecycle hook BEFORE we
      // dispatch — gives the user visible feedback that something tool-y
      // is in flight, instead of a quiet several-second pause.
      if (onEvent) {
        try { onEvent({ type: 'tool_call_start', name: fnName }) }
        catch (err) { console.error('[onEvent]', err) }
      }
      const t0 = Date.now()
      let result: unknown
      let failed = false
      try {
        result = await this.registry.dispatch(fnName, fnArgs, { channelId: args.channelId, gemini: this })
      } catch (e: any) {
        failed = true
        result = { error: e?.message ?? String(e) }
      }
      const durationMs = Date.now() - t0
      if (onEvent) {
        try { onEvent({ type: 'tool_call_end', name: fnName, failed }) }
        catch (err) { console.error('[onEvent]', err) }
      }
      toolCalls.push({
        name: fnName,
        args: fnArgs,
        durationMs,
        resultPreview: previewToolResult(result),
        failed
      })
      activeContents.push({
        role: 'user',
        parts: [{ functionResponse: { name: fnName, response: { result } } }]
      })
    }

    if (!meta) {
      throw new Error('Failed to complete response after maximum function call iterations.')
    }

    return { parsed: finalParsed, meta }
  }
}
