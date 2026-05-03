import { Type } from '@google/genai'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { Tool } from './registry.ts'
import { mcpSchemaToGemini } from './mcp-schema.ts'

// Discover MCP tools from a connected client and wrap each as a Gemma Tool.
// Each tool's execute() forwards to client.callTool and returns the text
// content blocks joined as a single string.
export async function loadIbkrTools(client: Client): Promise<Tool[]> {
  const { tools: mcpTools } = await client.listTools()
  const out: Tool[] = []
  for (const t of mcpTools) {
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
