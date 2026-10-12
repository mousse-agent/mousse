import type { ProviderCapabilities } from './adapters/ProviderAdapter'
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
  if (!run || run.status === 'finalizing' || TERMINAL_RUN_STATUSES.has(run.status))
    return 'late_steer_new_run'
  if (run.status === 'queued') return 'queue'
  if (caps.steer === 'native') return 'native'
  if (caps.steer === 'interrupt_restart' && caps.interrupt) return 'interrupt_restart'
  return 'queue'
}

/**
 * `interrupt` asks the provider to stop the live turn; `settle_locally` ends the run without
 * provider I/O (nothing live, or the provider cannot be interrupted and the turn is abandoned by
 * its signal); `noop` for a missing or terminal run.
 */
export type StopStrategy = 'interrupt' | 'settle_locally' | 'noop'

export function stopStrategy(caps: ProviderCapabilities, run: RunRecord | null): StopStrategy {
  if (!run || TERMINAL_RUN_STATUSES.has(run.status)) return 'noop'
  if (run.status === 'queued') return 'settle_locally'
  return caps.interrupt ? 'interrupt' : 'settle_locally'
}

/** Sparse event streams go quiet for long stretches during a healthy turn. */
export const SPARSE_EVENTS_HEARTBEAT_FACTOR = 6

/** Reconciler rule 2 tolerance for a run without a heartbeat. */
export function heartbeatToleranceMs(caps: ProviderCapabilities, baseMs: number): number {
  return caps.events === 'sparse' ? baseMs * SPARSE_EVENTS_HEARTBEAT_FACTOR : baseMs
}

/** Idle time after a closed stream that ends a best-effort run (SPEC §13.2). */
export const IDLE_CLOSE_TERMINAL_MS = 30_000

export type TerminalPolicy = 'event_only' | 'event_or_idle_close'

/**
 * A reliable provider ends a turn only with a terminal event. A best-effort provider may close
 * its stream without one; a closed stream followed by `IDLE_CLOSE_TERMINAL_MS` of silence also
 * counts as terminal.
 */
export function terminalPolicy(caps: ProviderCapabilities): TerminalPolicy {
  return caps.terminalQuality === 'best_effort' ? 'event_or_idle_close' : 'event_only'
}
