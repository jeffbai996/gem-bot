import { Type } from '@google/genai'
import type { Tool } from './registry.ts'

// Registered only when MCP connect fails at boot. Gives the model a valid
// function-call target so it can explain the situation instead of having no
// IBKR-shaped tool available.
export const ibkrUnreachableStub: Tool = {
  name: 'ibkr_briefing',
  declaration: {
    name: 'ibkr_briefing',
    description: 'Get a portfolio briefing from IBKR. Currently UNREACHABLE — IBKR MCP server is not running. Calling this tool will return an error string explaining the situation.',
    parameters: { type: Type.OBJECT, properties: {}, required: [] }
  },
  async execute() {
    return 'IBKR MCP server is not reachable. Tell the user their IBKR connection is offline and they should start the MCP server at $IBKR_MCP_URL.'
  }
}
