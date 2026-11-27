import { create } from 'zustand'
import {
  canRetryRow,
  computersCount,
  isRowActive,
  parseRollout,
  parseRolloutRows,
  ROLLOUT_METHODS,
  rolloutTargets,
  SELF_NODE,
  type Rollout,
  type RolloutRow
} from '../../shared/updateRollout'
import { useAppStore } from '../stores/appStore'
import { profileBound, readWhenIdleAfterBinding } from './readAfterBinding'
import { ipcErrorLine } from './errorText'

/**
 * Update everywhere in this window: the profile's rollout as its service keeps it (`src/mms/updates/rollout.ts`), and
 * with none under way the computers a rollout to the offered version would update. Read when the window is idle after
 * opening (a rollout this computer's restart interrupted goes on then), when the downloads list opens, and whenever the
 * service says it changed.
 */
export interface RolloutState {
  rollout: Rollout | null
  /** The rows a rollout to `planFor` would have. */
  plan?: RolloutRow[]
  planFor?: string
  /** The last start, confirm, retry or cancel that failed, in one line. */
  error?: string
}

export const useRolloutStore = create<RolloutState>(() => ({ rollout: null }))

// Async, so a window without the request bridge fails the read like any other error and the read in flight clears.
const request = async <T>(method: (typeof ROLLOUT_METHODS)[keyof typeof ROLLOUT_METHODS], params: unknown): Promise<T> =>
  window.mousse.platformRequest.request<T>(method, params)

/** The answer of a read or an action; a plan comes only with a read for a version, and is kept until the next one. */
function receive(answer: { rollout?: unknown; plan?: unknown }, target?: string): void {
  const plan = target ? parseRolloutRows(answer.plan) : null
  useRolloutStore.setState({ rollout: parseRollout(answer.rollout), ...(plan ? { plan, planFor: target } : {}) })
}

let reading: Promise<void> | undefined
let wanted: string | undefined | null = null

/** Reads the rollout again, and the plan for `target` when given; calls during a read share one more after it. */
export function readRollout(target?: string): Promise<void> {
  if (reading) {
    wanted = target ?? wanted ?? undefined
    return reading
  }
  const profile = useAppStore.getState().profileId
  reading = (async () => {
    try {
      const answer = await request<{ rollout?: unknown; plan?: unknown }>(ROLLOUT_METHODS.get, target ? { version: target } : {})
      if (useAppStore.getState().profileId === profile) receive(answer, target)
    } catch {
      // A service without Update everywhere, or networking off: nothing to show.
    } finally {
      reading = undefined
      if (wanted !== null) {
        const next = wanted
        wanted = null
        void readRollout(next)
      }
    }
  })()
  return reading
}

async function act(method: (typeof ROLLOUT_METHODS)[keyof typeof ROLLOUT_METHODS], params: unknown): Promise<boolean> {
  try {
    const answer = await request<{ rollout?: unknown; plan?: unknown }>(method, params)
    useRolloutStore.setState({ error: undefined })
    receive(answer)
    return true
  } catch (cause) {
    useRolloutStore.setState({ error: ipcErrorLine(cause) || "Couldn't update your computers." })
    return false
  }
}

export const rolloutActions = {
  /** Every computer starts downloading `version`; nothing installs before `confirm`. */
  start: (version: string) => act(ROLLOUT_METHODS.start, { version }),
  /** Installs everywhere, with the turns shown running on each computer agreed to. */
  confirm: (rollout: Rollout) => act(ROLLOUT_METHODS.confirm, { turns: consentedTurns(rollout) }),
  cancel: () => act(ROLLOUT_METHODS.cancel, {}),
  retry: (node: string) => act(ROLLOUT_METHODS.retry, { node }),
  dismiss: () => act(ROLLOUT_METHODS.dismiss, {})
}

/** The turns the confirmation showed for each computer. */
export function consentedTurns(rollout: Pick<Rollout, 'rows'>): Record<string, number> {
  return Object.fromEntries(rollout.rows.filter((row) => row.via !== 'manual').map((row) => [row.node, row.runningTurns ?? 0]))
}

/** The row's name: this computer is called so. */
export const rowName = (row: Pick<RolloutRow, 'node' | 'name'>): string => (row.node === SELF_NODE ? 'This computer' : row.name)

/** A computer's state in a word or two; the reason goes in its tooltip. */
export function rowStatus(row: RolloutRow): string {
  switch (row.phase) {
    case 'downloading':
      return row.percent !== undefined ? `Downloading ${row.percent}%` : 'Downloading'
    case 'ready':
      return 'Ready'
    case 'installing':
      return row.node === SELF_NODE ? 'Restarting' : 'Installing'
    case 'updated':
      return 'Updated'
    case 'failed':
      return row.error === 'Cancelled' ? 'Cancelled' : 'Failed'
    case 'unverified':
      return "Couldn't verify"
    case 'offline':
      return 'Offline'
    case 'manual':
      return 'Update by hand'
  }
}

export type RowTone = 'ok' | 'bad' | 'warn' | 'muted' | undefined

export function rowTone(row: RolloutRow): RowTone {
  if (row.phase === 'updated') return 'ok'
  if (row.phase === 'failed') return 'bad'
  if (row.phase === 'unverified') return 'warn'
  if (row.phase === 'offline' || row.phase === 'manual') return 'muted'
  return undefined
}

export { canRetryRow, isRowActive }

/** The rollout as one line for the indicator. */
export function rolloutSummary(rollout: Rollout): { status: 'downloading' | 'installing' | 'failed' | 'done'; label: string } {
  const targets = rolloutTargets(rollout.rows)
  if (rollout.rows.some(isRowActive)) {
    const installing = rollout.step !== 'preparing' || rollout.rows.some((row) => row.phase === 'installing')
    return { status: installing ? 'installing' : 'downloading', label: `Updating ${computersCount(targets.length)}` }
  }
  const bad = rollout.rows.filter((row) => row.phase === 'failed' || row.phase === 'unverified').length
  if (bad) return { status: 'failed', label: bad === 1 ? "1 computer didn't update" : `${bad} computers didn't update` }
  const updated = rollout.rows.filter((row) => row.phase === 'updated').length
  return { status: 'done', label: `${computersCount(updated)} updated` }
}

let following = false

/** How long after the window opens the rollout is read when the window never goes idle first. */
export const ROLLOUT_FIRST_READ_MS = 10_000

/**
 * Follows the rollout in this window: read once when idle after the profile is bound (never while it opens), then on
 * each change the service announces and on a profile switch. Safe to call more than once.
 */
export function followRollout(): void {
  if (following || typeof window === 'undefined' || !window.mousse?.platformRequest) return
  following = true
  const read = () => void readRollout()
  // Nothing is read before the profile is bound; the first read after the binding catches up on changes before it.
  readWhenIdleAfterBinding(read, ROLLOUT_FIRST_READ_MS)
  window.mousse.updates?.onRolloutChanged?.((change) => {
    if (!profileBound()) return
    if (!change.profileId || change.profileId === useAppStore.getState().profileId) void readRollout(useRolloutStore.getState().planFor)
  })
  useAppStore.subscribe((state, previous) => {
    if (state.profileId === previous.profileId || !previous.profileReady) return
    useRolloutStore.setState({ rollout: null, plan: undefined, planFor: undefined, error: undefined })
    read()
  })
}

/** Test hook. */
export function resetRolloutStore(): void {
  useRolloutStore.setState({ rollout: null, plan: undefined, planFor: undefined, error: undefined }, true)
}
