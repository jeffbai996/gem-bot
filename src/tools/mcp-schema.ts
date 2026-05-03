import { Type, type Schema } from '@google/genai'

type JSONSchema = Record<string, any>

// Convert an MCP tool's JSON Schema to Gemini's Schema. Returns null when
// the schema can't be represented (e.g. anyOf/oneOf, or missing/unknown type).
// Callers at object-property level should skip null and log.
export function mcpSchemaToGemini(schema: unknown): Schema | null {
  if (!schema || typeof schema !== 'object') return null
  const s = schema as JSONSchema

  if (s.anyOf || s.oneOf) return null

  // Normalize `{type: ["string", "null"]}` to the non-null primitive.
  let type = s.type
  if (Array.isArray(type)) {
    const nonNull = type.filter((t: string) => t !== 'null')
    if (nonNull.length !== 1) return null
    type = nonNull[0]
  }

  if (typeof type !== 'string') return null

  const out: Schema = {} as Schema

  switch (type) {
    case 'string':
      out.type = Type.STRING
      break
    case 'number':
    case 'integer':
      out.type = Type.NUMBER
      break
    case 'boolean':
      out.type = Type.BOOLEAN
      break
    case 'array': {
      out.type = Type.ARRAY
      const itemSchema = s.items ? mcpSchemaToGemini(s.items) : null
      if (itemSchema) (out as any).items = itemSchema
      break
    }
    case 'object': {
      out.type = Type.OBJECT
      const props: Record<string, Schema> = {}
      for (const [k, v] of Object.entries(s.properties ?? {})) {
        const converted = mcpSchemaToGemini(v)
        if (converted) {
          props[k] = converted
        } else {
          console.error(`[mcp-schema] skipping unrepresentable property "${k}"`)
        }
      }
      ;(out as any).properties = props
      const required: string[] = Array.isArray(s.required) ? s.required.filter((r: string) => r in props) : []
      ;(out as any).required = required
      break
    }
    default:
      return null
  }

  if (typeof s.description === 'string') (out as any).description = s.description
  if (Array.isArray(s.enum)) (out as any).enum = s.enum
  return out
}
