// Standalone repro for the "riri tool-loop" — drives GeminiClient.respond()
// directly with a "who is riri" turn so we can read the [loop-diag] output
// without needing a live Discord ping. Uses the real search tools (squad-store
// + RAG) and the same model the bot runs (GEMINI_MODEL from .env).
//
// Run: cd ~/repos/gem-bot && node --import tsx/esm scripts/repro-riri-loop.ts
import 'dotenv/config'
import { GeminiClient } from '../src/gemini.ts'
import { ToolRegistry } from '../src/tools/registry.ts'
import { searchMemoryTool } from '../src/tools/search-memory.ts'
import { searchSquadMemoryTool } from '../src/tools/search-squad-memory.ts'
import { readSquadFileTool } from '../src/tools/read-squad-file.ts'

const apiKey = process.env.GEMINI_API_KEY
if (!apiKey) { console.error('FATAL: GEMINI_API_KEY missing'); process.exit(1) }
const model = process.env.GEMINI_MODEL || 'gemini-3-flash-preview'

const registry = new ToolRegistry()
registry.register(searchMemoryTool)
registry.register(searchSquadMemoryTool)
registry.register(readSquadFileTool)

const client = new GeminiClient(apiKey, model, registry)

console.error(`[repro] model=${model} — asking "who is riri"`)
const res = await client.respond(
  {
    systemPrompt: 'You are Gemma, a helpful Discord bot. Answer from squad memory when asked about people.',
    history: [],
    userMessageText: 'who is riri?',
    userMediaParts: [],
    userName: 'Jeff',
    channelId: '1491337341619671111',
    thinkingMode: 'auto',
    cacheEnabled: false,
  },
  undefined,
  (e) => console.error(`[event] ${JSON.stringify(e)}`)
)

console.error('\n[repro] === RESULT ===')
console.error('finishReason:', res.meta.finishReason)
console.error('toolCalls:', res.meta.toolCalls.map(t => `${t.name}(${JSON.stringify(t.args)})`).join(' → '))
console.error('reply:', res.parsed.reply)
