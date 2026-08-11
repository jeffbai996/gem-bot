/**
 * Self-restart helper for slash commands that change startup-time config.
 *
 * Some commands (model swap, etc.) can only take effect by restarting the
 * process — env vars are read once at boot. Rather than telling the user
 * "now run `systemctl --user restart gemma`," these commands write the new
 * value, ack the user, then schedule the restart in a detached subprocess
 * after a short delay so Discord receives the interaction response before
 * this process dies.
 *
 * Why detached: a child of the dying parent would die with it. We want the
 * `systemctl restart` to outlive us.
 */
import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
type WaitForIdle = () => Promise<void>
type RestartLauncher = () => void

export const RESTART_DRAIN_DEADLINE_MS = 10 * 60_000
export const GRACEFUL_SHUTDOWN_DEADLINE_MS = 15_000

export async function waitForIdleOrDeadline(
  idle: Promise<unknown>,
  deadlineMs: number = GRACEFUL_SHUTDOWN_DEADLINE_MS,
): Promise<'idle' | 'timeout'> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<'timeout'>(resolve => {
    timer = setTimeout(() => resolve('timeout'), deadlineMs)
  })
  try {
    return await Promise.race([idle.then(() => 'idle' as const), timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

interface RestartCoordinatorOptions {
  deadlineMs?: number
  onDeadline?: () => void
}

/** Admission stays open while a restart is pending, then closes atomically at idle. */
export class ShutdownGate {
  private draining = false
  private exiting = false
  private active = 0
  private readonly idleWaiters = new Set<() => void>()

  enter(): (() => void) | null {
    if (this.draining) return null
    this.active++
    let released = false
    return () => {
      if (released) return
      released = true
      this.active--
      if (this.active === 0) {
        const waiters = [...this.idleWaiters]
        this.idleWaiters.clear()
        for (const resolve of waiters) resolve()
      }
    }
  }

  waitForIdle(): Promise<void> {
    if (this.active === 0) return Promise.resolve()
    return new Promise(resolve => this.idleWaiters.add(resolve))
  }

  beginDrain(): boolean {
    if (this.draining) return false
    this.draining = true
    return true
  }

  beginExit(): boolean {
    if (this.exiting) return false
    this.draining = true
    this.exiting = true
    return true
  }

  isDraining(): boolean {
    return this.draining
  }
}

export class RestartCoordinator {
  private pending = false
  private launched = false
  private readonly deadlineMs: number
  private readonly onDeadline: () => void

  constructor(
    private readonly waitForIdle: WaitForIdle,
    private readonly launch: RestartLauncher,
    private readonly closeIntake: () => void = () => {},
    opts: RestartCoordinatorOptions = {},
  ) {
    this.deadlineMs = opts.deadlineMs ?? RESTART_DRAIN_DEADLINE_MS
    this.onDeadline = opts.onDeadline ?? (() => {})
  }

  request(): boolean {
    if (this.pending) return false
    this.pending = true
    const timer = setTimeout(() => {
      if (!this.launched) this.onDeadline()
    }, this.deadlineMs)
    timer.unref?.()

    void this.waitForIdle()
      .then(() => {
        clearTimeout(timer)
        this.fire()
      })
      .catch(error => {
        clearTimeout(timer)
        this.pending = false
        console.error('[restart] failed while waiting for idle:', error)
      })
    return true
  }

  private fire(): void {
    if (this.launched) return
    this.launched = true
    this.closeIntake()
    this.launch()
  }
}

/**
 * Atomically rewrite an `.env` file with a new value for `key`.
 * Preserves the rest of the file (comments, other vars, ordering).
 * Appends if `key` is missing.
 */
export async function rewriteEnvVar(envPath: string, key: string, value: string): Promise<void> {
  let body = ''
  try {
    body = await fs.readFile(envPath, 'utf8')
  } catch (e: any) {
    if (e?.code !== 'ENOENT') throw e
  }
  const lines = body.split('\n')
  const re = new RegExp(`^\\s*${key.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}\\s*=`)
  let replaced = false
  const out = lines.map(line => {
    if (re.test(line)) {
      replaced = true
      return `${key}=${value}`
    }
    return line
  })
  if (!replaced) {
    // Drop a single trailing blank if present, then append + newline
    while (out.length && out[out.length - 1] === '') out.pop()
    out.push(`${key}=${value}`)
    out.push('')
  }
  const tmp = envPath + '.tmp'
  await fs.writeFile(tmp, out.join('\n'), { mode: 0o644 })
  await fs.rename(tmp, envPath)
}

/**
 * Detach + schedule a `systemctl --user restart <unit>`. Returns immediately.
 *
 * The 1.5s delay gives Discord time to receive whatever interaction reply
 * the caller sent. systemd handles re-up; the new process re-reads .env.
 */
export function scheduleSelfRestart(unit: string = 'gemma', delayMs: number = 1500): void {
  const transientUnit = `${unit}-restart-${process.pid}-${Date.now()}`
  const proc = spawn(
    'systemd-run',
    [
      '--user',
      `--unit=${transientUnit}`,
      '--collect',
      `--on-active=${Math.max(0.1, delayMs / 1000).toFixed(2)}s`,
      'systemctl', '--user', 'restart', unit,
    ],
    { detached: true, stdio: 'ignore' },
  )
  proc.unref()
}
