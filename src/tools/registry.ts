import type { FunctionDeclaration } from '@google/genai'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { GeminiClient } from '../gemini.ts'

export interface ToolContext {
  channelId?: string
  userId?: string
  gemini: GeminiClient
}

export interface Tool {
  name: string
  declaration: FunctionDeclaration
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<string>
}

export class ToolRegistry {
  private tools: Map<string, Tool> = new Map()
  private order: string[] = []
  // Optional MCP client backing the IBKR tools. Held so callers can close its
  // transport on shutdown — an unclosed StreamableHTTP transport keeps the Node
  // event loop alive (which is exactly why the registry test used to hang).
  private mcpClient: Client | null = null

  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool "${tool.name}" already registered`)
    }
    this.tools.set(tool.name, tool)
    this.order.push(tool.name)
  }

  getDeclarations(): FunctionDeclaration[] {
    return this.order.map(n => this.tools.get(n)!.declaration)
  }

  async dispatch(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    const tool = this.tools.get(name)
    if (!tool) return `Unknown tool: ${name}`
    // Owner gate for financial tools: IBKR tools expose live positions/margin/PnL.
    // Only the configured owner may invoke them — blocks other allowlisted users
    // AND prompt-injected tool calls from fetched/quoted content.
    if (name.startsWith('ibkr_')) {
      const ownerId = process.env.CC_OWNER_DISCORD_USER_ID || process.env.DISCORD_ADMIN_ID
      if (!ownerId || ctx.userId !== ownerId) {
        return `Refused: ${name} is owner-only (financial/account data) and the caller is not the owner.`
      }
    }
    try {
      return await tool.execute(args, ctx)
    } catch (e: any) {
      return `Error in ${name}: ${e?.message ?? String(e)}`
    }
  }

  // Record the MCP client whose transport must be closed to release the event
  // loop. buildDefaultRegistry sets this when it connects to the IBKR MCP server.
  setMcpClient(client: Client): void {
    this.mcpClient = client
  }

  // Close any backing MCP transport. The long-lived bot relies on process exit
  // and never calls this, but tests (and any future graceful shutdown) need it
  // so the open HTTP transport doesn't pin the event loop. Best-effort: a close
  // failure is swallowed so teardown never throws.
  async close(): Promise<void> {
    if (!this.mcpClient) return
    try {
      await this.mcpClient.close()
    } catch {
      /* already closed / transport gone — nothing to do */
    }
    this.mcpClient = null
  }
}
