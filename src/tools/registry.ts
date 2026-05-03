import type { FunctionDeclaration } from '@google/genai'
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
    try {
      return await tool.execute(args, ctx)
    } catch (e: any) {
      return `Error in ${name}: ${e?.message ?? String(e)}`
    }
  }
}
