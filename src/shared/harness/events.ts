import type { HarnessError } from './types'

/**
 * Events of one harness turn: a closed, versioned union. Every turn yields exactly one `turn.end`
 * and nothing after it; the gateway synthesizes it (and closes orphaned tool starts) when a driver
 * does not. Unknown values are absent, never zero.
 */
export const HARNESS_EVENT_VERSION = 1

/** A native session the runtime can resume or fork. */
export interface NativeSessionRef {
  sessionId: string
  /** Turn ordinal inside the session, when the runtime numbers turns. */
  turnOrdinal?: number
}

/** Notices the gateway raises instead of failing or silently degrading. */
export type HarnessNoticeCode =
  | 'history_injected'
  | 'session_restarted'
  | 'newer_than_tested'
  | 'compacted'
  | 'retrying'

/** How a tool call ended. A synthesized end is `interrupted` or `unknown`, never `completed`. */
export type ToolEndStatus = 'completed' | 'failed' | 'interrupted' | 'unknown'

export type HarnessEvent =
  | { type: 'turn.start'; turnId: string }
  | { type: 'text'; phase: 'delta' | 'complete'; text: string }
  | { type: 'thinking'; phase: 'delta' | 'complete'; text: string }
  | { type: 'tool.start'; callId: string; name: string; input?: unknown }
  | { type: 'tool.update'; callId: string; output: unknown }
  | { type: 'tool.end'; callId: string; status: ToolEndStatus; output?: unknown; synthesized?: true }
  | { type: 'request'; requestId: string; kind: 'approval' | 'question' | 'plan'; payload: unknown }
  | { type: 'usage'; input?: number; output?: number; cacheRead?: number; cacheWrite?: number }
  | { type: 'context'; input: number; window?: number }
  | { type: 'native_ref'; ref: NativeSessionRef }
  | { type: 'steer.accepted'; text: string; delivery: 'live' | 'restarted' | 'queued' }
  | { type: 'notice'; code: HarnessNoticeCode; message?: string }
  /**
   * Liveness, separate from model progress: `process` = the runtime is alive (a quiet tool is not
   * killed for lack of text); `model` = the model produced output.
   */
  | { type: 'heartbeat'; source: 'process' | 'model' }
  | { type: 'turn.end'; status: 'completed' | 'interrupted' | 'failed'; error?: HarnessError }

export type HarnessEventType = HarnessEvent['type']

/** One event on the wire, numbered within its turn. */
export interface HarnessEventEnvelope {
  v: typeof HARNESS_EVENT_VERSION
  turnId: string
  seq: number
  event: HarnessEvent
}

export function isTurnEnd(event: HarnessEvent): event is Extract<HarnessEvent, { type: 'turn.end' }> {
  return event.type === 'turn.end'
}
