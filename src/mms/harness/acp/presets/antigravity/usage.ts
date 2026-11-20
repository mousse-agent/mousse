import { spawn } from 'node:child_process'
import type { ProviderUsageWindow } from '../../../../../shared/providerAuth'
import { killProcessTree } from '../../../../execution/processTree'
import { compareVersions, type RuntimeUsage } from '../../../driver'

/**
 * Antigravity's plan limits, as `agy -p /usage --output-format json` prints them: the `/usage`
 * command's own reply, read without a model turn. Earlier `agy` versions take `/usage` as a prompt
 * and run a real turn, so they are refused, and a reply that reports a turn stops all reading.
 */

/** The first `agy` whose `-p /usage` runs the command instead of a turn. */
export const AGY_USAGE_MIN_VERSION = '1.1.11'
/** The longest a read may take; the usage page's own deadline is shorter. */
const READ_TIMEOUT_MS = 30_000
/** More output than any reply of the command. */
const MAX_OUTPUT_BYTES = 1024 * 1024

/** The reply ran a model turn: reading stops until another `agy` version runs. */
export class AgyUsageTurnError extends Error {
  constructor() {
    super('Antigravity ran a turn instead of reading its limits, so Mousse stopped reading them.')
  }
}

/** Why `version` cannot report its limits; undefined when it can. */
export function agyUsageRefusal(version: string | undefined): string | undefined {
  if (!version) return 'Mousse could not read the Antigravity version, so it does not ask for its limits.'
  return compareVersions(version, AGY_USAGE_MIN_VERSION) < 0
    ? `Antigravity ${version} cannot report its limits. Update agy to ${AGY_USAGE_MIN_VERSION} or later.`
    : undefined
}

const WINDOW_LABELS: Record<string, string> = { '5h': '5-hour limit', weekly: 'Weekly limit' }

const text = (value: unknown, max = 120): string | undefined =>
  typeof value === 'string' && value.trim() && value.length <= max ? value.trim() : undefined

/**
 * The usage page's windows for a reply: each quota pool's five-hour and weekly windows, with what is
 * left and when it resets. Ids are `<pool>:<window>`, so each pool keeps its own limit trend. The
 * runtime is marked `usageOnRequest`: Antigravity is read only when the usage page asks, never by the
 * background limit reads. Throws for a reply that is not the command's, and `AgyUsageTurnError` for
 * one that reports a turn.
 */
export function parseAgyUsage(stdout: string): RuntimeUsage {
  const line = stdout.trim().split('\n').reverse().find((entry) => entry.trim().startsWith('{'))
  let reply: Record<string, unknown>
  try { reply = JSON.parse(line ?? '') as Record<string, unknown> } catch { throw new Error('Antigravity did not answer with its limits.') }
  if (!reply || typeof reply !== 'object' || Array.isArray(reply)) throw new Error('Antigravity did not answer with its limits.')
  // A turn ran: the prompt was taken as a message, whatever else the reply says.
  if (typeof reply.num_turns !== 'number' || reply.num_turns !== 0) throw new AgyUsageTurnError()
  const command = reply.command as { name?: unknown; data?: { groups?: unknown } } | undefined
  if (command?.name !== 'usage' || !Array.isArray(command.data?.groups)) throw new Error('Antigravity did not answer with its limits.')
  const windows: ProviderUsageWindow[] = []
  const seen = new Set<string>()
  for (const group of command.data.groups.slice(0, 20)) {
    if (!group || typeof group !== 'object') continue
    const pool = text((group as { name?: unknown }).name, 80)
    const buckets = (group as { buckets?: unknown }).buckets
    if (!pool || !Array.isArray(buckets)) continue
    for (const bucket of buckets.slice(0, 10)) {
      if (!bucket || typeof bucket !== 'object') continue
      const { id, name, window, remaining_fraction: fraction, reset_time: reset } = bucket as Record<string, unknown>
      if (typeof fraction !== 'number' || !Number.isFinite(fraction)) continue
      const kind = text(window, 32)
      const label = (kind && WINDOW_LABELS[kind]) ?? text(name, 80)
      const key = `${pool.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}:${kind ?? text(id, 64) ?? windows.length}`
      if (!label || seen.has(key)) continue
      seen.add(key)
      const resetsAt = typeof reset === 'string' ? new Date(reset) : undefined
      windows.push({
        id: key,
        label: `${pool} · ${label}`,
        remainingPercent: Math.round(Math.max(0, Math.min(1, fraction)) * 1000) / 10,
        ...(resetsAt && !Number.isNaN(resetsAt.getTime()) ? { resetsAt: resetsAt.toISOString() } : {})
      })
    }
  }
  if (!windows.length) return { status: 'unavailable', windows: [], message: 'Antigravity reported no limits for this account.' }
  return { status: 'available', windows }
}

/** Runs `binary args` without a shell and returns its stdout; ends its process tree on abort or deadline. */
export type AgyRunner = (binary: string, args: string[], options: { env: NodeJS.ProcessEnv; cwd: string; signal: AbortSignal }) => Promise<string>

export const runAgy: AgyRunner = (binary, args, { env, cwd, signal }) => new Promise((resolve, reject) => {
  signal.throwIfAborted()
  // Direct arguments: a shell (Git Bash) would rewrite `/usage` into a path.
  const child = spawn(binary, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' })
  let stdout = ''
  let settled = false
  const finish = (error?: Error) => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
    if (error) {
      if (child.pid && child.exitCode === null) killProcessTree(child.pid)
      reject(error)
    } else resolve(stdout)
  }
  const onAbort = () => finish(signal.reason instanceof Error ? signal.reason : new Error('The usage read was cancelled.'))
  const timer = setTimeout(() => finish(new Error('Antigravity did not report its limits in time.')), READ_TIMEOUT_MS)
  signal.addEventListener('abort', onAbort, { once: true })
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk
    if (stdout.length > MAX_OUTPUT_BYTES) finish(new Error('Antigravity answered with too much output.'))
  })
  child.stderr.resume()
  child.once('error', (error) => finish(error))
  child.once('close', (code) => {
    if (code === 0) finish()
    else finish(new Error(`Antigravity exited with code ${code} while reading its limits.`))
  })
})
