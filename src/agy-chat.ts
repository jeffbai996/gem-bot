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
  ToolCall,
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
// Default to Low thinking effort — Medium/High over-thinks for Discord chat
// turns, causing 50+ tool call loops (Jeff 2026-06-29). Override with
// GEMMA_AGY_MODEL=... for tasks that genuinely need deep reasoning.
const AGY_MODEL = process.env.GEMMA_AGY_MODEL || 'Gemini 3.5 Flash (Low)'

// Chat-scale agy wait. `agy -p` is a blocking CLI call with no streaming event
// channel; if it stalls, Discord just shows the thinking placeholder until this
// trips and the caller falls back to the API. Keep the default short enough that
// a broken agent path cannot hold the channel hostage.
const PRINT_TIMEOUT_MS = Number(process.env.GEMMA_AGY_PRINT_TIMEOUT_MS) || 30_000
// Outer runaway-process backstop. This should fire after agy's own
// --print-timeout; it exists to kill the whole process group if the CLI ignores
// or wedges past its own timer.
const TIMEOUT_MS = Number(process.env.GEMMA_AGY_CHAT_TIMEOUT_MS) || (PRINT_TIMEOUT_MS + 10_000)

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
// vecgrep CLI (semantic code/doc search). Lives in the same bin dir as
// squad-store, so the --add-dir grant below already covers it — agy reaches it
// by shelling out, NOT via MCP (agy has no MCP servers wired). Gemma wrongly
// believed vecgrep was unreachable because she was looking for an MCP tool;
// the CLI is the path on this engine.
const VECGREP_BIN = process.env.GEMMA_VECGREP_BIN || '/home/jbai/.local/bin/vecgrep'
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

  // ROOT-CAUSE fix for the raw-JSON leak (Jeff 2026-06-28): the shared system
  // prompt mandates a {react,thinking,reply} JSON envelope, but agy is a CODING
  // agent — it fumbles structured output, emitting prose around the JSON or
  // malformed JSON, which leaks the raw envelope to Discord. On the agy path we
  // DON'T need that envelope: the reply is agy's plain stdout, and thinking comes
  // from the trajectory's own `thinking` field (parsed post-hoc). So strip the
  // mandatory-JSON block from the system prompt and tell agy to reply in plain
  // prose. No JSON to parse → no leak, at the root.
  const sysNoJson = input.systemPrompt
    .trim()
    // Drop the "## Response format (mandatory)" section through to the next
    // header or end-of-string (the block that forces the JSON envelope).
    .replace(/##\s*Response format \(mandatory\)[\s\S]*?(?=\n##\s|\n*$)/i, '')
    // ALSO drop any "## Thinking override" block — formatSystemPrompt appends it
    // for thinking=always/never, and it re-references the JSON `thinking` field
    // ("populate the `thinking` field" / "set the `thinking` field to null"),
    // which would re-nudge agy back toward emitting the envelope. The agy path
    // gets its thinking from the trajectory, so this instruction is moot AND
    // harmful here — strip it too so the no-JSON contract holds in every mode.
    .replace(/##\s*Thinking override[\s\S]*?(?=\n##\s|\n*$)/i, '')
    .trim()

  // CAPABILITY OVERRIDE for the agy path (Jeff 2026-06-29). The base persona
  // tells gemma she has NO shell, NO file read/write, can't restart herself,
  // etc. — true on the native Gemini API engine, FALSE here. On agy she's a
  // real coding agent with run_command (full shell on the host), file
  // read/write, and MCP tools. So she was wrongly refusing ("I have no
  // filesystem access") on the very engine that does. Append an override that
  // supersedes the persona's "you don't have" list for THIS turn only.
  const agyCapabilities =
    '## Engine override — you are running as agy (coding agent) this turn\n' +
    "Ignore any earlier claim that you lack shell, filesystem, or MCP access. On THIS engine you DO " +
    'have a full shell on this machine (run_command → run `ls`, `cat`, `git`, `systemctl`, `curl`, ' +
    'read and write files, inspect logs). You ALSO have these MCP tool servers wired in (use them ' +
    'directly, they are real tools this turn — not something you must shell out for):\n' +
    '  • vecgrep — semantic search (`search`, `list_corpora`, `get_corpus`): find code/docs by meaning.\n' +
    '  • ibkr — Jeff\'s broker (`ibkr_get_account_summary`, `ibkr_margin`, `ibkr_get_positions`, etc.): ' +
    'account/positions/margin/quotes. This is LIVE financial data — only surface specifics where Jeff already is.\n' +
    '  • playwright — headless browser (`browser_navigate`, `browser_snapshot`, `browser_take_screenshot`, …).\n' +
    "Use them when the task needs them — actually call the tool, don't claim you can't. Two things still " +
    'hold: you remain TEXT-only (no image/audio/video GENERATION — browser screenshots are fine, they\'re ' +
    'captured not generated), and the core honesty rule is unchanged — never claim you ran something you ' +
    "didn't. If a tool genuinely errors or a server is down, say so; but don't pre-refuse work you can do here. " +
    'For casual chat, greetings, acknowledgments, or "testing" turns, answer directly without opening browser, ' +
    'MCP, shell, filesystem, or search tools.'

  // TOOL-ECONOMY directive (Jeff 2026-06-29 "thinking too much"). agy's planner
  // tends to explore exhaustively — re-reading the same file, running git diffs
  // multiple times, looping on stash operations — before answering. For a Discord
  // chat bot that's pure overhead: the user is waiting, and 50+ tool calls for a
  // simple task is a shitshow. Hard rule: plan first, then act in ≤10 targeted
  // steps. Read a file ONCE. Run a command ONCE. Don't verify what you just did.
  const toolEconomy =
    '## Tool discipline — read before using any tool\n' +
    'You are running in a Discord chat. PLAN before acting, then execute in as FEW tool calls as possible — target ≤10. Hard rules:\n' +
    '- Read a file ONCE. Never re-read what you just read.\n' +
    '- Run a shell command ONCE per operation. Never re-run to "verify" it worked.\n' +
    '- Do NOT loop on git operations (stash/apply/diff). Do what is needed, once.\n' +
    '- If the task is simple (explain, answer, summarize), do NOT open any tools at all — just reply.\n' +
    '- After ≤3 tool calls, stop, synthesize what you found, and write your reply.\n' +
    '- Prefer the MCP tools (vecgrep, ibkr) over shelling out when they apply — they are one call, not a shell loop.\n' +
    'Violating this rule means the user waits 5+ minutes for a simple answer. Be fast and decisive.'

  return [
    sysNoJson,
    '',
    agyCapabilities,
    '',
    toolEconomy,
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
    '--- vecgrep (semantic search) ---',
    // vecgrep is now wired as an MCP tool on agy (mcp_config.json, 2026-06-29),
    // so the MCP `search` tool is the primary path. The CLI still works as a
    // fallback if the MCP server is down — keep it documented but secondary.
    `vecgrep (semantic search — find code/docs by meaning, not literal keyword) is available as an ` +
      `MCP tool: call its \`search\` / \`list_corpora\` / \`get_corpus\` tools directly. Reach for it ` +
      `when the task is "find where/what mentions X" across indexed corpora. If the MCP server is ` +
      `unreachable, the CLI is a fallback: \`${VECGREP_BIN} search "<query>"\`. If a corpus you'd ` +
      `want isn't indexed, say so rather than guessing.`,
    '--- New message ---',
    `${input.userName}: ${input.userMessageText}`,
    '',
    // PLAIN-TEXT reply (no JSON envelope on the agy path — see sysNoJson above).
    // agy's stdout IS the reply; thinking is recovered separately from the
    // trajectory. So just ask for the reply as prose, no wrapper.
    'Reply as yourself (the persona described above) to that new message. Output ' +
      'ONLY your reply as plain text — no JSON, no wrapper, no preamble.',
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
// Live tool-trace polling (Jeff 2026-06-30): agy -p is a blocking, NON-streaming
// CLI — so a multi-step tool turn (search → ibkr → browser → …) shows NOTHING in
// Discord for minutes, reading as "frozen/unresponsive" even though it's working.
// agy DOES write its trajectory JSONL live during the run, so we tail it while
// the child runs and fire tool_call_start as each new tool step appears — driving
// gemma's live 🔧 trace so the user SEES progress. trajBefore + fingerprint let us
// pin THIS run's trajectory mid-flight (same disambiguation as the post-hoc read).
function runAgy(
  prompt: string,
  onEvent?: (e: LifecycleEvent) => void,
  trajBefore?: Map<string, number>,
  fingerprint?: string,
): Promise<string> {
  const t0 = Date.now()
  // Flags MUST precede the `-p` positional: agy uses Go's flag parser, which
  // stops at the first non-flag arg — anything after `-p "<prompt>"` is ignored
  // (verified: trailing --sandbox silently dropped). --sandbox enables terminal
  // restrictions; we deliberately do NOT pass --dangerously-skip-permissions
  // since the prompt carries untrusted Discord text. --add-dir grants the
  // squad-store bin dir so agy can run the recall CLI without leaning on the
  // sandbox's auto-bypass-for-outside-binaries behavior.
  const printTimeout = `${Math.max(1, Math.ceil(PRINT_TIMEOUT_MS / 1000))}s`
  const args = [
    '--sandbox',
    '--add-dir', SQUAD_STORE_DIR,
    '--model', AGY_MODEL,
    '--print-timeout', printTimeout,
    '-p', prompt,
  ]

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

    // Live trajectory tail: while agy grinds (no stdout until done), poll its
    // trajectory file and fire tool_call_start for each new tool step so the
    // Discord 🔧 trace updates live. Best-effort — any parse error is swallowed;
    // the post-hoc parse in respondViaAgy still produces the final canonical
    // trace regardless. Only runs when we have the pre-launch snapshot + onEvent.
    const emittedTools = new Set<string>()
    let livePoll: ReturnType<typeof setInterval> | null = null
    if (onEvent && trajBefore) {
      livePoll = setInterval(() => {
        try {
          const tp = findAgyTrajectory(trajBefore, fingerprint)
          if (!tp) return
          const traj = parseAgyTrajectory(tp)
          for (let i = 0; i < traj.tools.length; i++) {
            // Key by index+name so re-parsing the growing file doesn't re-emit
            // already-seen calls (same call always lands at the same index).
            const key = `${i}:${traj.tools[i].name}`
            if (emittedTools.has(key)) continue
            emittedTools.add(key)
            try { onEvent({ type: 'tool_call_start', name: traj.tools[i].name }) } catch { /* ignore */ }
          }
        } catch { /* trajectory not ready / unreadable — try next tick */ }
      }, 1200)
    }
    const stopPoll = () => { if (livePoll) { clearInterval(livePoll); livePoll = null } }

    child.on('error', (e) => {
      clearTimeout(timer)
      stopPoll()
      reject(new AgyChatError(`agy process error: ${e?.message ?? e}`, Date.now() - t0))
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      stopPoll()
      if (timedOut) {
        return reject(new AgyChatError(`agy timed out after ${Math.round((Date.now() - t0) / 1000)}s`, Date.now() - t0))
      }
      if (code !== 0) {
        const why = signal ? `signal ${signal}` : `code ${code}`
        return reject(new AgyChatError(`agy exited ${why}: ${err.trim().slice(0, 300) || '(no stderr)'}`, Date.now() - t0))
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
  created_at?: string
}

// The structured result of parsing a run's trajectory: the model's real
// reasoning text (joined across planner steps) + the ordered tool-call names
// (mapped to display names). Empty/null when nothing was found.
interface AgyTrajParse {
  thinking: string | null
  // Each tool call with a best-effort duration. agy logs only second-resolution
  // `created_at` per step (no completed_at), so we derive a call's duration as
  // the gap to the NEXT step's created_at. 0 when unknown (the trace omits the
  // [Ns] badge for 0). Real for anything that took ≥1s.
  // `diff` is set only for write_to_file steps: agy logs the full new file
  // content (CodeContent) but no unified diff, so we synthesize an all-additions
  // diff (every content line as a '+') — what a Claude-style new-file write looks
  // like. Leaving it undefined renders the call as a plain row.
  tools: Array<{ name: string; durationMs: number; diff?: string }>
  // The FINAL planner step's content — agy's actual answer text. On a multi-step
  // agentic turn, agy's stdout can carry the running "I'll do X" action narration
  // from every intermediate step (a wall — see Jeff's 2026-06-29 screenshot). The
  // last planner step (typically tools=0) is the real reply; we surface it here so
  // respondViaAgy prefers it over the raw stdout wall. Null on a 0/1-step turn
  // (then stdout IS the clean answer and we keep using it).
  answer: string | null
}

// Map an agy tool name (+ args) to a human display name for the 🔧 trace,
// mirroring operator_agent's _action_label intent. agy's planner tool_calls
// carry a real tool name (run_command, browser_navigate, …) and sometimes a
// `toolAction` label in args. Keep it simple: known map → gerund-from-verb →
// the raw name. The display name only feeds the tool_call_start/end events
// (which drive the transient 🔧 reaction); precision matters less than that
// SOMETHING fires, so a sensible fallback is fine.
// agy's REAL tool names (verified from live trajectories): run_command,
// search_web, view_file, list_dir, grep_search, write_to_file, manage_task,
// call_mcp_tool, ask_question, list_permissions. Map them to clean canonical
// labels. NOTE: these are the actual `tool_calls[].name` values — earlier keys
// (web_search/read_file/…) were guesses that never matched, which is why the
// trace fell through to agy's freeform per-call prose ("Searching <topic>") and
// read as wrong/garbage names (Jeff 2026-06-28).
// agy tool → a Claude-bot-style `Verb(detail)` label. Each entry is the display
// VERB plus the arg key whose value is the meaningful "detail" (the command, the
// query, the path). So a run_command renders `Bash(ls -la /tmp)`, a
// search renders `Search(lupine bloom)`, etc. — the actual content, like the
// Claude bots' `Bash(…)`, not 30 identical `Running command` rows (Jeff
// 2026-06-28). Verified arg keys from live trajectories.
const AGY_TOOL_SPEC: Record<string, { verb: string; argKey?: string; basename?: boolean }> = {
  run_command:    { verb: 'Bash',   argKey: 'CommandLine' },
  search_web:     { verb: 'Search', argKey: 'query' },
  view_file:      { verb: 'Read',   argKey: 'AbsolutePath', basename: true },
  write_to_file:  { verb: 'Write',  argKey: 'AbsolutePath', basename: true },
  list_dir:       { verb: 'List',   argKey: 'DirectoryPath', basename: true },
  grep_search:    { verb: 'Grep',   argKey: 'Query' },
  call_mcp_tool:  { verb: 'Tool',   argKey: 'ToolName' },
  manage_task:    { verb: 'Task' },
  ask_question:   { verb: 'Ask' },
  list_permissions: { verb: 'Permissions' },
  list_resources: { verb: 'Resources' },
  // browser tools (only reachable when an MCP browser server is wired — Operator):
  browser_navigate:        { verb: 'Browse', argKey: 'url' },
  browser_click:           { verb: 'Click' },
  browser_type:            { verb: 'Type' },
  browser_snapshot:        { verb: 'ReadPage' },
  browser_take_screenshot: { verb: 'Screenshot' },
}

function agyToolDisplayName(
  name: string,
  args: Record<string, unknown> | undefined
): string {
  const bare = (name || '').toLowerCase().replace(/^mcp__[^_]+__/, '')
  const spec = AGY_TOOL_SPEC[bare]
  // Unknown tool → show the raw name (never agy's freeform toolAction prose).
  if (!spec) return bare || name || 'tool'
  // Pull the meaningful detail from the named arg, if present.
  let detail = ''
  if (spec.argKey && args && typeof args === 'object') {
    const v = (args as Record<string, unknown>)[spec.argKey]
    if (typeof v === 'string' && v.trim()) {
      detail = v.trim().replace(/\s+/g, ' ')
      if (spec.basename) detail = detail.replace(/\/+$/, '').split('/').pop() || detail
      // Total line limit is 83. Prefix "+ ● " is 4. Assume max tail is 8.
      // Verb(detail) has spec.verb.length + 2 + detail.length.
      // So detail.length <= 83 - 4 - 8 - spec.verb.length - 2 = 69 - spec.verb.length.
      const maxDetailLen = 69 - spec.verb.length
      if (detail.length > maxDetailLen) {
        detail = detail.slice(0, Math.max(0, maxDetailLen - 1)) + '…'
      }
    }
  }
  return detail ? `${spec.verb}(${detail})` : spec.verb
}

// Synthesize a unified-diff body from an agy write_to_file step. agy logs the
// full new file content (`CodeContent`) but no diff and no prior content, so the
// best faithful render is an all-additions diff: every content line prefixed `+`,
// the way a Claude-style new-file write shows. Returns null when there's no usable
// content (so the call falls back to a plain trace row). Capped to keep the trace
// card small — the renderer also caps body lines, this is a cheap early bound.
const AGY_DIFF_MAX_LINES = 40
function agyWriteDiff(args: Record<string, unknown> | undefined): string | null {
  if (!args || typeof args !== 'object') return null
  const content = (args as Record<string, unknown>).CodeContent
  if (typeof content !== 'string' || !content.trim()) return null
  const raw = content.replace(/\n+$/, '').split('\n')
  const lines = raw.slice(0, AGY_DIFF_MAX_LINES).map(l => '+' + l)
  if (raw.length > AGY_DIFF_MAX_LINES) {
    lines.push(`+... (${raw.length - AGY_DIFF_MAX_LINES} more lines)`)
  }
  return lines.join('\n')
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
function findAgyTrajectory(before: Map<string, number>, fingerprint?: string): string | null {
  const now = snapshotAgyTrajectories()
  // Candidate set: ONLY files that are new or whose mtime advanced since the
  // pre-launch snapshot. (We deliberately do NOT fall back to "freshest overall"
  // — under concurrent multi-channel agy turns that could grab ANOTHER channel's
  // trajectory and render its thinking/tools under our reply. Better to return
  // null and keep current behavior than to attach the wrong run.)
  const changed: Array<[string, number]> = []
  for (const [p, m] of now) {
    const prev = before.get(p)
    if (prev === undefined || m > prev) changed.push([p, m])
  }
  if (!changed.length) return null
  changed.sort((a, b) => b[1] - a[1]) // freshest first
  // Disambiguate concurrent runs by content: prefer the changed trajectory whose
  // USER_INPUT contains a distinctive slice of THIS turn's message. Only one
  // channel's transcript will carry our exact user text.
  if (fingerprint && fingerprint.trim().length >= 12) {
    const fp = fingerprint.trim().slice(0, 120)
    for (const [p] of changed) {
      try {
        if (readFileSync(p, 'utf8').includes(fp)) return p
      } catch { /* unreadable — skip */ }
    }
  }
  // No fingerprint match (or none provided) → freshest changed file. Still
  // restricted to the since-snapshot set, so the blast radius is small.
  return changed[0][0]
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
  const empty: AgyTrajParse = { thinking: null, tools: [], answer: null }
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

  // Best-effort per-step duration: the gap from this step's created_at to the
  // NEXT step's created_at (when this step finished ≈ when the next began). agy
  // logs second-resolution timestamps and no completed_at, so this is coarse but
  // real — anything ≥1s shows. ms(step i) reads steps[i+1].created_at − steps[i].
  const stepMs = (i: number): number => {
    const a = steps[i]?.created_at
    const b = steps[i + 1]?.created_at
    if (!a || !b) return 0
    const ta = Date.parse(a), tb = Date.parse(b)
    if (!isFinite(ta) || !isFinite(tb) || tb <= ta) return 0
    return tb - ta
  }

  // Index of the LAST MODEL PLANNER_RESPONSE step — its content is agy's final
  // answer (the real reply). Every planner step BEFORE it is intermediate
  // action work whose `content` is the "I'll do X" narration → route those to
  // the Thinking trace (observability Jeff asked for), NOT the reply.
  let lastPlannerIdx = -1
  for (let i = steps.length - 1; i >= 0; i--) {
    if (steps[i].source === 'MODEL' && steps[i].type === 'PLANNER_RESPONSE') { lastPlannerIdx = i; break }
  }

  const thinkingChunks: string[] = []
  const tools: Array<{ name: string; durationMs: number; diff?: string }> = []
  let answer: string | null = null
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i]
    if (s.source !== 'MODEL') continue // skip USER_INPUT / CONVERSATION_HISTORY / CHECKPOINT
    if (s.type === 'PLANNER_RESPONSE') {
      const isFinal = i === lastPlannerIdx
      if (isFinal) {
        // The final planner step's content IS the answer text.
        if (typeof s.content === 'string' && s.content.trim()) answer = s.content.trim()
      }
      // Reasoning trace: prefer the real `thinking` field; otherwise fall back to
      // the step's action-narration `content` ("I'll search for X…") on every
      // NON-final step, so the Thinking block shows what agy actually did
      // step-by-step (Jeff 2026-06-29: "stream what agy is tryna do under
      // Thinking…"). The final step's content is the answer, never thinking.
      if (typeof s.thinking === 'string' && s.thinking.trim()) {
        thinkingChunks.push(s.thinking.trim())
      } else if (!isFinal && typeof s.content === 'string' && s.content.trim()) {
        thinkingChunks.push(s.content.trim())
      }
      const dur = stepMs(i)
      for (const tc of s.tool_calls ?? []) {
        if (!tc || typeof tc !== 'object') continue
        // write_to_file → attach a synthesized all-additions diff so the trace
        // card renders the edit content (not just a `Write(file)` row).
        const diff = (tc.name === 'write_to_file') ? agyWriteDiff(tc.args) : null
        tools.push({
          name: agyToolDisplayName(tc.name ?? '', tc.args),
          durationMs: dur,
          ...(diff ? { diff } : {}),
        })
      }
    } else if (!anyPlannerTools) {
      // No planner carried tool_calls in this run → surface standalone MODEL
      // non-planner steps (RUN_COMMAND, or a future browser/MCP step) as tools
      // so the 🔧 trace still fires. (When planners DID carry tool_calls, these
      // are just execution echoes — suppress to avoid duplicates.)
      if (typeof s.type === 'string') {
        tools.push({ name: agyToolDisplayName(s.type, undefined), durationMs: stepMs(i) })
      }
    }
  }
  // Thinking-trace spacing (Jeff 2026-06-29, refined): two distinct levels.
  //   WITHIN a planner step's thinking, agy double-spaces its own bold headings
  //     — collapse those internal 2+ newline runs to a single newline so the
  //     headings sit one line apart, not two.
  //   BETWEEN separate planner steps, KEEP a blank line so the blocks stay
  //     visually separated (the first collapse pass wrongly flattened these too,
  //     fusing all blocks into one wall — not what Jeff wanted).
  // So: squeeze each chunk internally first, THEN join chunks with '\n\n'.
  const thinking = thinkingChunks.length
    ? thinkingChunks.map(c => c.replace(/\n{2,}/g, '\n').trim()).join('\n\n').trim()
    : null
  return { thinking, tools, answer }
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
  // Pass trajBefore + the user message as fingerprint so runAgy can tail THIS
  // run's trajectory live and stream tool_call_start events as agy works.
  const text = await runAgy(prompt, input.onEvent, trajBefore, input.userMessageText)
  let parsed = parse(text)

  // LEAK GUARD (Jeff 2026-06-28): agy is a coding agent, not a structured-output
  // model — it sometimes emits prose around the {react,thinking,reply} JSON, or
  // malformed JSON, which makes parseResponse fall through and return the RAW
  // envelope text as the reply (the `{"react": null, "reply": "..."}` blob
  // leaking verbatim into Discord). If the reply still looks like a raw envelope,
  // pull the inner `reply` value out by hand so the user never sees the JSON.
  if (parsed.reply && /^\s*\{\s*"(?:react|thinking|reply)"\s*:/.test(parsed.reply)) {
    let recovered: string | null = null
    // First try a real JSON parse — robust to ANY field order and trailing
    // whitespace. Trim to the outermost {...} so trailing prose after the
    // object ("…} Hope that helps!") doesn't defeat JSON.parse.
    const objEnd = parsed.reply.lastIndexOf('}')
    const objStart = parsed.reply.indexOf('{')
    if (objStart >= 0 && objEnd > objStart) {
      try {
        const o = JSON.parse(parsed.reply.slice(objStart, objEnd + 1))
        if (o && typeof o.reply === 'string') recovered = o.reply
      } catch { /* fall through to regex */ }
    }
    // Regex fallback: match the `reply` value wherever it sits (NOT anchored to
    // end-of-string — reply may not be the last key, and prose may trail the
    // object), terminating at the first unescaped closing quote.
    if (recovered === null) {
      const m = parsed.reply.match(/"reply"\s*:\s*"((?:[^"\\]|\\.)*)"/)
      if (m) {
        recovered = m[1]
          .replace(/\\n/g, '\n').replace(/\\r/g, '\r')
          .replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\\\/g, '\\')
      }
    }
    if (recovered !== null && recovered.trim()) {
      parsed = { ...parsed, reply: recovered.trim() }
    }
  }

  // POST-HOC trace restore. agy `-p` is a single blocking call; it writes the
  // trajectory DURING the run, so once it returns we read the finished file.
  // gemma.ts renders the 💭 thinking block from the FINAL parsed.thinking and
  // does one last flushStream() AFTER this function returns, so feeding the
  // trajectory thinking into parsed.thinking here lands in the exact same render
  // path the native gemini path uses — no special-casing in gemma.ts. The
  // tool_call_start/end events drive the transient 🔧 reaction (also shared with
  // the native path). All best-effort: a missing/unparseable trajectory leaves
  // the current behavior untouched (never crashes the turn).
  //
  // We ALSO materialize the trajectory tool names into meta.toolCalls so the
  // dedicated 🔧 Tool-trace card renders on agy turns, not just native ones (the
  // card reads meta.toolCalls, the single trace surface). agy `-p`
  // gives no per-call timing/args/output — it's a post-hoc trajectory — so each
  // entry carries empty args, durationMs:0 (the card omits the [Nms] badge when
  // <=0), no resultPreview, failed:false (no failure signal in the trajectory).
  const toolCalls: ToolCall[] = []
  try {
    const trajPath = findAgyTrajectory(trajBefore, input.userMessageText)
    if (trajPath) {
      const traj = parseAgyTrajectory(trajPath)
      // Emit a start/end pair per tool call so the 🔧 trace fires on agy turns,
      // exactly like gemini.ts emits at its dispatch site. (No failure signal in
      // the trajectory — these are completed calls — so failed:false.)
      for (const { name, durationMs, diff } of traj.tools) {
        input.onEvent?.({ type: 'tool_call_start', name })
        input.onEvent?.({ type: 'tool_call_end', name, failed: false })
        toolCalls.push({ name, args: {}, durationMs, resultPreview: '', failed: false, ...(diff ? { diff } : {}) })
      }
      // Restore the real reasoning. Prefer the trajectory's thinking (the model's
      // actual chain-of-thought across planner steps) over the {thinking} the
      // JSON envelope may carry — that envelope field is a persona scratchpad,
      // whereas this is the genuine streamed reasoning we're restoring. Only
      // fall through to the envelope value when the trajectory had none.
      if (traj.thinking) {
        parsed.thinking = traj.thinking
      }
      // Prefer the trajectory's FINAL-step answer over the raw stdout reply when
      // they diverge (Jeff 2026-06-29 "fucked it bad" screenshot): on a multi-step
      // agentic turn, agy's stdout carried the running "I'll do X" action
      // narration from every intermediate step — a wall. The last planner step's
      // content is the clean answer; the per-step narration is now in traj.thinking
      // (the observable Thinking block). Only override when the trajectory answer
      // is materially SHORTER (the wall is longer than the clean answer) so a
      // 0/1-step turn — where stdout already IS the clean answer — is untouched.
      if (traj.answer && parsed.reply && traj.answer.length < parsed.reply.trim().length) {
        parsed.reply = traj.answer
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

  return { parsed, meta: { ...emptyMeta(), toolCalls } }
}
