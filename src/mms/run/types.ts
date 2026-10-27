import type { ExecutionBinding } from '../../shared/harness/types'
import type { AgentAccessLevel } from '../../shared/settings'
export type RunStatus =
  | 'queued'
  | 'starting'
  | 'running'
  | 'finalizing'
  | 'paused'
  | 'completed'
  | 'interrupted'
  | 'failed'
  | 'cancelled'
  | 'uncertain'

/** `paused` is not terminal: the run waits for a usage limit to reset and is not active (SPEC §5). */
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

/** How a pause ended (`RunPause.endedBy`). Set only once the run has left `paused`. */
export type RunPauseEnd = 'resume' | 'resume_now' | 'user_message' | 'cancel' | 'stop' | 'deleted'

/** Why a run is `paused` and when it continues (SPEC §5). Stored in `RunOutcome.pause`. */
export interface RunPause {
  reason: 'usage_limit'
  /** ISO time the limit resets: the provider's, or an estimate. */
  until: string
  estimated: boolean
  provider?: string
  /** The window that was hit (`five_hour`, `weekly`, …). */
  limitKind?: string
  /** Automatic resumes in a row on the thread, this pause included. */
  count: number
  /** Whether a `run.resume` timer was armed for `until`. */
  autoResume: boolean
  /** The message queue item that carries the continue turn (`resume:<runId>`). */
  resumeItemId?: string
  resumeRequested?: 'auto' | 'user'
  /**
   * The automatic timer fired more than 24 h after `until` (Mousse was off) and was dropped
   * (`endPause(…, 'stale')`): the run is still `paused`, `autoResume` is off, and only Resume now
   * continues it. Not an end: `endedBy` stays unset.
   */
  stale?: true
  /** How the pause ended; only on a run that is no longer `paused`. */
  endedBy?: RunPauseEnd
}

export interface RunOutcome {
  error?: string
  interruptedBy?: 'user' | 'daemon_restart' | 'provider'
  uncertainReason?: string
  stopRequested?: boolean
  /** SPEC §16.4: the interrupted run this send continues ("Continue" after a restart). */
  continuationOf?: string
  /** Set while the run is `paused`, and kept after the pause ended. */
  pause?: RunPause
  /** On the run that continues a paused one: whether the timer (`auto`) or a person (`user`) resumed it. */
  resumedFromPause?: 'auto' | 'user'
  /**
   * SPEC §16.3: how an undo run restored the conversation (`featureGates.canUndoNatively`):
   * `native_rollback` when the provider can roll its own session back, else `checkpoint`.
   */
  undoStrategy?: 'native_rollback' | 'checkpoint'
  /** SPEC §13.3: how a Stop reached the run (`CommandPolicy.stopStrategy`). */
  stopStrategy?: 'interrupt' | 'settle_locally'
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
  /**
   * The agent access level this run's turn was granted when it started (SPEC §15.1), kept so a run that
   * continues it (a resume after a pause, a "Continue" after a restart, a provider's own continuation)
   * is never granted more. Absent on runs from before it was recorded, and on a run whose turn never started.
   */
  accessGrant?: AgentAccessLevel
}

export interface ProviderRef {
  /** `llmProvider` name of the turn (derived from the instance; see `TurnInput.llmProvider`). */
  provider: string
  /**
   * Provider instance that owns the session (SPEC §13.8). A session is only resumed, interrupted
   * or forked through this instance; refs recorded before instances existed lack it and are mapped
   * from `provider`.
   */
  instanceId?: string
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
  /**
   * The immutable binding the attempt runs on (instance, account generation, home, config revision,
   * model, policy), resolved by the harness gateway when the turn starts. Absent until then, and on
   * attempts made before bindings were recorded.
   */
  executionBinding?: ExecutionBinding
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

/**
 * Sources of local-action runs (SPEC §16.3): `undo` and `revert` run Git mechanics in-process, with
 * no effect and no provider; they heartbeat while the action runs (reconciler rule 2).
 */
export const LOCAL_ACTION_SOURCES: ReadonlySet<string> = new Set(['undo', 'revert'])

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
  | 'run.resume'

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
   * SPEC §12.2: a kind with no producer yet. Enqueueing one fails at once (`bad_request`); the
   * worker has no executor for it either.
   */
  reserved?: boolean
  /**
   * Lane override. Without one the lane is the effect's thread. `control` effects (interrupt,
   * steer, answers) must reach a live turn, so they never queue behind the thread's `turn.start`.
   * `resume` effects wait for a usage limit to reset and must not hold up the thread's other work.
   */
  lane?: 'title' | 'control' | 'resume'
  /** Defaults to `DEFAULT_EFFECT_MAX_ATTEMPTS`. */
  maxAttempts?: number
}

export const DEFAULT_EFFECT_MAX_ATTEMPTS = 5

/**
 * Which worker fibres may claim an effect kind (SPEC §12.3): `turn` fibres run `turn.start` (one
 * per live turn, so their count caps a profile's concurrent turns), `control` fibres run the
 * interrupts, steers and answers that must reach a live turn, and `replaySafe` fibres run the
 * replay-safe kinds. A long turn can therefore never starve a Stop.
 */
export type EffectLaneClass = 'turn' | 'control' | 'replaySafe'

const CONTROL_EFFECT_KINDS: ReadonlySet<EffectKind> = new Set<EffectKind>([
  'turn.interrupt',
  'turn.steer',
  'request.respond'
])

export function effectLaneClass(kind: EffectKind): EffectLaneClass {
  if (kind === 'turn.start') return 'turn'
  return CONTROL_EFFECT_KINDS.has(kind) ? 'control' : 'replaySafe'
}

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
  // Delivers a saved approval request's answer to the provider callback waiting in this process (SPEC §17.4).
  'request.respond': {
    class: 'process_bound',
    timeoutMs: 30_000,
    maxAttempts: 1,
    lane: 'control'
  },
  'checkpoint.capture': { class: 'replay_safe', timeoutMs: 2 * 60_000, reserved: true },
  'title.generate': { class: 'replay_safe', timeoutMs: 60_000, lane: 'title', reserved: true },
  'workspace.cleanup': { class: 'replay_safe', timeoutMs: 5 * 60_000, reserved: true },
  'run.resume': { class: 'replay_safe', timeoutMs: 60_000, lane: 'resume' }
}

/** Payload of a `run.resume` effect: continue the paused run `runId` at `until` (or now, for Resume now). */
export interface RunResumePayload {
  kind: 'resume'
  runId: string
  threadId: string
  until: string
  /** A person pressed Resume now: the executor skips the staleness guard. */
  manual?: true
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

// Phase 4: lineage, delegations and the inbox (docs/run-engine/SPEC.md §14.1).

export type LineageRelationship = 'subagent' | 'fork'

export interface LineageRecord {
  threadId: string
  parentThreadId: string
  parentRunId: string
  relationship: LineageRelationship
  createdAt: string
}

export type DelegationStatus = 'running' | 'result_available' | 'acknowledged' | 'cancelled' | 'failed'

export type DelegationWake = 'always' | 'settled_only'

/** What a child run published: its terminal status and final text or failure. */
export interface DelegationResult {
  runStatus: RunStatus
  text?: string
  error?: string
  /**
   * The run the result comes from: the subagent's latest conversational run when the task
   * published, which is later than the task's own run when the subagent waited on its own subagents.
   * Absent on results published before subagents could wait.
   */
  runId?: string
}

export interface DelegationRecord {
  delegationId: string
  parentRunId: string
  parentThreadId: string
  childThreadId: string
  childRunId: string
  /**
   * Provider instance id the child was asked to run on (null: the parent's). Rows written before
   * provider instances existed hold the legacy `llmProvider` name instead.
   */
  provider: string | null
  model: string | null
  promptDigest: string
  wake: DelegationWake
  status: DelegationStatus
  result: DelegationResult | null
  createdAt: string
  completedAt: string | null
  /** The most the child may do (SPEC §15.1); null when the delegation set none. */
  modeCeiling: ModeCeiling | null
  /**
   * The agent access level the delegation passes to its child (SPEC §15.1): the caller's effective
   * level when it started the task. Null on rows from before version 11, which read as `lineage`.
   */
  accessLevel: AgentAccessLevel | null
  /** The child's workspace policy (SPEC §14.2); null for a follow-up or a pre-version-6 row. */
  workspace: DelegationWorkspace | null
  /** The requested role (`research`, `review`, `implement`, …); null when none was given. */
  role: string | null
}

export type DelegationWorkspace = 'isolated' | 'shared'

/**
 * What a run's Mousse MCP credential may do (SPEC §15.1): `plan` is read-only planning (no
 * writes, no integration, children stay `plan`); `default` is the thread's ordinary authority.
 */
export type ModeCeiling = 'plan' | 'default'

/**
 * The agent behind a change to another thread (SPEC §15.1): the thread and run that called the tool
 * and the tool call itself. Recorded in the `agent.action` event on the thread that was changed.
 */
export interface AgentActor {
  kind: 'agent'
  threadId: string
  runId: string
  toolCallId: string
}

export type InboxKind = 'child_result' | 'restart_note' | 'reconcile_notice'

export type InboxStatus = 'pending' | 'delivered' | 'acknowledged'

export interface InboxRecord {
  inboxId: string
  threadId: string
  runId: string | null
  kind: InboxKind
  payload: unknown
  status: InboxStatus
  createdAt: string
  /**
   * The effect that delivered a `delivered` row (a wake `turn.start` or a `turn.steer`); null while
   * pending, after acknowledgement of an undelivered row, or for rows delivered before migration 7.
   */
  deliveredBy: string | null
}

/** Payload of a `child_result` inbox row. */
export interface ChildResultPayload {
  delegationId: string
  childThreadId: string
  childRunId: string
  result: DelegationResult
}

/**
 * Payload of a `reconcile_notice` row that tells a subagent's parent the subagent is waiting for an
 * answer (issue #142). `requestId` names the pending question; it lives in the daemon's memory only, so
 * the row is stale once the question is answered, dismissed or the daemon restarts.
 */
export interface ChildQuestionPayload {
  kind: 'child_question'
  childThreadId: string
  childRunId: string | null
  requestId: string
  delegationId?: string
}

export function isChildQuestionRow(row: Pick<InboxRecord, 'kind' | 'payload'>): boolean {
  return row.kind === 'reconcile_notice' && (row.payload as { kind?: unknown } | null)?.kind === 'child_question'
}

/** Payload of a `turn.start` effect that wakes a thread for its pending inbox rows (rule 4). */
export interface WakeTurnPayload {
  kind: 'wake'
  threadId: string
  runId: string
  inboxIds: string[]
}

export function isWakeTurnPayload(payload: unknown): payload is WakeTurnPayload {
  return Boolean(payload) && typeof payload === 'object' && (payload as { kind?: unknown }).kind === 'wake'
}

/**
 * Payload of a bot dispatch's `turn.start` (PR 6 §4). It carries no `input` and no authority: the
 * prompt and the grant live only in `bots.db`, and the executor rebuilds the turn from there. With
 * no `input` and a string `kind`, rule 5 never restarts it as an ordinary send, in this build or in
 * any older one (`strandedQueuedRuns`), so a build without bots never starts a bot run.
 */
export interface BotTurnPayload {
  kind: 'bot'
  runId: string
  threadId: string
  activationId: string
  dispatchN: number
}

export function isBotTurnPayload(payload: unknown): payload is BotTurnPayload {
  if (!payload || typeof payload !== 'object') return false
  const value = payload as Record<string, unknown>
  return value.kind === 'bot' && typeof value.runId === 'string' && typeof value.threadId === 'string' &&
    typeof value.activationId === 'string' && Number.isSafeInteger(value.dispatchN)
}

/** A `turn.start` payload of a kind this build does not know: refused, never cast to a send. */
export function hasUnknownTurnPayloadKind(payload: unknown, known: readonly string[]): boolean {
  if (!payload || typeof payload !== 'object') return false
  const kind = (payload as { kind?: unknown }).kind
  return typeof kind === 'string' && !known.includes(kind)
}

/**
 * A `turn.start` payload that carries an ordinary send (its `input`), so a queued run whose effect
 * died can be started again from it (reconciler rule 5). Wake and integration payloads carry no
 * `input`; a queue item's payload (`queueItemId`) is restarted by the message queue's own recovery.
 */
export interface SendTurnPayload {
  runId: string
  threadId: string
  input: unknown
  queueItemId?: string
}

export function isSendTurnPayload(payload: unknown): payload is SendTurnPayload {
  if (!payload || typeof payload !== 'object') return false
  const value = payload as Record<string, unknown>
  return typeof value.runId === 'string' && typeof value.threadId === 'string' && value.input !== undefined && value.input !== null
}

// Phase 6: context handoffs and thread transfers (docs/run-engine/SPEC.md §16).

/**
 * How a turn learns what happened before it (SPEC §16.1): `native_resume` sends nothing (the
 * provider still holds its session); `delta` sends the runs since the target provider's last turn;
 * `full_summary` rebuilds the context; `fork_delta_summary` is what a fork did since its fork point
 * (merge-back, §16.2); `legacy_import` is reserved for threads imported without runs.
 */
export type HandoffStrategy = 'native_resume' | 'delta' | 'full_summary' | 'fork_delta_summary' | 'legacy_import'

export type HandoffStatus = 'pending' | 'delivered' | 'failed'

export interface HandoffRecord {
  handoffId: string
  threadId: string
  targetRunId: string
  fromRef: ProviderRef | null
  toRef: ProviderRef
  strategy: HandoffStrategy
  coveredFromOrdinal: number | null
  coveredToOrdinal: number | null
  budgetTokens: number
  selectedItems: number
  omittedItems: number
  status: HandoffStatus
  createdAt: string
  deliveredAt: string | null
}

export type TransferType = 'fork' | 'merge_back'

export type TransferStatus = 'pending' | 'consumed' | 'superseded' | 'failed'

export interface TransferRecord {
  transferId: string
  type: TransferType
  sourceThreadId: string
  targetThreadId: string
  /** Fork: the source run the fork starts after. Merge-back: the fork's latest run. */
  sourceRunOrdinal: number
  status: TransferStatus
  payload: Record<string, unknown>
  createdAt: string
  consumedAt: string | null
}
