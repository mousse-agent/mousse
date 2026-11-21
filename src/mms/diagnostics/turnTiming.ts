/**
 * Where a turn spends its time, from the message's request to the reply's first word: monotonic marks
 * (`performance.now()`) along the path, logged once per turn as milliseconds after the request, as
 * `[turn-timing] {"threadId":…,"runId":…,"request":…,"source":…,"warm":…,"queuedMs":…,"lagMaxMs":…,"ms":{"setup":…,…,"firstText":…}}`.
 *
 * Every thread's turn is timed from its run's request (`turnTimingBeginRun`, as `executeTurn` starts) and ended with
 * it (`turnTimingEnd`). A bot's chat turn starts earlier, at the owner's message: it is begun under its bot (`begin`),
 * moved to its home thread once its dispatch knows it (`bind`), and taken over by the run that executes it. The
 * orchestrator and the provider mark steps on the thread (`mark`); `firstText` logs the turn and ends it. A turn that
 * reached its provider and ended without a word (a reply of tool calls only, a failure, a Stop) is logged as it ends,
 * with `ended: 'noText'`. A thread with no timed turn is never marked, so a mark costs one map lookup.
 *
 * `warm` says whether the provider's process was already running (`processWarm`) or was started (`processNew`), when
 * the provider tells; `queuedMs` is the time from the run's request to its setup; `lagMaxMs` is the longest the
 * service's event loop was held while the turn was timed (`eventLoopLag.ts`). Measurements only: nothing reads them back.
 *
 * Every mark is also a phase of the turn's boundary (`turnBoundary.ts`).
 */

import { watchEventLoopLag, type EventLoopLagWatch } from './eventLoopLag'
import { turnBoundaryMark } from './turnBoundary'

interface RunFacts { runId?: string; request?: string; source?: string; queuedMs?: number; lag: EventLoopLagWatch }

interface Turn { start: number; marks: [string, number][]; run?: RunFacts }

/** A turn timed for its run: `executeTurn` ends the one it began, not one that replaced it. */
export type TimedTurn = object

const turns = new Map<string, Turn>()
/** Turns that are never ended (a bot message whose dispatch never came) are dropped oldest first past this many. */
const MAX_TURNS = 32

const botKey = (botId: string) => `bot:${botId}`
/** A bot's turn bound to a thread whose previous turn is still timed: its run takes it over. */
const boundKey = (threadId: string) => `bound:${threadId}`

const defaultLog = (line: string): void => console.info(line)

function drop(key: string): Turn | undefined {
  const turn = turns.get(key)
  if (!turn) return undefined
  turns.delete(key)
  turn.run?.lag.stop()
  return turn
}

function keep(key: string, turn: Turn): void {
  if (turns.get(key) !== turn) drop(key)
  turns.delete(key)
  turns.set(key, turn)
  if (turns.size > MAX_TURNS) drop(turns.keys().next().value!)
}

/** The owner's message for `botId` was taken: the clock starts. */
export function turnTimingBegin(botId: string): void {
  keep(botKey(botId), { start: performance.now(), marks: [] })
}

/** The owner's message joined a turn already under way: it starts no turn of its own. */
export function turnTimingForget(botId: string): void {
  drop(botKey(botId))
}

/** The bot's turn was dispatched on `threadId`: its marks follow that thread. A dispatch with no message begun starts here. */
export function turnTimingBind(botId: string, threadId: string): void {
  const turn = turns.get(botKey(botId)) ?? { start: performance.now(), marks: [] }
  turns.delete(botKey(botId))
  turn.marks.push(['dispatch', performance.now() - turn.start])
  keep(turns.get(threadId)?.run ? boundKey(threadId) : threadId, turn)
}

/**
 * The run `runId` starts its turn on `threadId` (`executeTurn`): the turn is timed from the run's request (`requestedAt`,
 * an ISO time), or from the owner's message for a bot's turn bound here, and its `setup` step is reached now.
 */
export function turnTimingBeginRun(
  threadId: string,
  run: { runId?: string; requestedAt?: string; clientRequestId?: string | null; source?: string }
): TimedTurn {
  const now = performance.now()
  const requested = run.requestedAt ? Date.parse(run.requestedAt) : NaN
  const queuedMs = Number.isFinite(requested) ? Math.max(0, Date.now() - requested) : undefined
  const existing = turns.get(threadId)
  const turn = drop(boundKey(threadId)) ?? (existing && !existing.run ? existing : undefined) ?? { start: now - (queuedMs ?? 0), marks: [] }
  turn.run = {
    ...(run.runId ? { runId: run.runId } : {}),
    ...(run.clientRequestId ? { request: run.clientRequestId } : {}),
    ...(run.source ? { source: run.source } : {}),
    ...(queuedMs !== undefined ? { queuedMs } : {}),
    lag: watchEventLoopLag()
  }
  keep(threadId, turn)
  markOn(turn, 'setup')
  return turn
}

/** A step of the turn on `threadId` was reached. The first of each label counts. */
export function turnTimingMark(threadId: string, label: string): void {
  markOn(turns.get(threadId), label)
  turnBoundaryMark(threadId, label)
}

/** A step of `botId`'s turn before its dispatch knows its thread (its model, its context, the internet check). */
export function turnTimingBotMark(botId: string, label: string): void {
  markOn(turns.get(botKey(botId)), label)
}

function markOn(turn: Turn | undefined, label: string): void {
  if (!turn || turn.marks.some(([seen]) => seen === label)) return
  turn.marks.push([label, performance.now() - turn.start])
}

/** The reply's first word on `threadId`: the turn is logged and ended. */
export function turnTimingFirstText(threadId: string, log: (line: string) => void = defaultLog): void {
  const turn = turns.get(threadId)
  if (!turn) return
  turnTimingMark(threadId, 'firstText')
  drop(threadId)
  write(threadId, turn, log)
}

/**
 * The turn on `threadId` is over. `turn`, when given, is the one its run began: a turn that replaced it is left alone.
 * One that reached its provider without a first word is logged as `noText`; one that never reached it is not logged
 * (its `[turn-boundary]` line says where it stopped).
 */
export function turnTimingEnd(threadId: string, turn?: TimedTurn, log: (line: string) => void = defaultLog): void {
  const current = turns.get(threadId)
  if (turn && current !== turn) {
    ;(turn as Turn).run?.lag.stop()
    return
  }
  if (!current) return
  drop(threadId)
  if (current.marks.some(([label]) => label === 'harness' || label === 'prompt')) write(threadId, current, log, 'noText')
}

function write(threadId: string, turn: Turn, log: (line: string) => void, ended?: 'noText'): void {
  const labels = new Set(turn.marks.map(([label]) => label))
  const run = turn.run
  const line = {
    threadId,
    ...(run?.runId ? { runId: run.runId } : {}),
    ...(run?.request ? { request: run.request } : {}),
    ...(run?.source ? { source: run.source } : {}),
    ...(labels.has('processWarm') ? { warm: true } : labels.has('processNew') ? { warm: false } : {}),
    ...(run?.queuedMs !== undefined ? { queuedMs: Math.round(run.queuedMs) } : {}),
    // Stopped already (`drop`): the watch returns what it saw.
    ...(run ? { lagMaxMs: run.lag.stop() } : {}),
    ...(ended ? { ended } : {}),
    ms: Object.fromEntries(turn.marks.map(([label, at]) => [label, Math.round(at)]))
  }
  try {
    log(`[turn-timing] ${JSON.stringify(line)}`)
  } catch {
    // A log that cannot be written never fails a turn.
  }
}
