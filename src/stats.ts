import { readFileSync, writeFileSync } from 'node:fs'
import { formatCodeCard } from './discord-card.ts'

export interface UsageInput {
  promptTokens: number
  responseTokens: number
  cachedTokens: number
  totalTokens: number
}

export interface TurnStat {
  engine: 'agy' | 'api'
  model: string
  elapsedMs: number
  usage: UsageInput | null
}

export interface Totals {
  turns: number
  elapsedMs: number
  promptTokens: number
  responseTokens: number
  cachedTokens: number
  byEngine: Record<'agy' | 'api', number>
  byModel: Record<string, number>
}

interface PersistedStats {
  since: number
  all: Totals
  days: Record<string, Totals>
}

export interface StatsSnapshot {
  bootTs: number
  since: number
  all: Totals
  today: Totals
}

function emptyTotals(): Totals {
  return {
    turns: 0, elapsedMs: 0, promptTokens: 0, responseTokens: 0, cachedTokens: 0,
    byEngine: { agy: 0, api: 0 }, byModel: {},
  }
}

export function pacificDay(ts = Date.now()): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(ts))
  const part = (type: string) => parts.find(p => p.type === type)?.value ?? ''
  return `${part('year')}-${part('month')}-${part('day')}`
}

function addTurn(totals: Totals, turn: TurnStat): void {
  totals.turns++
  totals.elapsedMs += Math.max(0, turn.elapsedMs)
  totals.byEngine[turn.engine]++
  totals.byModel[turn.model] = (totals.byModel[turn.model] ?? 0) + 1
  if (turn.usage) {
    totals.promptTokens += turn.usage.promptTokens
    totals.responseTokens += turn.usage.responseTokens
    totals.cachedTokens += turn.usage.cachedTokens
  }
}

function normalizeTotals(raw: Partial<Totals> | undefined): Totals {
  const empty = emptyTotals()
  return {
    turns: raw?.turns ?? 0,
    elapsedMs: raw?.elapsedMs ?? 0,
    promptTokens: raw?.promptTokens ?? 0,
    responseTokens: raw?.responseTokens ?? 0,
    cachedTokens: raw?.cachedTokens ?? 0,
    byEngine: { ...empty.byEngine, ...raw?.byEngine },
    byModel: raw?.byModel && typeof raw.byModel === 'object' ? { ...raw.byModel } : {},
  }
}

export class GemStats {
  private readonly bootTs: number
  private state: PersistedStats

  constructor(private readonly file: string, now = Date.now()) {
    this.bootTs = now
    this.state = { since: now, all: emptyTotals(), days: {} }
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<PersistedStats>
      this.state.since = raw.since ?? now
      this.state.all = normalizeTotals(raw.all)
      this.state.days = Object.fromEntries(
        Object.entries(raw.days ?? {}).map(([day, totals]) => [day, normalizeTotals(totals)])
      )
    } catch {
      // Fresh or unreadable telemetry starts clean; chat must never fail for stats.
    }
  }

  record(turn: TurnStat, now = Date.now()): void {
    addTurn(this.state.all, turn)
    const day = pacificDay(now)
    const daily = this.state.days[day] ?? emptyTotals()
    addTurn(daily, turn)
    this.state.days[day] = daily
    this.state.days = Object.fromEntries(
      Object.entries(this.state.days).sort(([a], [b]) => b.localeCompare(a)).slice(0, 45)
    )
    try {
      writeFileSync(this.file, JSON.stringify(this.state))
    } catch {
      // Best effort: losing telemetry is preferable to breaking a reply.
    }
  }

  snapshot(now = Date.now()): StatsSnapshot {
    return structuredClone({
      bootTs: this.bootTs,
      since: this.state.since,
      all: this.state.all,
      today: this.state.days[pacificDay(now)] ?? emptyTotals(),
    })
  }
}

function humanTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`
  if (value >= 10_000) return `${Math.round(value / 1_000)}k`
  return value.toLocaleString('en-US')
}

export function formatStats(snapshot: StatsSnapshot, now = Date.now()): string {
  const g = snapshot.all
  const upMin = Math.floor((now - snapshot.bootTs) / 60_000)
  const cachePct = g.promptTokens > 0 ? Math.round((g.cachedTokens / g.promptTokens) * 100) : 0
  const lines = [
    `turns:    ${g.turns.toLocaleString('en-US')}  (today ${snapshot.today.turns.toLocaleString('en-US')})`,
  ]
  if (g.promptTokens > 0 || g.responseTokens > 0) {
    lines.push(
      `input:    ${humanTokens(g.promptTokens)} tok  (${humanTokens(g.cachedTokens)} cached, ${cachePct}%)`,
      `output:   ${humanTokens(g.responseTokens)} tok`,
      `total:    ${humanTokens(g.promptTokens + g.responseTokens)} tok`,
      '',
    )
  }
  const engines = (['agy', 'api'] as const)
    .filter(engine => g.byEngine[engine] > 0)
    .map(engine => `${engine} ${g.byEngine[engine].toLocaleString('en-US')}`)
    .join(' · ') || '—'
  const models = Object.entries(g.byModel).map(([model, turns]) => `${model} ${turns}`).join(' · ') || '—'
  lines.push(
    `engines:  ${engines}`,
    `models:   ${models}`,
    `runtime:  ${(g.elapsedMs / 3_600_000).toFixed(1)}h aggregate`,
    `uptime:   ${Math.floor(upMin / 60)}h ${upMin % 60}m`,
  )
  return formatCodeCard('📊 **@gem usage** — cumulative across restarts, all channels', lines)
}
