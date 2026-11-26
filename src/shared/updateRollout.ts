/**
 * Update everywhere (#476, step 3): one click updates this computer and the user's other computers to one version.
 * The background service keeps one rollout per profile (`src/mms/updates/rollout.ts`); windows read it and show its
 * rows in the update list until dismissed.
 */

/** How a computer of the rollout gets the new version. */
export type RolloutVia =
  /** This computer: its own app downloads and restarts, last. */
  | 'self'
  /** Another computer whose app takes update requests (`update.*`). */
  | 'request'
  /** A machine this computer installed over SSH: this computer installs the version there and checks it. */
  | 'ssh'
  /** Updated on that computer by hand. */
  | 'manual'

export type RolloutPhase =
  | 'downloading'
  | 'ready'
  | 'installing'
  | 'updated'
  | 'failed'
  /** It did not answer after its install; corrected when it later reports the new version. */
  | 'unverified'
  /** Offline when the rollout began: never updated later without a new click. */
  | 'offline'
  | 'manual'

/** The row of this computer. */
export const SELF_NODE = 'self'

export interface RolloutRow {
  /** The computer's node id, or `SELF_NODE`. */
  node: string
  name: string
  via: RolloutVia
  /** What it ran when the rollout began. */
  from?: string
  phase: RolloutPhase
  /** Why it failed, is manual or could not be verified, in one short line. */
  error?: string
  /** 0–100 while downloading. */
  percent?: number
  /** Turns running there at its last answer. */
  runningTurns?: number
  /** Turns running there when the person confirmed: more than these are waited for. */
  consentedTurns?: number
  /** Its update request there (`update.*`, or this computer's own). */
  job?: string
  /** The SSH setup that installed it. */
  sshId?: string
  /** When its install was asked for, for the reconnect deadline. */
  installedAt?: number
}

/**
 * - `preparing`: every computer downloads; nothing installs before the person confirms.
 * - `installing`: confirmed; the ready ones install once all are ready or the prepare deadline passed.
 * - `restarting`: this computer's own install was asked for; its service stops for it.
 * - `verifying`: each computer's version is asked of that computer again.
 * - `done`: every row settled; shown until dismissed.
 */
export type RolloutStep = 'preparing' | 'installing' | 'restarting' | 'verifying' | 'done'

export interface Rollout {
  id: string
  version: string
  startedAt: number
  confirmedAt?: number
  step: RolloutStep
  rows: RolloutRow[]
}

/** `updates.rollout.get`: the rollout, or with none under way, the rows one to `target` would have. */
export interface RolloutView {
  rollout: Rollout | null
  plan?: RolloutRow[]
}

export const ROLLOUT_METHODS = {
  get: 'updates.rollout.get',
  start: 'updates.rollout.start',
  confirm: 'updates.rollout.confirm',
  cancel: 'updates.rollout.cancel',
  retry: 'updates.rollout.retry',
  dismiss: 'updates.rollout.dismiss'
} as const
export type RolloutMethod = (typeof ROLLOUT_METHODS)[keyof typeof ROLLOUT_METHODS]
export const ROLLOUT_METHOD_LIST: readonly RolloutMethod[] = Object.values(ROLLOUT_METHODS)

/** `ui.notify` kind the service sends when the rollout changed; windows read it again. */
export const ROLLOUT_NOTIFY_KIND = 'update-rollout'

/** A row that still changes on its own. */
export const isRowActive = (row: Pick<RolloutRow, 'phase'>): boolean =>
  row.phase === 'downloading' || row.phase === 'ready' || row.phase === 'installing'

/** A row with a retry: it failed, could not be verified, or was offline. */
export const canRetryRow = (row: Pick<RolloutRow, 'phase' | 'via'>): boolean =>
  row.via !== 'manual' && (row.phase === 'failed' || row.phase === 'unverified' || row.phase === 'offline')

/** The computers a rollout updates from here: this one when it needs it, and every other one it can reach. */
export function rolloutTargets(rows: readonly RolloutRow[]): RolloutRow[] {
  return rows.filter((row) => row.via !== 'manual' && row.phase !== 'offline' && row.phase !== 'manual')
}

/** At least one other computer can be updated from here, so Update everywhere is offered. */
export function offersEverywhere(rows: readonly RolloutRow[] | undefined): boolean {
  return !!rows && rolloutTargets(rows).some((row) => row.node !== SELF_NODE)
}

/** "1 computer", "3 computers". */
export const computersCount = (count: number): string => (count === 1 ? '1 computer' : `${count} computers`)

const PHASES: readonly RolloutPhase[] = ['downloading', 'ready', 'installing', 'updated', 'failed', 'unverified', 'offline', 'manual']
const VIAS: readonly RolloutVia[] = ['self', 'request', 'ssh', 'manual']
const STEPS: readonly RolloutStep[] = ['preparing', 'installing', 'restarting', 'verifying', 'done']

const text = (value: unknown, max = 200): string | undefined => (typeof value === 'string' && value.length <= max ? value : undefined)
const count = (value: unknown): number | undefined => (Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : undefined)

/** Rows as saved or sent; anything off reads as none. */
export function parseRolloutRows(value: unknown): RolloutRow[] | null {
  if (!Array.isArray(value)) return null
  const rows: RolloutRow[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object') return null
    const row = item as Record<string, unknown>
    const node = text(row.node, 128), name = text(row.name)
    if (!node || name === undefined || !VIAS.includes(row.via as RolloutVia) || !PHASES.includes(row.phase as RolloutPhase)) return null
    const optional = {
      from: text(row.from, 64),
      error: text(row.error, 500),
      percent: count(row.percent),
      runningTurns: count(row.runningTurns),
      consentedTurns: count(row.consentedTurns),
      job: text(row.job, 64),
      sshId: text(row.sshId, 128),
      installedAt: count(row.installedAt)
    }
    rows.push({
      node,
      name,
      via: row.via as RolloutVia,
      phase: row.phase as RolloutPhase,
      ...Object.fromEntries(Object.entries(optional).filter(([, inner]) => inner !== undefined))
    })
  }
  return rows
}

/** A rollout as saved or sent; anything off reads as none. */
export function parseRollout(value: unknown): Rollout | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const id = text(raw.id, 64), version = text(raw.version, 64), startedAt = count(raw.startedAt)
  const rows = parseRolloutRows(raw.rows)
  if (!id || !version || startedAt === undefined || !STEPS.includes(raw.step as RolloutStep) || !rows) return null
  const confirmedAt = count(raw.confirmedAt)
  return { id, version, startedAt, step: raw.step as RolloutStep, rows, ...(confirmedAt !== undefined ? { confirmedAt } : {}) }
}
