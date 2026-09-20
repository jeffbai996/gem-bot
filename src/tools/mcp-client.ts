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

// Reconnect errors: these indicate the SSE session expired or the server
// dropped the connection. The StreamableHTTPClientTransport uses persistent
// sessions; after a long idle the server may terminate the session, causing
// the next callTool to fail with one of these patterns.
const RECONNECT_ERRORS = /session.*not found|session.*expired|connection.*closed|connection.*reset|transport.*closed|ECONNRESET|ECONNREFUSED|socket hang up/i

/**
 * Wraps an MCP Client so that transport-level errors on `callTool` trigger a
 * single reconnect-and-retry before propagating. This makes long-lived
 * connections (IBKR, vecgrep) resilient to idle session expiry without
 * requiring a bot restart. Subsequent calls after a reconnect use the fresh
 * client transparently.
 *
 * Returns a Client-compatible object (duck-typed: callTool, listTools, close).
 * The ToolRegistry stores it via setMcpClient; the real Client type is only
 * used for `close` on shutdown, which we forward to whatever is current.
 */
export function withReconnect(
  initialClient: Client,
  serverUrl: string,
  connector: (url: string) => Promise<Client> = connectMcpClient,
): Client {
  let current = initialClient

  const self: Client = {
    get callTool() {
      return async (params: any) => {
        try {
          return await current.callTool(params)
        } catch (e: any) {
          if (!RECONNECT_ERRORS.test(e?.message ?? '')) throw e
          // Session dropped — reconnect and retry once.
          console.error(`[mcp] session error on ${params?.name ?? 'unknown'}, reconnecting to ${serverUrl}: ${e.message}`)
          try { await current.close() } catch { /* already gone */ }
          current = await connector(serverUrl)
          console.error(`[mcp] reconnected to ${serverUrl}`)
          return await current.callTool(params)
        }
      }
    },
    get listTools() {
      return (...args: any[]) => (current.listTools as any)(...args)
    },
    get close() {
      return (...args: any[]) => (current.close as any)(...args)
    },
  } as unknown as Client

  return self
}
