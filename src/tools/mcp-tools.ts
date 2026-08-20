import { Type } from '@google/genai'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { Tool } from './registry.ts'
import { mcpSchemaToGemini } from './mcp-schema.ts'

// Names that mutate a corpus rather than read one. Gemma has fetch_url, so
// anything she fetches is an injection surface — a page saying "now call
// propose_delete" must not have a delete tool to reach. The IBKR tools solve
// the same problem with an owner gate in the registry; for a knowledge store
// the cleaner answer is simply not to register the write half.
const MUTATING = /^(write|edit|propose_|delete|merge)/

export function isMutatingTool(name: string): boolean {
  return MUTATING.test(name)
}

/**
 * Discover MCP tools from a connected client and wrap each as a Gemma Tool.
 *
 * `skip` filters by tool name before registration — a tool that is never
 * registered cannot be called, which is a stronger guarantee than refusing it
 * at dispatch time.
 */
export async function loadMcpTools(
  client: Client,
  opts: { skip?: (name: string) => boolean } = {}
): Promise<Tool[]> {
  const { tools: mcpTools } = await client.listTools()
  const out: Tool[] = []
  for (const t of mcpTools) {
    if (opts.skip?.(t.name)) continue
    const converted = mcpSchemaToGemini(t.inputSchema)
    const params = converted ?? { type: Type.OBJECT, properties: {}, required: [] }
    out.push({
      name: t.name,
      declaration: {
        name: t.name,
        description: t.description ?? `MCP tool ${t.name}`,
        parameters: params
      },
      async execute(args, _ctx) {
        const res = await client.callTool({ name: t.name, arguments: args })
        const parts = (res.content as any[]) ?? []
        return parts.map(p => p?.type === 'text' ? p.text : JSON.stringify(p)).join('\n') || '[empty response]'
      }
    })
  }
  return out
}
