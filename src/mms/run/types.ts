import type { ExecutionBinding } from '../../shared/harness/types'
import type { AgentAccessLevel } from '../../shared/settings'
import type { PermissionMode } from '../../shared/permissionMode'
import type { BotLook } from '../../shared/bots/personal/look'
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
  /** The typed reason of `error`, when it has one (`binding_stale` for a run on the retired bare pi route). */
  errorCode?: string
  /**
   * A scheduled run that failed on a provider usage limit (it is never paused): when the limit resets. The
   * scheduler records the occurrence as waiting and runs the job again then.
   */
  usageLimitUntil?: string
  /** With `usageLimitUntil`: the window the provider named (`five_hour`, `seven_day_opus`), when it named one. */
  usageLimitKind?: string
  /**
   * `bot_wall`: a personal bot's dispatch ended at a wall (PR 6 §5); the run engine never retries it.
   * `agent`: another thread's agent stopped the run (`thread_stop`); it settles as a user's Stop does (`stoppedByPerson`).
   */
  interruptedBy?: 'user' | 'agent' | 'daemon_restart' | 'provider' | 'bot_wall'
  uncertainReason?: string
  stopRequested?: boolean
  /** Set with `stopRequested` (or on a paused run a Stop ends) when an agent asked for the Stop; the terminal write then records `interruptedBy: 'agent'`. */
  stopRequestedBy?: 'agent'
  /**
   * Another thread's agent sent the message this run answers (`thread_send`). Such a run never ends a usage-limit
   * pause by starting, and `agentHops` is how many agent messages in a row led to it.
   */
  sentByAgent?: true
  agentHops?: number
  /**
   * The chain of agent messages this run belongs to (`AgentChains`): the chain of the agent message that started it, or
   * of the run it carries on (a wake, a settle notice, a provider's continuation, a resume, a subagent's task). Absent on
   * a run a person or a schedule started: it starts a chain of its own (`chainIdOf`).
   */
  agentChain?: string
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
 * no effect and no provider; `clear` and `compact` (the composer's `/clear` and `/compact`) replace the
 * thread's model context, `compact` through the provider's own compaction when it has one. They
 * heartbeat while the action runs (reconciler rule 2).
 */
export const LOCAL_ACTION_SOURCES: ReadonlySet<string> = new Set(['undo', 'revert', 'clear', 'compact'])

/**
 * A Stop ended the run, whether a person pressed it or another thread's agent asked for it
 * (`interruptedBy` `user` or `agent`). Everything that treats "the user stopped it" specially (no
 * wake, no integration notice, no redelivery) asks this, so an agent's Stop is never taken for a failure.
 */
export function stoppedByPerson(outcome: { interruptedBy?: string } | null | undefined): boolean {
  return outcome?.interruptedBy === 'user' || outcome?.interruptedBy === 'agent'
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
  /** How long one attempt may run, and the lease it holds while it runs (renewed every third of it). */
  timeoutMs: number
  /**
   * `false`: `timeoutMs` is the lease only, never a deadline on the work. A turn runs as long as it makes progress; what
   * ends a hung one is its own no-progress check (`TURN_STALL_MS`), not its total time.
   */
  deadline?: false
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
 * Which part of the worker may claim an effect kind (SPEC §12.3): the turn claimer runs `turn.start`
 * (every due turn at once, no limit), `control` fibres run the interrupts, steers and answers that
 * must reach a live turn, and `replaySafe` fibres run the replay-safe kinds. A turn can therefore
 * never hold up a Stop.
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
  'turn.start': { class: 'process_bound', timeoutMs: 6 * 60 * 60_000, deadline: false, maxAttempts: 1 },
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
  /** Set only on a personal bot's work subagent (`BotDelegation`): the bot's tree it belongs to. */
  bot?: BotDelegation
}

/**
 * A bot subagent's place in its bot's work (Run DB v29): the bot, the work activation at the root of the tree (its counts
 * and spend in bots.db are the subagent's too), and the narrowing the subagent inherits from the turn that started it.
 */
export interface BotDelegation {
  botId: string
  rootActivationId: string
  /** The limit of the device the owner wrote from (`BotOwnerTurn.limit`), or null: none. */
  access: PermissionMode | null
  /** The subagent only reads the owner's threads (`threadsReadOnly` of the turn that started it). */
  readOnly: boolean
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
  /** How many agent messages in a row led to this one (the sender's own count plus one); set by the thread owner. */
  hops?: number
  /** The chain of agent messages it belongs to (`AgentChains`); set by the thread owner for a sender on this computer. */
  chain?: string
  /**
   * Set when the agent is on another of the user's computers (a routed call marked as an agent's): `threadId` and `runId`
   * are then its ids on that computer, and nothing about the sender is looked up here. `node` is the calling computer
   * as the authenticated link names it, `computer` its name from this computer's pairing record, `title` the sender's
   * cleaned title, and `mode` the most the sender may do here: the narrowest of the mode it carried and the limit this
   * computer set for that device. `hops` is already the owner's own count (the larger of the carried count and its own).
   */
  remote?: {
    node: string
    computer: string
    title: string
    mode: PermissionMode
    /** The calling computer's personal bot that sent it (`ROUTED_AGENT_BOT_KEY`), cleaned: shown on its message, never trusted. */
    bot?: { id: string; name: string; look: BotLook }
  }
}

/** `pr_update` is no longer written (see `isRetiredInboxRow`). */
export type InboxKind = 'child_result' | 'restart_note' | 'reconcile_notice' | 'pr_update'

/**
 * A row of a kind no longer written: `pr_update`, which an earlier pull request watch used to wake the agent to change
 * code and push. One an earlier version left is never delivered; it is acknowledged before the run engine's workers
 * start, and the wake and steer paths acknowledge any they still meet.
 */
export function isRetiredInboxRow(row: Pick<InboxRecord, 'kind'>): boolean {
  return row.kind === 'pr_update'
}

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

/**
 * Payload of a `reconcile_notice` row that tells a thread a subagent below it was refused a capability it lacks
 * (docs/plans/tool-api.md §2.4): its parent when the parent holds it (`to: 'parent'`), else the root of its tree, which
 * is told what would give it (`fix`). Written once per capability of the subagent's work.
 */
export interface ChildLacksPayload {
  kind: 'child_lacks'
  childThreadId: string
  childRunId: string
  tool: string
  lacks: string
  fix?: string
  to: 'parent' | 'root'
  delegationId?: string
}

export function isChildQuestionRow(row: Pick<InboxRecord, 'kind' | 'payload'>): boolean {
  return row.kind === 'reconcile_notice' && (row.payload as { kind?: unknown } | null)?.kind === 'child_question'
}

/**
 * Payload of a `reconcile_notice` row that carries another agent's note (docs/plans/tool-api.md §2.2): information that
 * grants nothing, labelled with who sent it and what it may do. It is delivered as any notice is: steered into a native
 * run, handed over with a Mousse tool's result on a runtime that restarts its reply, or with the thread's next turn.
 */
export interface AgentNotePayload {
  kind: 'agent_note'
  senderThreadId: string
  senderRunId: string
  senderTitle: string | null
  /** What the sender may do, for the label: a read-only subagent, a Plan ceiling, or an agent that may change files. */
  senderAccess: 'read_only' | 'plan' | 'agent'
  /**
   * Who the sender is to the receiver; `bot` is the owner's personal bot that started the receiving thread. `person`: a
   * person's correction to an ancestor, relayed down its tree (`treeCorrection.ts`); the sender is that ancestor, and
   * the note carries none of the person's authority. `relay`: Mousse's record, to that ancestor, of where it went.
   */
  from: 'parent' | 'ancestor' | 'subagent' | 'sibling' | 'bot' | 'person' | 'relay'
  text: string
  /** The tree instruction revision a `person` or `relay` note belongs to. */
  revisionId?: string
  /** A `person` note: whether the ancestor is the receiver's parent. */
  direct?: boolean
  /** `needed` starts a notice turn on an idle thread; `none` waits for the thread's next turn. */
  attention: 'needed' | 'none'
}

export function isAgentNoteRow(row: Pick<InboxRecord, 'kind' | 'payload'>): boolean {
  return row.kind === 'reconcile_notice' && (row.payload as { kind?: unknown } | null)?.kind === 'agent_note'
}

/** What a thread agent started in the background (`monitor_start`, `background_run`, `keep_working`). */
export type { MonitorKind, MonitorEnd } from '../../shared/backgroundWork'
import type { MonitorKind, MonitorEnd } from '../../shared/backgroundWork'

/**
 * Payload of a `reconcile_notice` row that carries what a thread's monitor or background command reported
 * (`ThreadMonitors`): a batch of its events, and on the last one how it ended. It is delivered as an agent note is:
 * steered into a native run, handed over with a Mousse tool's result on a runtime that restarts its reply, or as a wake
 * turn of an idle thread. Its events are outside text: the notice quotes them.
 */
export interface MonitorEventPayload {
  kind: 'monitor_event'
  monitorId: string
  monitorKind: MonitorKind
  /** The agent's short description of it. */
  description: string
  /** What it printed or received since the last notice, one entry per line or message, each cut. */
  events: string[]
  /** Events left out of this notice because it was full. */
  droppedEvents?: number
  /** Set on its last notice. */
  end?: MonitorEnd
  /** A background command's last output, on its end notice. */
  tail?: string
  /** `needed` starts a notice turn on an idle thread; `none` waits for the thread's next turn (after a Stop). */
  attention: 'needed' | 'none'
}

export function isMonitorEventRow(row: Pick<InboxRecord, 'kind' | 'payload'>): boolean {
  return row.kind === 'reconcile_notice' && (row.payload as { kind?: unknown } | null)?.kind === 'monitor_event'
}

/**
 * Payload of a `reconcile_notice` row that carries a thread agent's own wake-up (`wake`, `ThreadWakes`): it was due, or
 * what it waited on happened (another thread finished its turn, a pull request merged, its checks settled or it got a
 * review), or it ended without it. It is delivered as an agent note is, and grants nothing: an idle thread starts a turn
 * no person started, a running turn takes it as a steer or with its next Mousse tool call, and it waits while the thread
 * waits on a person's answer. `text` is the whole notice the agent reads (`wakeInput`); the rest is for the app's row.
 * One with `attention: none` says the thread's wake-ups were cancelled (its Stop or archive) and waits for its next turn.
 */
export interface ThreadWakePayload {
  kind: 'thread_wake'
  wakeId: string
  /** What happened, in a few words: "Following up · acme/app#12 merged" (`wakeFiredLabel`). */
  label: string
  /** What the agent wrote for itself. */
  brief: string
  text: string
  attention: 'needed' | 'none'
}

export function isThreadWakeRow(row: Pick<InboxRecord, 'kind' | 'payload'>): boolean {
  return row.kind === 'reconcile_notice' && (row.payload as { kind?: unknown } | null)?.kind === 'thread_wake'
}

/**
 * A row that waits while the thread waits on a person's answer: an agent's note, a monitor's event or a wake-up. A live
 * provider settles a pending request when it takes a steer, and none of them answers one.
 */
export function waitsForAnswer(row: Pick<InboxRecord, 'kind' | 'payload'>): boolean {
  return isAgentNoteRow(row) || isMonitorEventRow(row) || isThreadWakeRow(row)
}

/** A note, a monitor's notice or a wake-up's sent with `attention: none`: it never starts a turn of its own. */
export function isQuietNoteRow(row: Pick<InboxRecord, 'kind' | 'payload'>): boolean {
  if (isAgentNoteRow(row)) return (row.payload as AgentNotePayload).attention === 'none'
  if (isThreadWakeRow(row)) return (row.payload as ThreadWakePayload).attention === 'none'
  return isMonitorEventRow(row) && (row.payload as MonitorEventPayload).attention === 'none'
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
  /** The bot dispatch the run carries; 0 for a work subagent's turn, which is a delegation (`delegationId`) instead. */
  dispatchN: number
  /**
   * A work subagent's turn (Run DB v29): the delegation it runs for, under `activationId` (the work at the root). A build
   * without it reads dispatch 0, which no activation has, and refuses the turn.
   */
  delegationId?: string
  /** What the work started the subagent with (its title and model), for the bot engine; opaque to the run engine. */
  subagent?: unknown
  /** A work subagent's brief: what its turn is asked. */
  prompt?: string
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
