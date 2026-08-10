import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { formatCodeCard } from './discord-card.ts'
const DEFAULT_AGY_BIN = path.join(os.homedir(), '.local', 'bin', 'agy')
const QUOTA_URL = 'https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary'

interface StoredAgyToken {
  token?: {
    access_token?: string
    expiry?: string
  }
}

interface RawQuotaBucket {
  bucketId?: unknown
  displayName?: unknown
  window?: unknown
  resetTime?: unknown
  remainingFraction?: unknown
}

interface RawQuotaGroup {
  displayName?: unknown
  description?: unknown
  buckets?: unknown
}

export interface AgyQuotaBucket {
  id: string
  displayName: string
  window: string
  resetTime: string | null
  remainingFraction: number
}

export interface AgyQuotaGroup {
  displayName: string
  description: string
  buckets: AgyQuotaBucket[]
}

export interface AgyLimitsDeps {
  agyBin?: string
  tokenPath?: string
  fetchImpl?: typeof fetch
  refreshAuth?: () => Promise<void>
}

function numberInUnitInterval(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return Math.min(1, Math.max(0, value))
}

export function parseAgyQuotaSummary(payload: unknown): AgyQuotaGroup[] {
  if (!payload || typeof payload !== 'object') {
    throw new Error('agy returned an invalid quota response')
  }
  const object = payload as Record<string, unknown>
  const error = object.error
  if (error && typeof error === 'object') {
    const message = (error as Record<string, unknown>).message
    throw new Error(typeof message === 'string' ? message : 'agy quota request failed')
  }
  if (!Array.isArray(object.groups)) {
    throw new Error('agy returned no quota groups')
  }

  const groups = object.groups.flatMap((value): AgyQuotaGroup[] => {
    if (!value || typeof value !== 'object') return []
    const group = value as RawQuotaGroup
    if (!Array.isArray(group.buckets)) return []
    const buckets = group.buckets.flatMap((raw): AgyQuotaBucket[] => {
      if (!raw || typeof raw !== 'object') return []
      const bucket = raw as RawQuotaBucket
      const remainingFraction = numberInUnitInterval(bucket.remainingFraction)
      if (remainingFraction == null) return []
      return [{
        id: typeof bucket.bucketId === 'string' ? bucket.bucketId : 'unknown',
        displayName: typeof bucket.displayName === 'string' ? bucket.displayName : 'Limit',
        window: typeof bucket.window === 'string' ? bucket.window : '',
        resetTime: typeof bucket.resetTime === 'string' ? bucket.resetTime : null,
        remainingFraction,
      }]
    })
    if (buckets.length === 0) return []
    return [{
      displayName: typeof group.displayName === 'string' ? group.displayName : 'Models',
      description: typeof group.description === 'string' ? group.description : '',
      buckets,
    }]
  })

  if (groups.length === 0) throw new Error('agy returned no quota groups')
  return groups
}

function quotaBar(remainingFraction: number): string {
  const cells = 10
  const usedCells = Math.round((1 - remainingFraction) * cells)
  return `${'█'.repeat(usedCells)}${'░'.repeat(cells - usedCells)}`
}

function quotaLabel(bucket: AgyQuotaBucket): string {
  const window = bucket.window.trim().toLowerCase()
  if (window === 'weekly') return 'weekly:'
  if (/^five[- ]?hour$/.test(window) || window === '5h') return '5-hour:'
  return `${bucket.displayName.replace(/\s+limit$/i, '').toLowerCase()}:`
}

function resetCountdown(resetTime: string | null, nowMs: number): string {
  if (!resetTime) return 'reset unknown'
  const resetMs = Date.parse(resetTime)
  if (!Number.isFinite(resetMs)) return 'reset unknown'
  const seconds = Math.max(0, Math.ceil((resetMs - nowMs) / 1000))
  if (seconds === 0) return 'resetting now'
  const days = Math.floor(seconds / 86_400)
  const hours = Math.floor((seconds % 86_400) / 3_600)
  const minutes = Math.floor((seconds % 3_600) / 60)
  const parts = [
    days > 0 ? `${days}d` : '',
    hours > 0 ? `${hours}h` : '',
    days === 0 && minutes > 0 ? `${minutes}m` : '',
  ].filter(Boolean)
  return `resets in ${parts.join(' ')}`
}

export function formatAgyLimits(groups: AgyQuotaGroup[], nowMs = Date.now()): string {
  const lines: string[] = []
  groups.forEach((group, groupIndex) => {
    if (groupIndex > 0) lines.push('')
    lines.push(group.displayName)
    if (group.description) {
      lines.push(group.description.replace(/^Models within this group:\s*/i, ''))
    }
    const quotaLines: string[] = []
    for (const bucket of group.buckets) {
      const left = Math.round(bucket.remainingFraction * 100)
      const used = 100 - left
      quotaLines.push(
        `${quotaLabel(bucket).padEnd(7)} ${quotaBar(bucket.remainingFraction)} ${String(used).padStart(3)}%  · ${left}% left · ${resetCountdown(bucket.resetTime, nowMs)}`,
      )
    }
    lines.push(...quotaLines)
  })
  return formatCodeCard('⏱️ **agy limits**', lines)
}

function agyChildEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  delete env.DISCORD_BOT_TOKEN
  delete env.GEMINI_API_KEY
  return env
}

async function refreshAgyAuth(agyBin: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    // agy can launch a background updater that inherits piped stdout/stderr,
    // preventing execFile from ever observing EOF. Dev-null stdio lets the
    // short-lived `models` process exit without its helper pinning our promise.
    const child = spawn(agyBin, ['models'], {
      env: agyChildEnv(),
      stdio: 'ignore',
    })
    const timeout = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error('agy auth refresh timed out'))
    }, 20_000)
    child.once('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.once('exit', (code, signal) => {
      clearTimeout(timeout)
      if (code === 0) resolve()
      else reject(new Error(`agy auth refresh exited ${signal ?? code ?? 'unknown'}`))
    })
  })
}

export async function fetchAgyLimits(deps: AgyLimitsDeps = {}): Promise<AgyQuotaGroup[]> {
  const agyBin = deps.agyBin ?? process.env.GEMMA_AGY_BIN ?? DEFAULT_AGY_BIN
  const tokenPath = deps.tokenPath
    ?? process.env.GEMMA_AGY_OAUTH_TOKEN
    ?? path.join(os.homedir(), '.gemini', 'antigravity-cli', 'antigravity-oauth-token')
  const fetchImpl = deps.fetchImpl ?? fetch

  // Let agy own OAuth refresh. This command consumes no model quota and avoids
  // copying its embedded OAuth client credential into gem-bot.
  await (deps.refreshAuth ?? (() => refreshAgyAuth(agyBin)))()

  const stored = JSON.parse(await readFile(tokenPath, 'utf8')) as StoredAgyToken
  const accessToken = stored.token?.access_token
  const expiryMs = stored.token?.expiry ? Date.parse(stored.token.expiry) : Number.NaN
  if (!accessToken || !Number.isFinite(expiryMs) || expiryMs <= Date.now()) {
    throw new Error('agy OAuth token is missing or expired')
  }

  const response = await fetchImpl(QUOTA_URL, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
      // The backend rejects otherwise-valid consumer OAuth calls without the
      // Antigravity client marker.
      'user-agent': 'antigravity',
    },
    body: '{}',
    signal: AbortSignal.timeout(15_000),
  })
  const payload = await response.json()
  if (!response.ok) {
    const message = payload && typeof payload === 'object'
      ? (payload as any).error?.message
      : null
    throw new Error(message || `agy quota backend returned HTTP ${response.status}`)
  }
  return parseAgyQuotaSummary(payload)
}
