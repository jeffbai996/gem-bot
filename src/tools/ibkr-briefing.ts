import { SchemaType } from '@google/generative-ai'
import type { Tool } from './registry.ts'

export const ibkrBriefingTool: Tool = {
  name: 'ibkr_briefing',
  declaration: {
    name: 'ibkr_briefing',
    description: 'Get a portfolio briefing from IBKR: positions, P&L, margin, top movers. Use when asked about portfolio state, holdings, margin status, or "how\'s the book".',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {},
      required: []
    }
  },
  async execute(_args, _ctx) {
    return '[stub: IBKR briefing not yet wired. Registry plumbing is working — this tool will be implemented when IBKR transport from HOST is settled.]'
  }
}
