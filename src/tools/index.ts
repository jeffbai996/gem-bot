import { ToolRegistry } from './registry.ts'
import { searchMemoryTool } from './search-memory.ts'
import { searchSquadMemoryTool } from './search-squad-memory.ts'
import { readSquadFileTool } from './read-squad-file.ts'
import { fetchUrlTool } from './fetch-url.ts'
import { connectMcpClient } from './mcp-client.ts'
import { loadIbkrTools } from './ibkr-tools.ts'
import { loadMcpTools, isMutatingTool } from './mcp-tools.ts'
import { ibkrUnreachableStub } from './ibkr-unreachable-stub.ts'

export { ToolRegistry } from './registry.ts'
export type { ToolContext } from './registry.ts'

export async function buildDefaultRegistry(): Promise<ToolRegistry> {
  const r = new ToolRegistry()
  r.register(searchMemoryTool)
  r.register(searchSquadMemoryTool)
  r.register(readSquadFileTool)
  r.register(fetchUrlTool)

  // ibkr-mcp (server_http.py) listens on :8001, not :8000. The old 8000
  // default silently fell back to the unreachable-stub on every boot.
  const ibkrUrl = process.env.IBKR_MCP_URL || 'http://127.0.0.1:8001/mcp'
  try {
    const client = await connectMcpClient(ibkrUrl)
    const tools = await loadIbkrTools(client)
    for (const t of tools) r.register(t)
    // Hand the registry the live client so its transport can be closed on
    // shutdown (and so tests can release the event loop — an unclosed
    // StreamableHTTP transport otherwise keeps Node alive forever).
    r.setMcpClient(client)
    console.error(`[ibkr] registered ${tools.length} tools from MCP at ${ibkrUrl}`)
  } catch (e: any) {
    console.error(`[ibkr] MCP connect failed at ${ibkrUrl}: ${e?.message ?? e}. Registering fallback stub.`)
    r.register(ibkrUnreachableStub)
  }

  // vecgrep MCP: semantic search over the squad's chat history, repos and
  // store. READ-ONLY — Gemma has fetch_url, so any page she reads is an
  // injection surface, and a write/propose_* tool would let fetched text
  // mutate the corpus. Filtering at LOAD rather than dispatch means the
  // writers are never registered, so there is nothing for an injected call
  // to reach.
  const vecgrepUrl = process.env.VECGREP_MCP_URL || 'http://127.0.0.1:8765/mcp'
  try {
    const vg = await connectMcpClient(vecgrepUrl)
    const vgTools = await loadMcpTools(vg, { skip: isMutatingTool })
    for (const t of vgTools) r.register(t)
    r.setMcpClient(vg)
    console.error(`[vecgrep] registered ${vgTools.length} read-only tools from ${vecgrepUrl}`)
  } catch (e: any) {
    // No stub: vecgrep being down costs her search, not her ability to run.
    console.error(`[vecgrep] MCP connect failed at ${vecgrepUrl}: ${e?.message ?? e}. Skipping.`)
  }

  // Context7: up-to-date library and framework docs. Hosted, keyless, and
  // read-only by nature — it resolves a library name and returns
  // documentation. Worth having because her own training cut-off is the
  // thing she is most often wrong about, and a docs lookup is the cheapest
  // possible fix for that.
  //
  // Text it returns lands in her context like any fetched page, so it goes
  // through the same load-time filter as vecgrep rather than being trusted
  // for being an official server.
  const context7Url = process.env.CONTEXT7_MCP_URL || 'https://mcp.context7.com/mcp'
  try {
    const c7 = await connectMcpClient(context7Url)
    const c7Tools = await loadMcpTools(c7, { skip: isMutatingTool })
    for (const t of c7Tools) r.register(t)
    r.setMcpClient(c7)
    console.error(`[context7] registered ${c7Tools.length} tools from ${context7Url}`)
  } catch (e: any) {
    // Off-box and therefore the one MCP that can be down for reasons nothing
    // here controls. Losing docs lookup must never stop her booting.
    console.error(`[context7] MCP connect failed at ${context7Url}: ${e?.message ?? e}. Skipping.`)
  }

  return r
}
