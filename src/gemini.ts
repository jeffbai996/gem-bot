import { GoogleGenerativeAI, SchemaType, type Content, type Part } from '@google/generative-ai'
import type { GeminiContent } from './history.ts'
import type { InlinePart, FilePart } from './attachments.ts'

export interface ParsedResponse {
  react: string | null
  reply: string | null
}

export function parseResponse(text: string): ParsedResponse {
  try {
    const obj = JSON.parse(text)
    const react = typeof obj.react === 'string' && obj.react.length > 0 ? obj.react : null
    const reply = typeof obj.reply === 'string' && obj.reply.length > 0 ? obj.reply : null
    return { react, reply }
  } catch {
    // Gemini returned something that isn't JSON — treat the whole text as the reply
    return { react: null, reply: text.trim() || null }
  }
}

export interface BuildRequestArgs {
  systemPrompt: string
  history: GeminiContent[]
  userMessageText: string
  userMediaParts: Array<InlinePart | FilePart>
  userName: string
}

export function buildUserTurn(args: BuildRequestArgs): Content {
  const textBody = `${args.userName}: ${args.userMessageText || '(no text)'}`
  const parts: Part[] = [{ text: textBody }, ...args.userMediaParts]
  return { role: 'user', parts }
}

export class GeminiClient {
  private model: ReturnType<GoogleGenerativeAI['getGenerativeModel']>

  constructor(apiKey: string, modelName: string = 'gemini-2.0-flash') {
    const genAI = new GoogleGenerativeAI(apiKey)
    this.model = genAI.getGenerativeModel({
      model: modelName,
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: SchemaType.OBJECT,
          properties: {
            react: { type: SchemaType.STRING, nullable: true },
            reply: { type: SchemaType.STRING, nullable: true }
          },
          required: ['react', 'reply']
        }
      }
    })
  }

  async respond(args: BuildRequestArgs): Promise<ParsedResponse> {
    const userTurn = buildUserTurn(args)
    const result = await this.model.generateContent({
      systemInstruction: { role: 'system', parts: [{ text: args.systemPrompt }] },
      contents: [...args.history, userTurn]
    })
    const text = result.response.text()
    return parseResponse(text)
  }
}
