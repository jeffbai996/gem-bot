import { Type } from '@google/genai'
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
    description: 'Search this channel\'s stored Discord history for FACTS from past conversations — e.g. "what did we decide about X", "what was that restaurant we talked about". Only call this when the answer genuinely depends on recalling an earlier discussion you do not already have in the current context. DO NOT use it for: questions about your own configuration / behavior / token usage / how to operate you (you cannot find those in chat history); general knowledge (you already know it); or anything answerable from the current message. If one search returns nothing useful, do NOT keep re-searching with reworded queries — just answer from what you know or say you do not have it.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: { type: Type.STRING, description: 'The semantic search query' }
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
