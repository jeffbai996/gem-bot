import { ToolRegistry } from './registry.ts'
import { searchMemoryTool } from './search-memory.ts'
import { ibkrBriefingTool } from './ibkr-briefing.ts'

export { ToolRegistry } from './registry.ts'
export type { Tool, ToolContext } from './registry.ts'

export function buildDefaultRegistry(): ToolRegistry {
  const r = new ToolRegistry()
  r.register(searchMemoryTool)
  r.register(ibkrBriefingTool)
  return r
}
