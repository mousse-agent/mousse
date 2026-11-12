import type { RunCapabilities as ProviderCapabilities } from '../../shared/harness/types'
import { TERMINAL_RUN_STATUSES, type RunRecord } from './types'

/**
 * Command decisions from `(capabilities, run)` (docs/run-engine/SPEC.md §13.3). Pure: the engine
 * and executors call these instead of branching on a provider.
 */

export type SteerStrategy = 'native' | 'interrupt_restart' | 'queue' | 'late_steer_new_run'

/**
 * How steer text reaches `run`. A missing, finalizing or terminal run cannot take it any more:
 * the text becomes a new run. A queued run has no live turn yet, so the text queues. A live run
 * follows the provider: native delivery, interrupt-and-restart (only when it can be interrupted),
 * or the queue.
 */
export function steerStrategy(caps: ProviderCapabilities, run: RunRecord | null): SteerStrategy {
  // A paused run has no live turn and none is coming: the text becomes a message of its own.
  if (!run || run.status === 'finalizing' || run.status === 'paused' || TERMINAL_RUN_STATUSES.has(run.status))
    return 'late_steer_new_run'
  if (run.status === 'queued') return 'queue'
  if (caps.steer === 'native') return 'native'
  if (caps.steer === 'interrupt_restart' && caps.interrupt) return 'interrupt_restart'
  return 'queue'
}

/**
 * What a drain of pending steers would do now (docs/design/steer-and-interruptions.md §2.2):
 * - `cut`: end the provider's current reply now and continue the turn with the text;
 * - `native`: the provider's own steer, or the next provider turn of the same run at a boundary;
 * - `hold`: take nothing; the steers stay pending until a foreground tool has its result.
 */
export type SteerDelivery = 'cut' | 'native' | 'hold'

/** When an adapter reports a tool call (`ProviderCapabilities.steerBoundary`). */
export type SteerBoundary = 'announce' | 'start' | 'none'

/** What the turn is doing when a steer is decided. */
export interface SteerTurnFacts {
  /** Foreground tools announced or running (`TranscriptAssembler.foregroundTools`). */
  foreground: number
  /** The release window after the last foreground tool is still open (`start` providers only). */
  releaseOpen: boolean
  /** Strict release for this instance (`runs.steerRelease`). */
  strict: boolean
  /** A steer is already held in this turn. Strict release keeps it held until the boundary. */
  held: boolean
  /** The provider reported the end of its own turn and nothing has run since. */
  atBoundary: boolean
  /** Send now: the person asked for the held steer to go in at once. */
  forced: boolean
}

/**
 * How pending steers reach a live turn. A person's steer waits for a foreground tool and cuts while
 * the model writes; an agent's steer or a subagent notice follows the provider's `steer` capability,
 * and on an `interrupt_restart` provider it also waits for a tool. A provider at `steerBoundary: 'none'`
 * keeps the behaviour from before the hold: a person's steer cuts, anything else follows the capability.
 */
export function steerDelivery(caps: Pick<ProviderCapabilities, 'steer' | 'steerBoundary'>, turn: SteerTurnFacts, steer: { person: boolean }): SteerDelivery {
  const capability: SteerDelivery = caps.steer === 'interrupt_restart' ? 'cut' : 'native'
  // Caps saved before the key existed read as `none`.
  const boundary: SteerBoundary = caps.steerBoundary ?? 'none'
  if (boundary === 'none') return steer.person ? 'cut' : capability
  if (steer.person && turn.forced) return 'cut'
  // A `native` provider takes an agent's steer at its next step by itself: it waits for the tool.
  if (!steer.person && caps.steer === 'native') return 'native'
  if (turn.foreground > 0 || turn.releaseOpen) return 'hold'
  // Strict release keeps a steer that is already held held until the provider's turn ends. On an
  // `announce` provider every tool is known before it runs, so there is nothing to wait out.
  if (turn.strict && turn.held && boundary === 'start' && !turn.atBoundary) return 'hold'
  if (turn.atBoundary) return 'native'
  return steer.person ? 'cut' : capability
}

/**
 * How long the release window stays open after the last foreground tool's result on a `start`
 * provider, when the model shows nothing (§2.3): twice the largest gap spike S4 measured on Codex
 * between a result and the next start of the same response, plus 100 ms. A provider declares its
 * own (`steerSettleMs`); this is the window of a hold built without one.
 */
export const STEER_SETTLE_MS = 232

/**
 * The longest window best effort may use (§6, the S4 pass rule): a provider whose measured window would be longer, or
 * whose gap was never measured, ships strict release instead. Such a provider still holds a steer that arrives within
 * this long of a tool's result, so a second command of the same response is not cut either.
 */
export const MAX_STEER_SETTLE_MS = 1_000

/**
 * How a held steer is released on an instance (§2.3.2): the instance's strict setting, and the window after a tool.
 * A `start` provider with a measured window (`caps.steerSettleMs`) releases best effort unless the instance asks for
 * strict; one without (never measured, or over the cap) is always strict, with the window at the cap. Other providers
 * have no window: an `announce` provider knows every tool before it runs.
 */
export function steerReleaseWindow(
  caps: Pick<ProviderCapabilities, 'steerBoundary' | 'steerSettleMs'>,
  setting: 'best_effort' | 'strict' | undefined
): { strict: boolean; settleMs: number } {
  if (caps.steerBoundary !== 'start') return { strict: setting === 'strict', settleMs: 0 }
  // Caps saved before the key existed have no window: strict.
  const measured = typeof caps.steerSettleMs === 'number' && caps.steerSettleMs > 0 && caps.steerSettleMs <= MAX_STEER_SETTLE_MS ? caps.steerSettleMs : undefined
  if (measured === undefined) return { strict: true, settleMs: MAX_STEER_SETTLE_MS }
  return { strict: setting === 'strict', settleMs: measured }
}

/**
 * `interrupt` asks the provider to stop the live turn; `settle_locally` ends the run without
 * provider I/O (nothing live, or the provider cannot be interrupted and the turn is abandoned by
 * its signal); `noop` for a missing or terminal run.
 */
export type StopStrategy = 'interrupt' | 'settle_locally' | 'noop'

export function stopStrategy(caps: ProviderCapabilities, run: RunRecord | null): StopStrategy {
  if (!run || TERMINAL_RUN_STATUSES.has(run.status)) return 'noop'
  // A paused run has nothing live to interrupt: the provider's turn ended with the usage limit.
  if (run.status === 'queued' || run.status === 'paused') return 'settle_locally'
  return caps.interrupt ? 'interrupt' : 'settle_locally'
}

/** Sparse event streams go quiet for long stretches during a healthy turn. */
export const SPARSE_EVENTS_HEARTBEAT_FACTOR = 6

/**
 * The heartbeat interval reconciler rule 2 scales its silence window by: the base interval, or 6×
 * it for a provider whose event stream is sparse.
 */
export function heartbeatToleranceMs(caps: ProviderCapabilities, baseMs: number): number {
  return caps.events === 'sparse' ? baseMs * SPARSE_EVENTS_HEARTBEAT_FACTOR : baseMs
}
