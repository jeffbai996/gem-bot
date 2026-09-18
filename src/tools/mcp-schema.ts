import { Type, type Schema } from '@google/genai'

type JSONSchema = Record<string, any>

// Resolve a JSON Schema $ref against a root schema's $defs/$definitions map.
// Only handles the local-anchor form "#/$defs/Foo" and "#/definitions/Foo".
// Returns the resolved schema or null when the ref can't be satisfied.
function resolveRef(ref: string, root: JSONSchema): JSONSchema | null {
  if (!ref.startsWith('#/')) return null
  const parts = ref.slice(2).split('/')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let node: any = root
  for (const part of parts) {
    if (!node || typeof node !== 'object') return null
    node = node[part]
  }
  return (node && typeof node === 'object') ? node : null
}

// Convert an MCP tool's JSON Schema to Gemini's Schema. Returns null when
// the schema can't be represented (e.g. anyOf/oneOf, or missing/unknown type).
// Callers at object-property level should skip null and log.
//
// `root` is threaded through for $ref resolution (the $defs map lives at the
// top level, so recursive calls need the same root even when descending into
// nested properties). When absent it defaults to `schema` itself (top-level call).
export function mcpSchemaToGemini(schema: unknown, root?: JSONSchema): Schema | null {
  if (!schema || typeof schema !== 'object') return null
  const s = schema as JSONSchema
  const r: JSONSchema = root ?? s

  // Resolve $ref before anything else — $ref sibling fields are ignored by spec.
  if (s.$ref) {
    const resolved = resolveRef(s.$ref, r)
    if (!resolved) return null
    return mcpSchemaToGemini(resolved, r)
  }

  // Pydantic nullable union: anyOf: [{type: T}, {type: "null"}]
  // Unwrap to the non-null branch so optional fields aren't silently dropped.
  if (s.anyOf) {
    const nonNull = (s.anyOf as JSONSchema[]).filter(
      (b) => !(b.type === 'null' || (Array.isArray(b.type) && b.type.every((t: string) => t === 'null')))
    )
    if (nonNull.length === 1) {
      const unwrapped = mcpSchemaToGemini(nonNull[0], r)
      if (unwrapped && typeof s.description === 'string') {
        (unwrapped as any).description = s.description
      }
      return unwrapped
    }
    return null
  }

  if (s.oneOf) return null

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
      const itemSchema = s.items ? mcpSchemaToGemini(s.items, r) : null
      if (itemSchema) (out as any).items = itemSchema
      break
    }
    case 'object': {
      out.type = Type.OBJECT
      const props: Record<string, Schema> = {}
      for (const [k, v] of Object.entries(s.properties ?? {})) {
        const converted = mcpSchemaToGemini(v, r)
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
