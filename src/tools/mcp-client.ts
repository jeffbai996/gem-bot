import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

// Connect to an MCP server over streamable HTTP. Caller owns the returned
// Client and is responsible for keeping it alive (or closing it on shutdown).
export async function connectMcpClient(url: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(url))
  const client = new Client(
    { name: 'gemma-discord-bot', version: '1.0.0' },
    { capabilities: {} }
  )
  await client.connect(transport)
  return client
}
