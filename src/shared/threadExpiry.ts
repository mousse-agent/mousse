import type { Thread } from './types'

/**
 * Thread expiry (issue #672): a thread can be given a time after which it, its subagents, its worktree,
 * checkpoints and attachments are deleted for good. The time is absolute (`Thread.expiresAt`), so a
 * computer that was asleep or closed deletes it on its next start.
 */

/** The choices the composer, the thread's menu and Settings offer. */
export type ExpiryPreset = '1h' | '24h' | '7d' | '30d'

export const EXPIRY_PRESETS: readonly { id: ExpiryPreset; label: string; ms: number }[] = [
  { id: '1h', label: '1 hour', ms: 60 * 60 * 1000 },
  { id: '24h', label: '24 hours', ms: 24 * 60 * 60 * 1000 },
  { id: '7d', label: '7 days', ms: 7 * 24 * 60 * 60 * 1000 },
  { id: '30d', label: '30 days', ms: 30 * 24 * 60 * 60 * 1000 }
]

/** The shortest and longest expiry a thread may be given from now. */
export const MIN_EXPIRY_MS = 60 * 1000
export const MAX_EXPIRY_MS = 365 * 24 * 60 * 60 * 1000

export function isExpiryPreset(value: unknown): value is ExpiryPreset {
  return EXPIRY_PRESETS.some((preset) => preset.id === value)
}

export function expiryPresetMs(preset: ExpiryPreset): number {
  return EXPIRY_PRESETS.find((entry) => entry.id === preset)!.ms
}

/** The time `ms` from `now`, as `Thread.expiresAt` holds it. */
export function expiresAtAfter(ms: number, now = Date.now()): string {
  return new Date(now + ms).toISOString()
}

/**
 * Why `expiresAt` cannot be given to a thread now, or undefined when it can: a valid time at least a
 * minute and at most a year away.
 */
export function expiryRefusal(expiresAt: string, now = Date.now()): string | undefined {
  const at = Date.parse(expiresAt)
  if (!Number.isFinite(at) || new Date(at).toISOString() !== expiresAt) return 'expiresAt must be an ISO time'
  if (at - now < MIN_EXPIRY_MS) return 'An expiry must be at least a minute away'
  if (at - now > MAX_EXPIRY_MS) return 'An expiry can be at most a year away'
  return undefined
}

/** The expiry that applies to `thread`: its own, or for a subagent its root thread's. */
export function threadExpiresAt(
  thread: Pick<Thread, 'expiresAt' | 'lineage'>,
  inventory?: readonly Pick<Thread, 'id' | 'expiresAt'>[]
): string | undefined {
  const rootId = thread.lineage?.rootThreadId
  if (rootId && inventory) {
    const root = inventory.find((candidate) => candidate.id === rootId)
    if (root?.expiresAt) return root.expiresAt
  }
  return thread.expiresAt
}

/** True once the expiry that applies to `thread` has passed. */
export function isThreadExpired(
  thread: Pick<Thread, 'expiresAt' | 'lineage'>,
  inventory?: readonly Pick<Thread, 'id' | 'expiresAt'>[],
  now = Date.now()
): boolean {
  const at = threadExpiresAt(thread, inventory)
  return at !== undefined && Date.parse(at) <= now
}

/** "in 3 hours", "in 2 days", "in 5 minutes", "now": how long until `expiresAt`. */
export function expiresInLabel(expiresAt: string, now = Date.now()): string {
  const left = Date.parse(expiresAt) - now
  if (!Number.isFinite(left) || left <= 0) return 'now'
  const minutes = Math.ceil(left / 60_000)
  if (minutes < 60) return `in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`
  const hours = Math.round(left / 3_600_000)
  if (hours < 48) return `in ${hours} ${hours === 1 ? 'hour' : 'hours'}`
  const days = Math.round(left / 86_400_000)
  return `in ${days} days`
}

/** "24h", "7d", "90m": a compact length for a toolbar button. */
export function expiryShortLabel(ms: number): string {
  if (ms % 86_400_000 === 0 && ms >= 2 * 86_400_000) return `${ms / 86_400_000}d`
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`
  return `${Math.round(ms / 60_000)}m`
}

/** "24 hours", "7 days", "1 hour": a length in words. */
export function expiryDurationLabel(ms: number): string {
  const preset = EXPIRY_PRESETS.find((entry) => entry.ms === ms)
  if (preset) return preset.label
  if (ms % 86_400_000 === 0) return `${ms / 86_400_000} days`
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000} hours`
  return `${Math.round(ms / 60_000)} minutes`
}
