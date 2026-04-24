import { ToolRegistry } from './registry.ts'
import { searchMemoryTool } from './search-memory.ts'
import { connectMcpClient } from './mcp-client.ts'
import { loadIbkrTools } from './ibkr-tools.ts'
import { ibkrUnreachableStub } from './ibkr-unreachable-stub.ts'

export { ToolRegistry } from './registry.ts'
export type { Tool, ToolContext } from './registry.ts'

export async function buildDefaultRegistry(): Promise<ToolRegistry> {
  const r = new ToolRegistry()
  r.register(searchMemoryTool)

  const ibkrUrl = process.env.IBKR_MCP_URL || 'http://127.0.0.1:8000/mcp'
  try {
    const client = await connectMcpClient(ibkrUrl)
    const tools = await loadIbkrTools(client)
    for (const t of tools) r.register(t)
    console.error(`[ibkr] registered ${tools.length} tools from MCP at ${ibkrUrl}`)
  } catch (e: any) {
    console.error(`[ibkr] MCP connect failed at ${ibkrUrl}: ${e?.message ?? e}. Registering fallback stub.`)
    r.register(ibkrUnreachableStub)
  }

  return r
}
