import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { Tool } from './registry.ts'
import { loadMcpTools } from './mcp-tools.ts'

// The loader was never IBKR-specific — it wraps whatever an MCP client
// advertises. Kept as a named export because index.ts and the tests import it;
// the generic version lives in mcp-tools.ts so vecgrep can share it.
export async function loadIbkrTools(client: Client): Promise<Tool[]> {
  return loadMcpTools(client)
}
