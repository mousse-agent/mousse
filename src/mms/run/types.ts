export type RunStatus =
  | 'queued'
  | 'starting'
  | 'running'
  | 'finalizing'
  | 'completed'
  | 'interrupted'
  | 'failed'
  | 'cancelled'
  | 'uncertain'

export const TERMINAL_RUN_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>([
  'completed',
  'interrupted',
  'failed',
  'cancelled',
  'uncertain'
])

export type AttemptStatus =
  'pending' | 'running' | 'completed' | 'interrupted' | 'failed' | 'cancelled' | 'superseded'

export type AttemptReason = 'initial' | 'steer_restart' | 'retry' | 'recovery'

export interface RunOutcome {
  error?: string
  interruptedBy?: 'user' | 'daemon_restart' | 'provider'
  uncertainReason?: string
  stopRequested?: boolean
}

export interface RunRecord {
  runId: string
  threadId: string
  ordinal: number
  status: RunStatus
  epoch: number
  activeAttemptId: string | null
  source: string
  clientRequestId: string | null
  userMessageId: string | null
  requestedAt: string
  startedAt: string | null
  completedAt: string | null
  outcome: RunOutcome | null
  /** Last liveness touch by the executing turn (SPEC §12.4 rule 2). Not a status write. */
  heartbeatAt: string | null
}

export interface ProviderRef {
  provider: string
  model?: string
  sessionId?: string
  nativeTurnId?: string
}

export interface AttemptRecord {
  attemptId: string
  runId: string
  ordinal: number
  reason: AttemptReason
  status: AttemptStatus
  providerRef: ProviderRef | null
  startedAt: string | null
  completedAt: string | null
}

export interface ReceiptRecord {
  clientRequestId: string
  threadId: string
  commandKind: string
  status: 'accepted' | 'rejected' | 'ignored'
  result: unknown
  createdAt: string
}

export interface ThreadEvent {
  seq: number
  threadId: string
  runId: string | null
  type: string
  payload: unknown
  createdAt: string
}

export const runId = (threadId: string, ordinal: number): string =>
  `run:thread:${encodeURIComponent(threadId)}:ordinal:${ordinal}`

export const attemptId = (runId: string, ordinal: number): string => `attempt:${runId}:${ordinal}`

// Phase 2: effects, daemon epochs and the tool ledger (docs/run-engine/SPEC.md §12).

export type EffectKind =
  | 'turn.start'
  | 'turn.interrupt'
  | 'turn.steer'
  | 'request.respond'
  | 'checkpoint.capture'
  | 'title.generate'
  | 'workspace.cleanup'

/** `process_bound` effects die with the daemon; `replay_safe` effects are re-queued on boot. */
export type EffectClass = 'process_bound' | 'replay_safe'

export type EffectStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled'

export const TERMINAL_EFFECT_STATUSES: ReadonlySet<EffectStatus> = new Set<EffectStatus>([
  'succeeded',
  'failed',
  'cancelled'
])

export interface EffectKindSpec {
  class: EffectClass
  timeoutMs: number
  /**
   * Lane override. Without one the lane is the effect's thread. `control` effects (interrupt,
   * steer, answers) must reach a live turn, so they never queue behind the thread's `turn.start`.
   */
  lane?: 'title' | 'control'
  /** Defaults to `DEFAULT_EFFECT_MAX_ATTEMPTS`. */
  maxAttempts?: number
}

export const DEFAULT_EFFECT_MAX_ATTEMPTS = 5

/**
 * SPEC §12.2. A kind's class is fixed here, never per row. Effects that drive a model turn or
 * deliver user input are never retried automatically: a timed-out `turn.start` must not re-run
 * the model, and a steer or answer must not be delivered twice. Only `turn.interrupt` and the
 * replay-safe kinds use the default retry budget.
 */
export const EFFECT_KIND_SPEC: Record<EffectKind, EffectKindSpec> = {
  'turn.start': { class: 'process_bound', timeoutMs: 6 * 60 * 60_000, maxAttempts: 1 },
  'turn.interrupt': { class: 'process_bound', timeoutMs: 30_000, lane: 'control' },
  'turn.steer': { class: 'process_bound', timeoutMs: 30_000, maxAttempts: 1, lane: 'control' },
  'request.respond': {
    class: 'process_bound',
    timeoutMs: 30_000,
    maxAttempts: 1,
    lane: 'control'
  },
  'checkpoint.capture': { class: 'replay_safe', timeoutMs: 2 * 60_000 },
  'title.generate': { class: 'replay_safe', timeoutMs: 60_000, lane: 'title' },
  'workspace.cleanup': { class: 'replay_safe', timeoutMs: 5 * 60_000 }
}

export interface EffectRecord {
  effectId: string
  threadId: string
  runId: string | null
  kind: EffectKind
  class: EffectClass
  status: EffectStatus
  payload: unknown
  attempts: number
  maxAttempts: number
  timeoutMs: number
  availableAt: string
  leaseOwner: string | null
  leaseExpiresAt: string | null
  lastError: string | null
  createdAt: string
  updatedAt: string
  completedAt: string | null
}

export interface DaemonEpochRecord {
  epoch: number
  pid: number
  startedAt: string
  heartbeatAt: string
  /** Set on clean shutdown; null after a crash (or while the daemon is live). */
  endedAt: string | null
}

export type ToolInvocationStatus = 'started' | 'committed' | 'failed' | 'outcome_unknown'

export interface ToolInvocationRecord {
  invocationId: string
  runId: string
  attemptId: string
  tool: string
  idempotent: boolean
  status: ToolInvocationStatus
  argsDigest: string
  startedAt: string
  completedAt: string | null
}

/** Effect lease owner: `"<daemonEpoch>:<pid>"` (SPEC §12.1). */
export const leaseOwner = (epoch: number, pid: number): string => `${epoch}:${pid}`
