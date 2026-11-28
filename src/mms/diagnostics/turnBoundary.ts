import { AsyncLocalStorage } from 'node:async_hooks'
import type { ChildProcess } from 'node:child_process'
import { logMeasurement } from '../log/diag'

/**
 * Where every thread's turn boundaries spend their time: the turn's start, from `executeTurn` to its provider call, and
 * its end, from the provider's reply to the turn's settle. Each is logged once, as one line in the daemon log
 * (`logs/daemon.log` in Mousse's home) and on the service's standard output:
 *
 * `[turn-boundary] {"threadId":…,"runId":…,"edge":"start","ms":…,"waitedMs":…,"phases":{"folders":{"ms":…},"lease":{"ms":…,"git":4,…},…}}`
 *
 * A phase runs from one mark to the next (`turnBoundaryMark`, and every `turnTimingMark`), named by the mark that ends
 * it. Each lists its milliseconds and, when it has any, its Git commands: how many were started (`git`), their summed
 * lifetimes (`gitMs`), the time the caller spent synchronously starting or dispatching them (`spawnMs`), and the commands run synchronously and
 * the time they held it (`sync`, `syncMs`), and the time spent waiting for a repository's lease (`leaseMs`). A command
 * belongs to the phase it started in. `waitedMs` is the time between the run's request and the start of its setup.
 *
 * Counting is an `AsyncLocalStorage` lookup and a few additions per Git command, at its spawn site
 * (`timeGitChild`, `timeGitSync`), whatever executable it names; outside a boundary it is the lookup alone. Nothing
 * waits for it and nothing reads it back.
 */

interface Counts {
  ms: number
  git?: number
  gitMs?: number
  spawnMs?: number
  sync?: number
  syncMs?: number
  leaseMs?: number
}

interface Boundary {
  edge: 'start' | 'end'
  start: number
  last: number
  current: Counts
  phases: [string, Counts][]
}

interface TurnScope {
  threadId: string
  runId?: string
  /** The run's request time (epoch ms), for `waitedMs`. */
  requestedAt?: number
  boundary?: Boundary
  log: (line: string) => void
}

const scope = new AsyncLocalStorage<TurnScope>()

/** Phases past this many are folded into the last one: a boundary's line stays bounded whatever marks it meets. */
const MAX_PHASES = 24

const defaultLog = (line: string): void => logMeasurement(line)

/**
 * Runs one turn under its boundary scope. Its start boundary begins now. Whichever boundary is still open when `work`
 * ends is logged then, with an `ended` of `beforeProvider` (a turn that never reached its provider) or `settled`.
 */
export async function inTurnBoundary<T>(
  turn: { threadId: string; runId?: string; requestedAt?: string },
  work: () => Promise<T>,
  log: (line: string) => void = defaultLog
): Promise<T> {
  const requestedAt = turn.requestedAt ? Date.parse(turn.requestedAt) : NaN
  const state: TurnScope = { threadId: turn.threadId, ...(turn.runId ? { runId: turn.runId } : {}), ...(Number.isFinite(requestedAt) ? { requestedAt } : {}), log }
  open(state, 'start')
  try {
    return await scope.run(state, work)
  } finally {
    if (state.boundary) close(state, state.boundary.edge === 'start' ? 'beforeProvider' : 'settled')
  }
}

/** A step of the current turn's open boundary on `threadId` was reached: the phase up to here is named `label`. */
export function turnBoundaryMark(threadId: string, label: string): void {
  const state = scope.getStore()
  if (!state?.boundary || state.threadId !== threadId) return
  mark(state.boundary, label)
}

/** A step inside a service the turn calls (a snapshot, a checkpoint), which does not know the thread: marks whichever
 * boundary it runs in, if any. */
export function turnBoundaryStep(label: string): void {
  const boundary = scope.getStore()?.boundary
  if (boundary) mark(boundary, label)
}

/** The turn's provider is called: its start boundary is logged, with `label` as its last phase. */
export function turnBoundaryStarted(threadId: string, label: string): void {
  const state = scope.getStore()
  if (state?.boundary?.edge !== 'start' || state.threadId !== threadId) return
  mark(state.boundary, label)
  close(state)
}

/** The provider's turn is over (answered, failed or stopped): the end boundary begins. */
export function turnBoundaryReplyDone(threadId: string): void {
  const state = scope.getStore()
  if (!state || state.threadId !== threadId) return
  if (state.boundary) close(state, 'beforeProvider')
  open(state, 'end')
}

/** A Git process `start` spawns, counted in the open boundary's current phase with its spawn time and lifetime. */
export function timeGitChild<C extends ChildProcess>(start: () => C): C {
  const counts = scope.getStore()?.boundary?.current
  if (!counts) return start()
  const begun = performance.now()
  const child = start()
  const dispatched = performance.now()
  let started: number | undefined
  child.once('spawn', () => {
    started = performance.now()
    counts.git = (counts.git ?? 0) + 1
    counts.spawnMs = (counts.spawnMs ?? 0) + dispatched - begun
  })
  // Measure between the start and exit notifications. Queue time and pipes kept open after exit are excluded.
  const end = (): void => {
    if (started === undefined) return
    counts.gitMs = (counts.gitMs ?? 0) + performance.now() - started
    started = undefined
  }
  child.once('exit', end)
  child.once('close', end)
  return child
}

/** A Git command `run` runs synchronously (`spawnSync`, `execFileSync`): its whole lifetime held the event loop. */
export function timeGitSync<T>(run: () => T): T {
  const counts = scope.getStore()?.boundary?.current
  if (!counts) return run()
  const begun = performance.now()
  try {
    return run()
  } finally {
    const ms = performance.now() - begun
    counts.git = (counts.git ?? 0) + 1
    counts.sync = (counts.sync ?? 0) + 1
    counts.syncMs = (counts.syncMs ?? 0) + ms
    counts.gitMs = (counts.gitMs ?? 0) + ms
  }
}

/** A Git command `run` starts and answers with a promise (a promisified `execFile`): its call is its spawn time. */
export function timeGitRun<T>(run: () => Promise<T>): Promise<T> {
  const counts = scope.getStore()?.boundary?.current
  if (!counts) return run()
  const begun = performance.now()
  const running = run()
  counts.git = (counts.git ?? 0) + 1
  counts.spawnMs = (counts.spawnMs ?? 0) + performance.now() - begun
  const end = (): void => { counts.gitMs = (counts.gitMs ?? 0) + performance.now() - begun }
  running.then(end, end)
  return running
}

/** A wait for a repository's lease, counted in the open boundary's current phase once it ends, granted or not. */
export function timeRepositoryLeaseWait<T>(waiting: Promise<T>): Promise<T> {
  const counts = scope.getStore()?.boundary?.current
  if (!counts) return waiting
  const begun = performance.now()
  const add = (): void => { counts.leaseMs = (counts.leaseMs ?? 0) + performance.now() - begun }
  waiting.then(add, add)
  return waiting
}

function open(state: TurnScope, edge: Boundary['edge']): void {
  const now = performance.now()
  state.boundary = { edge, start: now, last: now, current: { ms: 0 }, phases: [] }
}

function mark(boundary: Boundary, label: string): void {
  const now = performance.now()
  const counts = boundary.current
  counts.ms = now - boundary.last
  boundary.last = now
  boundary.current = { ms: 0 }
  const previous = boundary.phases.length >= MAX_PHASES ? boundary.phases.at(-1) : undefined
  if (!previous) {
    boundary.phases.push([label, counts])
    return
  }
  // Folded into the last phase, renamed after the latest mark.
  const folded = previous[1]
  for (const key of Object.keys(counts) as (keyof Counts)[]) folded[key] = (folded[key] ?? 0) + (counts[key] ?? 0)
  previous[0] = label
}

function close(state: TurnScope, ended?: 'beforeProvider' | 'settled'): void {
  const boundary = state.boundary
  if (!boundary) return
  state.boundary = undefined
  if (ended) mark(boundary, ended)
  const total = { ms: 0, git: 0, gitMs: 0, leaseMs: 0 }
  const phases: Record<string, Record<string, number>> = {}
  for (const [label, counts] of boundary.phases) {
    const shown: Record<string, number> = {}
    for (const [key, value] of Object.entries(counts)) if (Math.round(value) || key === 'ms') shown[key] = Math.round(value)
    // A label met twice (a retried step) keeps both phases apart.
    let name = label
    for (let n = 2; name in phases; n += 1) name = `${label}#${n}`
    phases[name] = shown
    total.ms += counts.ms
    total.git += counts.git ?? 0
    total.gitMs += counts.gitMs ?? 0
    total.leaseMs += counts.leaseMs ?? 0
  }
  const line = {
    threadId: state.threadId,
    ...(state.runId ? { runId: state.runId } : {}),
    edge: boundary.edge,
    ...(ended === 'beforeProvider' && boundary.edge === 'start' ? { ended: 'beforeProvider' } : {}),
    ms: Math.round(total.ms),
    git: total.git,
    gitMs: Math.round(total.gitMs),
    ...(total.leaseMs ? { leaseMs: Math.round(total.leaseMs) } : {}),
    ...(boundary.edge === 'start' && state.requestedAt !== undefined ? { waitedMs: Math.max(0, Math.round(Date.now() - total.ms - state.requestedAt)) } : {}),
    phases
  }
  try {
    state.log(`[turn-boundary] ${JSON.stringify(line)}`)
  } catch {
    // A log that cannot be written never fails a turn.
  }
}
