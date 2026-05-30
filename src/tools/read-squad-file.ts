import { Type } from '@google/genai'
import type { Tool } from './registry.ts'

// Squad-store HTTP API on the local bind. The /squad/... prefixed path 404s
// locally; the bare /api/files route is the one that answers on 127.0.0.1.
const SQUAD_STORE_URL = process.env.SQUAD_STORE_URL || 'http://127.0.0.1:5005'
const REQUEST_TIMEOUT_MS = 8_000
const MAX_LIST = 20
const MAX_CONTENT_CHARS = 8_000

interface FileEntry {
  id?: number
  name?: string
  type?: string
  mime?: string
  size?: number
  storage?: string
  content?: string
  tags?: string[]
  about?: string[]
  ts?: string
}

function fmtSize(n?: number): string {
  let v = typeof n === 'number' ? n : 0
  for (const unit of ['B', 'KB', 'MB', 'GB']) {
    if (v < 1024 || unit === 'GB') {
      return unit === 'B' ? `${v}B` : `${v.toFixed(1)}${unit}`
    }
    v /= 1024
  }
  return `${v}B`
}

async function squadFetch(path: string): Promise<any> {
  const url = SQUAD_STORE_URL.replace(/\/+$/, '') + path
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; gemma-bot/1.0)' },
    })
    if (!res.ok) {
      return { __error: `HTTP ${res.status} ${res.statusText}` }
    }
    return await res.json()
  } catch (e: any) {
    if (e?.name === 'AbortError') return { __error: 'timed out' }
    return { __error: e?.message ?? String(e) }
  } finally {
    clearTimeout(timer)
  }
}

// List/search shared files (metadata only) or read one file's content.
async function readSquadFiles(query?: string, id?: number): Promise<string> {
  // Read a specific file's content.
  if (typeof id === 'number' && Number.isFinite(id)) {
    const data = await squadFetch(`/api/files/${id}`)
    if (data?.__error) return `squad-files read failed: ${data.__error}`
    const f: FileEntry | undefined = data?.file
    if (!f) return `No squad file with id ${id}.`
    if (f.storage !== 'inline') {
      return `#${f.id} ${f.name} is a ${f.mime ?? 'binary'} file (${fmtSize(
        f.size,
      )}); not text-readable here. Fetch raw at /api/files/${f.id}/raw.`
    }
    let body = (f.content ?? '').trim()
    if (body.length > MAX_CONTENT_CHARS) {
      body = body.slice(0, MAX_CONTENT_CHARS) + '\n…(truncated)'
    }
    const tags =
      Array.isArray(f.tags) && f.tags.length ? ` [${f.tags.join(', ')}]` : ''
    return `#${f.id} ${f.name} (${f.type})${tags}\n\n${body}`
  }

  // List or search file metadata.
  const path = query
    ? `/api/files?q=${encodeURIComponent(query)}`
    : '/api/files'
  const data = await squadFetch(path)
  if (data?.__error) return `squad-files list failed: ${data.__error}`
  const files: FileEntry[] = Array.isArray(data?.files) ? data.files : []
  if (files.length === 0) {
    return query
      ? `No squad files matched "${query}".`
      : 'No squad files yet.'
  }
  const shown = files.slice(0, MAX_LIST)
  const lines = shown.map((f) => {
    const tags =
      Array.isArray(f.tags) && f.tags.length ? ` [${f.tags.join(', ')}]` : ''
    return `#${f.id ?? '?'} ${f.name ?? ''} (${f.type ?? '?'}, ${fmtSize(
      f.size,
    )})${tags}`
  })
  const header = query
    ? `squad-files: ${shown.length} match(es) for "${query}" — call again with the id to read one`
    : `squad-files: ${shown.length} file(s) — call again with the id to read one`
  return header + '\n' + lines.join('\n')
}

export const readSquadFileTool: Tool = {
  name: 'read_squad_file',
  declaration: {
    name: 'read_squad_file',
    description:
      "Access the shared SQUAD FILES store — whole documents (references, specs, deep-dives, notes) the squad has dropped for everyone to read. This is distinct from search_squad_memory (short atomic facts) and search_memory (chat history). Call with no arguments to list files, with a `query` to search by name/tags/content, or with an `id` to read that file's full text. Read-only.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: {
          type: Type.STRING,
          description: 'Optional keyword(s) to search file names, tags, and content.',
        },
        id: {
          type: Type.NUMBER,
          description: "A file id (from a prior list/search) to read that file's content.",
        },
      },
      required: [],
    },
  },
  async execute(args) {
    const query =
      typeof args.query === 'string' && args.query.trim().length
        ? args.query.trim()
        : undefined
    const id = typeof args.id === 'number' ? args.id : undefined
    return await readSquadFiles(query, id)
  },
}
