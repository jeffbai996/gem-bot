import { SchemaType } from '@google/generative-ai'
import type { Tool } from './registry.ts'
import { searchMessages, type SearchResult } from '../db.ts'

export function formatSearchResults(results: SearchResult[]): string {
  if (results.length === 0) return 'No matching messages found in memory.'
  return results.map(r => `[${r.timestamp}] ${r.author_name}: ${r.content}`).join('\n')
}

export const searchMemoryTool: Tool = {
  name: 'search_memory',
  declaration: {
    name: 'search_memory',
    description: 'Search past Discord messages for context by semantic meaning. Use this when asked about past events, previous discussions, or if you need more context from history.',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        query: { type: SchemaType.STRING, description: 'The semantic search query' }
      },
      required: ['query']
    }
  },
  async execute(args, ctx) {
    if (!ctx.channelId) {
      return 'search_memory requires a channel context; none was provided.'
    }
    const query = args.query
    if (typeof query !== 'string' || query.length === 0) {
      return 'search_memory requires a non-empty "query" string argument.'
    }
    console.error(`[RAG] Searching memory for query: "${query}" in channel ${ctx.channelId}`)
    const queryEmb = await ctx.gemini.embed(query)
    const results = searchMessages(ctx.channelId, queryEmb, 10)
    return formatSearchResults(results)
  }
}
