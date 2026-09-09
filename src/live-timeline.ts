import path from 'node:path'

import type { LiveTimelineStep } from './gemini.ts'

interface ToolFinish {
  failed: boolean
  durationMs?: number
  resultPreview?: string
  diff?: string
}

interface ToolPresentation {
  key: string
  text: string
  detail?: string
}

const DETAIL_KEYS = [
  'command', 'CommandLine', 'cmd',
  'query', 'Query', 'url', 'URL', 'AbsolutePath', 'path', 'file', 'filename',
  'DirectoryPath', 'pattern', 'symbol', 'symbols', 'ticker',
]

function cleanDetail(value: unknown, basename: boolean): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined
  let detail = value.trim().replace(/\s+/g, ' ')
  if (/^https?:\/\//i.test(detail)) {
    try {
      const url = new URL(detail)
      detail = `${url.host}${url.pathname === '/' ? '' : url.pathname}`
    } catch { /* retain the original string */ }
  } else if (basename) {
    detail = path.basename(detail.replace(/\/+$/, '')) || detail
  }
  return detail.length > 140 ? `${detail.slice(0, 139)}…` : detail
}

function unwrapTool(name: string, args: Record<string, unknown>): { name: string, args: Record<string, unknown> } {
  if (name !== 'call_mcp_tool') return { name, args }
  const innerName = typeof args.ToolName === 'string' ? args.ToolName : name
  let innerArgs = args.Arguments && typeof args.Arguments === 'object'
    ? args.Arguments as Record<string, unknown>
    : {}
  if (innerArgs.params && typeof innerArgs.params === 'object') {
    innerArgs = innerArgs.params as Record<string, unknown>
  }
  return { name: innerName, args: innerArgs }
}

export function describeToolAction(name: string, args: Record<string, unknown> = {}): ToolPresentation {
  // AGY emits preformatted Verb(target) names before its authoritative snapshot.
  // Preserve those targets rather than classifying the entire string as a tool.
  const formatted = name.match(/^(Bash|Run|Read|Write|Search|Grep|List|Browse|Click|Type|ReadPage|Screenshot)\((.*)\)$/s)
  if (formatted) return { key: name, text: formatted[1], detail: formatted[2] }
  const unwrapped = unwrapTool(name, args)
  const bare = unwrapped.name.toLocaleLowerCase('en-US').replace(/^mcp__[^_]+__/, '')
  const text = /screenshot|capture/.test(bare) ? 'Screenshot'
    : /click/.test(bare) ? 'Click'
    : /type|fill/.test(bare) ? 'Type'
    : /search|grep|recall|find/.test(bare) ? 'Search'
    : /fetch|browse|navigate|open_url/.test(bare) ? 'Browse'
    : /write|edit|patch|replace/.test(bare) ? 'Write'
    : /read|view|get_file/.test(bare) ? 'Read'
    : /list/.test(bare) ? 'List'
    : /exec|run|bash|shell|command/.test(bare) ? 'Run'
    : bare.split(/[_-]+/).filter(Boolean).map(part => part[0]?.toUpperCase() + part.slice(1)).join(' ') || 'Use tool'
  const basename = /read|view|write|edit|patch|file|list/.test(bare)
  const detailKey = DETAIL_KEYS.find(key => unwrapped.args[key] !== undefined)
  const detail = cleanDetail(detailKey ? unwrapped.args[detailKey] : undefined, basename)
  return { key: unwrapped.name, text, ...(detail ? { detail } : {}) }
}

export function visibleTimelineSteps(
  steps: LiveTimelineStep[],
  traceMode: 'off' | 'on' | 'live' | 'collapse',
): LiveTimelineStep[] {
  return traceMode === 'off' ? steps.filter(step => step.kind === 'thinking') : steps
}

/** Mutable per-turn trajectory assembled from either Gemini API stream events
 * or an authoritative Antigravity trajectory snapshot. Result bodies stay in
 * the opt-in detailed tool trace; this compact timeline carries only action,
 * target, state, and duration. */
export class LiveTimelineBuffer {
  private steps: LiveTimelineStep[] = []
  private runningTools: Array<{ key: string, index: number }> = []
  private searches = new Set<string>()

  pushThought(fragment: string): void {
    if (!fragment) return
    const last = this.steps.at(-1)
    if (last?.kind === 'thinking') {
      if (fragment.startsWith(last.text)) {
        last.text = fragment.trimStart()
      } else if (!last.text.endsWith(fragment)) {
        last.text += fragment
      }
      return
    }
    const text = fragment.trimStart()
    if (text.trim()) this.steps.push({ kind: 'thinking', text })
  }

  pushSearch(queries: string[]): void {
    for (const raw of queries) {
      const query = raw.trim()
      if (!query || this.searches.has(query)) continue
      this.searches.add(query)
      this.steps.push({ kind: 'action', text: 'Search', detail: query, status: 'done' })
    }
  }

  startTool(name: string, args: Record<string, unknown> = {}): void {
    const shown = describeToolAction(name, args)
    const index = this.steps.push({
      kind: 'action',
      text: shown.text,
      ...(shown.detail ? { detail: shown.detail } : {}),
      status: 'running',
    }) - 1
    this.runningTools.push({ key: shown.key, index })
  }

  finishTool(name: string, finish: ToolFinish, args: Record<string, unknown> = {}): void {
    const key = describeToolAction(name, args).key
    let runningIndex = -1
    for (let i = this.runningTools.length - 1; i >= 0; i--) {
      if (this.runningTools[i].key === key) {
        runningIndex = i
        break
      }
    }
    if (runningIndex < 0) {
      this.startTool(name, args)
      runningIndex = this.runningTools.length - 1
    }
    const [{ index }] = this.runningTools.splice(runningIndex, 1)
    const step = this.steps[index]
    if (!step || step.kind !== 'action') return
    step.status = finish.failed ? 'failed' : 'done'
    if (finish.diff) step.diff = finish.diff
    if (finish.durationMs && finish.durationMs > 0) step.durationMs = finish.durationMs
  }

  replace(steps: LiveTimelineStep[]): void {
    this.steps = steps.map(step => ({ ...step }))
    this.runningTools = []
    this.searches.clear()
  }

  snapshot(): LiveTimelineStep[] {
    return this.steps.map(step => ({
      ...step,
      ...(step.kind === 'thinking' ? { text: step.text.trim() } : {}),
    }))
  }
}
