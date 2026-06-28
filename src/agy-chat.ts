import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readdirSync, statSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
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

// ── agy trajectory trace (thinking + tool calls) ────────────────────────────
//
// agy `-p` returns only the FINAL plain-text answer on stdout — no live event
// stream — so the native path's 💭 thinking block + 🔧 tool trace went dark on
// agy turns. But agy ALSO writes a structured trajectory per conversation at
//   ~/.gemini/antigravity-cli/brain/<conv-id>/.system_generated/logs/transcript_full.jsonl
// (JSONL, one step per line). That file carries the model's real reasoning
// (`thinking`) and its tool calls (`tool_calls`) on the PLANNER_RESPONSE steps.
// We snapshot the set of trajectory files+mtimes BEFORE launching agy, then
// after it returns find THIS run's trajectory (new or freshest-since-snapshot)
// and parse it. This is POST-HOC (parse-after-return), exactly how Operator's
// operator_agent.py does it — agy `-p` is one blocking call, and gemma.ts
// renders the thinking block from the FINAL parsed result + does a final
// flushStream() after respondViaAgy returns, so post-hoc emission lands in the
// same render path the native gemini path uses (no live-tail needed). The
// snapshot-before / find-freshest-after / parse-planner-steps approach mirrors
// an existing Python reference implementation that drives agy the same way.

const AGY_BRAIN_DIR =
  process.env.GEMMA_AGY_BRAIN_DIR ||
  join(homedir(), '.gemini', 'antigravity-cli', 'brain')

// A trajectory step from transcript_full.jsonl. Only the fields we read.
interface AgyTrajStep {
  step_index?: number
  source?: string
  type?: string
  thinking?: string
  tool_calls?: Array<{ name?: string; args?: Record<string, unknown> }>
  content?: string
}

// The structured result of parsing a run's trajectory: the model's real
// reasoning text (joined across planner steps) + the ordered tool-call names
// (mapped to display names). Empty/null when nothing was found.
interface AgyTrajParse {
  thinking: string | null
  toolNames: string[]
}

// Map an agy tool name (+ args) to a human display name for the 🔧 trace,
// mirroring operator_agent's _action_label intent. agy's planner tool_calls
// carry a real tool name (run_command, browser_navigate, …) and sometimes a
// `toolAction` label in args. Keep it simple: known map → gerund-from-verb →
// the raw name. The display name only feeds the tool_call_start/end events
// (which drive the transient 🔧 reaction); precision matters less than that
// SOMETHING fires, so a sensible fallback is fine.
const AGY_TOOL_LABELS: Record<string, string> = {
  run_command: 'Running command',
  browser_navigate: 'Browsing',
  browser_click: 'Clicking',
  browser_type: 'Typing',
  browser_snapshot: 'Reading',
  browser_take_screenshot: 'Screenshot',
  web_search: 'Searching',
  search: 'Searching',
  read_file: 'Reading file',
  write_file: 'Writing file',
  recall: 'Recalling',
}

function agyToolDisplayName(
  name: string,
  args: Record<string, unknown> | undefined
): string {
  const bare = (name || '').toLowerCase().replace(/^mcp__[^_]+__/, '')
  if (AGY_TOOL_LABELS[bare]) return AGY_TOOL_LABELS[bare]
  // agy sometimes hands a human label on the call args.
  const ta = args && typeof args === 'object' ? args : {}
  const label =
    (typeof ta.toolAction === 'string' && ta.toolAction.trim()) ||
    (typeof ta.toolSummary === 'string' && ta.toolSummary.trim()) ||
    ''
  if (label) return label
  return name || 'tool'
}

// Snapshot {trajectory_path -> mtimeMs} under the brain dir BEFORE launching agy,
// so we can identify THIS run's trajectory afterward (the new-or-freshest one).
// Best-effort: a missing brain dir / unreadable conv just yields fewer entries.
function snapshotAgyTrajectories(): Map<string, number> {
  const out = new Map<string, number>()
  let convs: string[]
  try {
    convs = readdirSync(AGY_BRAIN_DIR)
  } catch {
    return out // brain dir doesn't exist yet (first ever run) → empty snapshot
  }
  for (const conv of convs) {
    const tp = join(
      AGY_BRAIN_DIR,
      conv,
      '.system_generated',
      'logs',
      'transcript_full.jsonl'
    )
    try {
      out.set(tp, statSync(tp).mtimeMs)
    } catch {
      // no transcript for this conv (yet) — skip
    }
  }
  return out
}

// Find THIS run's transcript_full.jsonl: a path that's NEW since the pre-launch
// snapshot, or whose mtime advanced. Falls back to the globally-freshest if
// nothing looks new. Mirrors operator_agent._agy_find_trajectory. Returns null
// when the brain dir holds no trajectories at all.
function findAgyTrajectory(before: Map<string, number>): string | null {
  const now = snapshotAgyTrajectories()
  let best: string | null = null
  let bestM = -Infinity
  // Prefer paths that are new or whose mtime advanced past the snapshot.
  for (const [p, m] of now) {
    const prev = before.get(p)
    if (prev === undefined || m > prev) {
      if (m > bestM) { bestM = m; best = p }
    }
  }
  if (best) return best
  // Nothing "changed" — take the freshest overall (best-effort).
  for (const [p, m] of now) {
    if (m > bestM) { bestM = m; best = p }
  }
  return best
}

// Parse a run's trajectory JSONL into { thinking, toolNames }, ordered by
// step_index. Extracts `thinking` from every PLANNER_RESPONSE (MODEL source)
// and the `tool_calls` they carry. Mirrors operator_agent._agy_parse_trajectory:
// the planner tool_calls are the AUTHORITATIVE action list; we suppress the
// standalone RUN_COMMAND echo steps when any planner already carried tool_calls
// (else a tool call shows twice). USER_INPUT / CONVERSATION_HISTORY / CHECKPOINT
// are skipped (non-MODEL source). Best-effort: any error → empty parse, and the
// caller falls back to the current behavior.
function parseAgyTrajectory(path: string): AgyTrajParse {
  const empty: AgyTrajParse = { thinking: null, toolNames: [] }
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return empty
  }
  const steps: AgyTrajStep[] = []
  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (!t) continue
    try {
      steps.push(JSON.parse(t) as AgyTrajStep)
    } catch {
      // tolerate a partial/torn final line (the file is written live)
    }
  }
  if (!steps.length) return empty
  steps.sort((a, b) => (a.step_index ?? 0) - (b.step_index ?? 0))

  const anyPlannerTools = steps.some(
    (s) =>
      s.source === 'MODEL' &&
      s.type === 'PLANNER_RESPONSE' &&
      Array.isArray(s.tool_calls) &&
      s.tool_calls.length > 0
  )

  const thinkingChunks: string[] = []
  const toolNames: string[] = []
  for (const s of steps) {
    if (s.source !== 'MODEL') continue // skip USER_INPUT / CONVERSATION_HISTORY / CHECKPOINT
    if (s.type === 'PLANNER_RESPONSE') {
      if (typeof s.thinking === 'string' && s.thinking.trim()) {
        thinkingChunks.push(s.thinking.trim())
      }
      for (const tc of s.tool_calls ?? []) {
        if (!tc || typeof tc !== 'object') continue
        toolNames.push(agyToolDisplayName(tc.name ?? '', tc.args))
      }
      // s.content on the final planner is the answer text — we DON'T use it here;
      // the {thinking,reply} JSON from stdout (parse()) is the reply source of
      // truth. This parse only ADDS the real thinking + tool trace.
    } else if (!anyPlannerTools) {
      // No planner carried tool_calls in this run → surface standalone MODEL
      // non-planner steps (RUN_COMMAND, or a future browser/MCP step) as tools
      // so the 🔧 trace still fires. (When planners DID carry tool_calls, these
      // are just execution echoes — suppress to avoid duplicates.)
      if (typeof s.type === 'string') {
        toolNames.push(agyToolDisplayName(s.type, undefined))
      }
    }
  }
  return {
    thinking: thinkingChunks.length ? thinkingChunks.join('\n\n') : null,
    toolNames,
  }
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
  // Signal that thinking has started so the gemma.ts lifecycle (👀→🤔→✅) still
  // advances on this path. The trajectory parse below restores the real thinking
  // TEXT + tool trace (the native path's 💭 block + 🔧 events) post-hoc.
  input.onEvent?.({ type: 'native_thinking' })

  // Snapshot existing trajectory files+mtimes BEFORE launch so we can pick out
  // THIS run's transcript afterward (Operator's approach — see the block above).
  const trajBefore = snapshotAgyTrajectories()

  const prompt = buildPrompt(input)
  const text = await runAgy(prompt, input.onEvent)
  const parsed = parse(text)

  // POST-HOC trace restore. agy `-p` is a single blocking call; it writes the
  // trajectory DURING the run, so once it returns we read the finished file.
  // gemma.ts renders the 💭 thinking block from the FINAL parsed.thinking and
  // does one last flushStream() AFTER this function returns, so feeding the
  // trajectory thinking into parsed.thinking here lands in the exact same render
  // path the native gemini path uses — no special-casing in gemma.ts. The
  // tool_call_start/end events drive the transient 🔧 reaction (also shared with
  // the native path). All best-effort: a missing/unparseable trajectory leaves
  // the current behavior untouched (never crashes the turn).
  try {
    const trajPath = findAgyTrajectory(trajBefore)
    if (trajPath) {
      const traj = parseAgyTrajectory(trajPath)
      // Emit a start/end pair per tool call so the 🔧 trace fires on agy turns,
      // exactly like gemini.ts emits at its dispatch site. (No failure signal in
      // the trajectory — these are completed calls — so failed:false.)
      for (const name of traj.toolNames) {
        input.onEvent?.({ type: 'tool_call_start', name })
        input.onEvent?.({ type: 'tool_call_end', name, failed: false })
      }
      // Restore the real reasoning. Prefer the trajectory's thinking (the model's
      // actual chain-of-thought across planner steps) over the {thinking} the
      // JSON envelope may carry — that envelope field is a persona scratchpad,
      // whereas this is the genuine streamed reasoning we're restoring. Only
      // fall through to the envelope value when the trajectory had none.
      if (traj.thinking) {
        parsed.thinking = traj.thinking
      }
    }
  } catch (e) {
    // Trace restore is additive + best-effort: on any failure keep the plain
    // parsed reply rather than poisoning the turn.
    console.error('[agy] trajectory trace parse failed (non-fatal):', e instanceof Error ? e.message : e)
  }

  // Empty answer after a clean exit → treat as failure so we fall back to the
  // API. parseResponse never throws, but it can return an all-null parse if the
  // model emitted nothing usable.
  if (!parsed.reply && !parsed.thinking && !parsed.react) {
    throw new AgyChatError('agy returned an unparseable / empty reply', 0)
  }

  return { parsed, meta: emptyMeta() }
}
