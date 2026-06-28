import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import type { GeminiContent } from './history.ts'
import type {
  ParsedResponse,
  RespondMetadata,
  RespondResult,
  LifecycleEvent,
} from './gemini.ts'

// Thrown on any agy failure (timeout / empty output / spawn error) so the
// gemma.ts callsite can fall back to the metered Gemini API — the bot never
// goes dark just because the flat-sub CLI hiccuped. Mirrors codex-chat.ts's
// throw-and-fall-back contract; we keep it a plain Error since there's no
// user-facing "stop"/"interrupted" distinction to draw on this path.
export class AgyChatError extends Error {
  constructor(message: string, public readonly afterMs: number) {
    super(message)
    this.name = 'AgyChatError'
  }
}

// The agy binary running under Jeff's flat Google subscription (OAuth token at
// ~/.gemini/antigravity-cli/...). Single-shot `-p` mode returns PLAIN TEXT —
// no JSON, no event stream, no usage. So this engine is much simpler than the
// codex one: build prompt → run → return the text.
const AGY_BIN = process.env.GEMMA_AGY_BIN || '/home/jbai/.local/bin/agy'

// Optional model override. agy's `--model` expects the FULL display string from
// `agy models` (e.g. "Gemini 3.5 Flash (Medium)"), not an API model id. Default
// is a sensible Flash tier; when unset we still pass an explicit Flash model so
// behavior is deterministic rather than riding agy's own default-of-the-day.
const AGY_MODEL = process.env.GEMMA_AGY_MODEL || 'Gemini 3.5 Flash (Medium)'

// Runaway-process BACKSTOP, not a turn timer. agy's own `--print-timeout`
// (default 5m) bounds the model call; this is the outer guard so a genuinely
// wedged child can't live forever. Generous (minutes) on purpose — a real
// grounded answer can take a while. On fire we SIGKILL the group and THROW so
// the caller falls back to the API.
const TIMEOUT_MS = Number(process.env.GEMMA_AGY_CHAT_TIMEOUT_MS) || 600_000

// Squad-memory on the agy path: like codex-chat.ts, we don't wire an MCP
// server — agy can run the squad-store CLI directly through its own agentic
// shell (verified: `agy --sandbox -p` self-bypasses the sandbox to reach a
// binary OUTSIDE the workspace, and the CLI POSTs/GETs the local Flask store
// over loopback). The model decides when to recall, exactly like a tool call.
// We pass the bin DIR via --add-dir so we don't RELY on that sandbox self-
// bypass, and we set SQUAD_STORE_URL in the spawn env so the CLI knows where
// the Flask store is (codex-chat.ts does the same).
const SQUAD_STORE_BIN = process.env.GEMMA_SQUAD_STORE_BIN || '/home/jbai/.local/bin/squad-store'
const SQUAD_STORE_URL = process.env.SQUAD_STORE_URL || 'http://127.0.0.1:5005'
// The directory --add-dir grants agy so squad-store (and any sibling CLI) is
// reachable without leaning on the sandbox auto-escalation. Derived from the
// bin path so a GEMMA_SQUAD_STORE_BIN override moves the granted dir with it.
const SQUAD_STORE_DIR = SQUAD_STORE_BIN.replace(/\/[^/]+$/, '')

export interface AgyChatInput {
  // The same fully-assembled system prompt gemma.ts hands gemini.respond()
  // (persona + date + response-format block). We pass it through verbatim.
  systemPrompt: string
  // gem-bot's native history shape (history.ts/formatHistory) — role + text
  // parts. fileData (image/audio) parts are skipped: agy -p is text-only.
  history: GeminiContent[]
  userMessageText: string
  userName: string
  channelId?: string
  onEvent?: (event: LifecycleEvent) => void
}

// agy -p is single-shot with no conversation memory, so we bridge the whole
// turn — persona + recent history + the new message — into one prompt, exactly
// how gemini.respond() is handed persona+history. Mirrors codex-chat.ts's
// buildPrompt, adapted to gem-bot's GeminiContent (role 'user'|'model') shape.
function buildPrompt(input: AgyChatInput): string {
  const transcript = input.history
    .map((c) => {
      // Only the text parts survive into the flat prompt — fileData parts are
      // native-media references agy -p can't consume. User text already carries
      // a "Name: …" prefix from formatHistory; label assistant turns so roles
      // stay legible in the flattened transcript.
      const text = c.parts
        .map((p) => ('text' in p ? p.text : ''))
        .filter(Boolean)
        .join(' ')
        .trim()
      if (!text) return ''
      return c.role === 'model' ? `Assistant: ${text}` : text
    })
    .filter((l) => l.trim())
    .join('\n')

  return [
    input.systemPrompt.trim(),
    '',
    '--- You are chatting in a Discord conversation. Recent history (oldest first): ---',
    transcript || '(no prior messages)',
    '--- Squad memory (use when relevant) ---',
    // Mirror codex-chat.ts: agy can shell out, so hand it the squad-store CLI
    // directly instead of an MCP server. The model runs it ITSELF when the turn
    // turns on squad-specific knowledge, then weaves the result into the reply.
    `You can search the squad's shared long-term memory — durable facts about Jeff, his ` +
      `family, his portfolio/projects, preferences, and past decisions — by running this shell ` +
      `command:\n  ${SQUAD_STORE_BIN} recall "<search query>"\nRun it BEFORE replying whenever ` +
      `the message turns on squad-specific knowledge you don't already have (a person, a ` +
      `preference, a project, prior context). Skip it for general knowledge, code, or casual ` +
      `chat — don't slow those down. The squad memory store is sensitive: only surface ` +
      `portfolio/account specifics where Jeff already is.`,
    '--- New message ---',
    `${input.userName}: ${input.userMessageText}`,
    '',
    // The system prompt already mandates the {"react","thinking","reply"} JSON
    // envelope (RESPONSE_FORMAT_BASE in gemini.ts); agy returns whatever text
    // the model emits, and parseResponse() downstream tolerates fences/preamble.
    // So we just remind it to answer as itself — the format contract is upstream.
    'Reply as yourself (the persona described above) to that new message, in the ' +
      'mandatory JSON response format described above.',
  ]
    .filter(Boolean)
    .join('\n')
}

// A RespondMetadata with every field at its empty/neutral value. The agy path
// has no token usage, no grounding, no code artifacts, no tool trace to report,
// so we hand gemma.ts a fully-populated-but-empty meta. Every downstream
// consumer in gemma.ts guards on `.length > 0` / truthiness, so empties render
// nothing rather than crashing.
function emptyMeta(): RespondMetadata {
  return {
    groundingSources: [],
    codeArtifacts: [],
    usage: null,
    finishReason: 'STOP',
    flaggedSafety: [],
    searchQueries: [],
    nativeThoughts: null,
    toolCalls: [],
    searchEntryPointHtml: null,
  }
}

// Run the agy CLI and return its plain-text stdout. THROWS (AgyChatError) on
// spawn error, non-zero exit, timeout, or empty output. Prompt is passed via an
// env var — never interpolated into a command string — so untrusted Discord
// text can't break out; and we spawn with an argv array (execFile-style), not a
// shell, so the model name's spaces and parens need no quoting/escaping.
function runAgy(prompt: string, onEvent?: (e: LifecycleEvent) => void): Promise<string> {
  const t0 = Date.now()
  // Flags MUST precede the `-p` positional: agy uses Go's flag parser, which
  // stops at the first non-flag arg — anything after `-p "<prompt>"` is ignored
  // (verified: trailing --sandbox silently dropped). --sandbox enables terminal
  // restrictions; we deliberately do NOT pass --dangerously-skip-permissions
  // since the prompt carries untrusted Discord text. --add-dir grants the
  // squad-store bin dir so agy can run the recall CLI without leaning on the
  // sandbox's auto-bypass-for-outside-binaries behavior.
  const args = ['--sandbox', '--add-dir', SQUAD_STORE_DIR, '--model', AGY_MODEL, '-p', prompt]

  return new Promise<string>((resolve, reject) => {
    let child
    try {
      child = spawn(AGY_BIN, args, {
        detached: true, // own process group so the backstop can SIGKILL the whole tree
        // SQUAD_STORE_URL tells the squad-store CLI where the loopback Flask
        // store lives, so agy's recall hits it directly (mirrors codex-chat.ts).
        env: { ...process.env, SQUAD_STORE_URL },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (e: any) {
      return reject(new AgyChatError(`agy spawn failed: ${e?.message ?? e}`, Date.now() - t0))
    }

    // Kill the whole group (agy may fork helpers), falling back to a plain kill.
    const killTree = () => {
      try { process.kill(-(child!.pid as number), 'SIGKILL') }
      catch { try { child!.kill('SIGKILL') } catch { /* already dead */ } }
    }

    let out = ''
    let err = ''
    let timedOut = false
    child.stdout!.on('data', (d) => { out += d.toString() })
    child.stderr!.on('data', (d) => { err += d.toString() })

    const timer = setTimeout(() => { timedOut = true; killTree() }, TIMEOUT_MS)

    child.on('error', (e) => {
      clearTimeout(timer)
      reject(new AgyChatError(`agy process error: ${e?.message ?? e}`, Date.now() - t0))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (timedOut) {
        return reject(new AgyChatError(`agy timed out after ${Math.round((Date.now() - t0) / 1000)}s`, Date.now() - t0))
      }
      if (code !== 0) {
        return reject(new AgyChatError(`agy exited ${code}: ${err.trim().slice(0, 300) || '(no stderr)'}`, Date.now() - t0))
      }
      const text = out.trim()
      if (!text) {
        return reject(new AgyChatError(`agy produced no output (stderr: ${err.trim().slice(0, 200) || 'none'})`, Date.now() - t0))
      }
      resolve(text)
    })
  })
}

// Run a chat turn through the Antigravity CLI (`agy`) instead of the Gemini
// API. Returns a RespondResult shaped exactly like GeminiClient.respond(), so
// the gemma.ts callsite consumes { parsed, meta } interchangeably. THROWS on any
// failure so the caller falls back to the API — this never silently returns junk.
//
// `parse` is injected (gemini.ts's parseResponse) rather than imported so this
// engine stays a thin one-job module: it owns the subprocess + prompt, not the
// JSON-envelope parsing logic that already lives in gemini.ts.
export async function respondViaAgy(
  input: AgyChatInput,
  parse: (text: string) => ParsedResponse,
): Promise<RespondResult> {
  // agy -p has no live tool trace; emit a generic thinking→done pair so the
  // gemma.ts lifecycle (👀→🤔→✅) still advances on this path.
  input.onEvent?.({ type: 'native_thinking' })

  const prompt = buildPrompt(input)
  const text = await runAgy(prompt, input.onEvent)
  const parsed = parse(text)

  // Empty answer after a clean exit → treat as failure so we fall back to the
  // API. parseResponse never throws, but it can return an all-null parse if the
  // model emitted nothing usable.
  if (!parsed.reply && !parsed.thinking && !parsed.react) {
    throw new AgyChatError('agy returned an unparseable / empty reply', 0)
  }

  return { parsed, meta: emptyMeta() }
}
