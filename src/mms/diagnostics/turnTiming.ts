/**
 * Where a bot's chat reply spends its time, from the owner's message to the reply's first word: monotonic marks
 * (`performance.now()`) along the path, logged once per turn as milliseconds after the message, in the daemon log and
 * on standard output, as `[turn-timing] {"threadId":…,"ms":{"dispatch":…,…,"firstText":…}}`.
 *
 * A turn is begun under its bot (`begin`), moved to its home thread once its dispatch knows it (`bind`), and marked by
 * the orchestrator and the runtime on that thread (`mark`); `firstText` logs it and ends it. A thread with no begun
 * turn is never marked, so ordinary threads cost one map lookup. Measurements only: nothing reads them back.
 *
 * Every mark is also a phase of the turn's boundary (`turnBoundary.ts`), which every thread logs.
 */

import { logMeasurement } from '../log/diag'
import { turnBoundaryMark } from './turnBoundary'

interface Turn { start: number; marks: [string, number][] }

const turns = new Map<string, Turn>()
/** Turns that never reach a first word (refused, failed, stopped) are dropped oldest first past this many. */
const MAX_TURNS = 32

const botKey = (botId: string) => `bot:${botId}`

function keep(key: string, turn: Turn): void {
  turns.delete(key)
  turns.set(key, turn)
  if (turns.size > MAX_TURNS) turns.delete(turns.keys().next().value!)
}

/** The owner's message for `botId` was taken: the clock starts. */
export function turnTimingBegin(botId: string): void {
  keep(botKey(botId), { start: performance.now(), marks: [] })
}

/** The owner's message joined a turn already under way: it starts no turn of its own. */
export function turnTimingForget(botId: string): void {
  turns.delete(botKey(botId))
}

/** The bot's turn was dispatched on `threadId`: its marks follow that thread. A dispatch with no message begun starts here. */
export function turnTimingBind(botId: string, threadId: string): void {
  const turn = turns.get(botKey(botId)) ?? { start: performance.now(), marks: [] }
  turns.delete(botKey(botId))
  turn.marks.push(['dispatch', performance.now() - turn.start])
  keep(threadId, turn)
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
export function turnTimingFirstText(threadId: string, log: (line: string) => void = logMeasurement): void {
  const turn = turns.get(threadId)
  if (!turn) return
  turnTimingMark(threadId, 'firstText')
  turns.delete(threadId)
  log(`[turn-timing] ${JSON.stringify({ threadId, ms: Object.fromEntries(turn.marks.map(([label, at]) => [label, Math.round(at)])) })}`)
}

/** The turn on `threadId` ended without a first word: nothing is logged. */
export function turnTimingEnd(threadId: string): void {
  turns.delete(threadId)
}
