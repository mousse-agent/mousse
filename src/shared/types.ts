import type { AgentActivityItem } from './agentActivity'
import type { ModelOverride } from './providerInstances'
import type { ThreadPullRequestLink } from './pullRequests'
import type { PermissionMode } from './permissionMode'
export type { PermissionMode } from './permissionMode'
export type { GitPullRequestInfo, GitPullRequestLookup, PullRequestCheckState } from './pullRequests'
export type MainView = 'browser' | 'terminal' | 'files' | 'git' | 'review' | 'pullRequest' | 'documents'

export type ScheduledJobState = 'scheduled' | 'running' | 'paused' | 'completed' | 'error'

/** `manual` has no clock: the job runs only when started (Run now, or a later trigger). */
export type ScheduleKind = 'once' | 'interval' | 'cron' | 'manual'

export interface JobSchedule {
  kind: ScheduleKind
  runAt?: string
  minutes?: number
  expr?: string
}

export interface ScheduledJobRepeat {
  times?: number
  completed: number
}

/** Where a scheduled run works; a job bound to a thread runs in that thread's own workspace. */
export type ScheduledJobWorkspace = { kind: 'project' } | { kind: 'newWorktree' } | { kind: 'worktree'; path: string }

export interface ScheduledJobRunRecord {
  runAt: string
  /** `queued` while the occurrence waits behind a busy thread; it is updated when its run ends. */
  status: 'ok' | 'error' | 'interrupted' | 'waiting' | 'queued' | 'uncertain'
  output?: string
  error?: string
  silent?: boolean
  threadId?: string
  runId?: string
  queueItemId?: string
  /** The model the run actually used (the run's binding), not the job's field. */
  selection?: ModelOverride
  mode?: 'agent' | 'plan'
  /** The permission mode the run's binding enforced (the stricter of the job, its ceiling and the thread). */
  permissionMode?: PermissionMode
  workspace?: ScheduledJobWorkspace
  occurrenceKey?: string
  missingPlaceholders?: string[]
  /** Set on a `waiting` record: the occurrence hit a provider usage limit that resets at this time. */
  usageLimitUntil?: string
  /** The job was created by an agent (`ScheduledJob.createdBy`); set when the record is saved. */
  agentCreated?: true
}

/**
 * Durable ownership of a running scheduled job claim.
 * Prevents two scheduler instances from completing the same run and fences stale finishers.
 */
export interface ScheduledJobRunClaim {
  pid: number
  processInstanceId: string
  token: string
  claimedAt: string
  heartbeatAt: string
  /** Durable slash-workflow occurrence; restart resumes this exact receipt. */
  workflowInvocationId?: string
  /** This claim is observing a workflow that previously reached a wait state. */
  resumedWaiting?: boolean
  /** The occurrence this claim runs: `nextRunAt` for a timed claim. Names the deterministic send receipt. */
  occurrenceKey: string
  /** Recorded as each becomes known, so a restart can find the run this claim admitted. */
  threadId?: string
  runId?: string
  queueItemId?: string
  /** The run ended before the claim was finalized (a fast drain); finalizing the claim applies it at once. */
  settledResult?: ScheduledOccurrenceResult
  /** Set when a webhook delivery started this claim (`occurrenceKey` is `webhook:<id>`). */
  webhookOccurrenceId?: string
}

/**
 * A job's webhook trigger. The signing secret lives in the profile secret store under `secretRef`
 * and is shown once, when the trigger is enabled or rotated; it is never part of a job.
 */
export interface ScheduledJobWebhookTrigger {
  scheme: 'mousse'
  secretRef: string
  createdAt: string
  rotatedAt?: string
}

/** A verified delivery waiting for the scheduler to start it; its payload is stored under the job's trigger folder. */
export interface ScheduledJobPendingTrigger {
  occurrenceId: string
  receivedAt: string
}

/**
 * How a webhook request ended. The first six name the life of an accepted delivery; the rest are requests
 * that were answered without starting anything. `failed`: the run ended in an error or was interrupted;
 * `dispatch_failed`: the occurrence never got a run.
 */
export type ScheduledWebhookDeliveryOutcome =
  | 'accepted'
  | 'queued'
  | 'completed'
  | 'failed'
  | 'dispatch_failed'
  | 'uncertain'
  | 'running'
  | 'pending'
  | 'paused'
  | 'replay'
  | 'rejected_signature'
  | 'rate_limited'
  | 'too_large'

export interface ScheduledWebhookDelivery {
  occurrenceId?: string
  receivedAt: string
  outcome: ScheduledWebhookDeliveryOutcome
  error?: string
  missingPlaceholders?: string[]
  bodyBytes: number
}

/** How an occurrence ended; `uncertain` keeps the engine's "effects may have occurred" text in `error`. */
export interface ScheduledOccurrenceResult {
  /**
   * `waiting`: the turn hit a provider usage limit. It is not an error and does not spend a repeat; the job's
   * next run is `retryAt` (the reset), not a slot inside the window.
   */
  status: 'ok' | 'error' | 'interrupted' | 'uncertain' | 'waiting'
  /** With `waiting`: when the limit resets. */
  retryAt?: string
  text?: string
  error?: string
  silent?: boolean
}

/**
 * An occurrence that was admitted to the Run Engine and is not terminal yet. It holds the job's
 * single outstanding occurrence: later ticks skip the job until the run ends.
 */
export interface ScheduledJobPendingOccurrence {
  occurrenceKey: string
  threadId: string
  runId: string
  queueItemId?: string
  state: 'admitted' | 'queued' | 'running'
}

export interface ScheduledJob {
  id: string
  name: string
  prompt: string
  schedule: JobSchedule
  enabled: boolean
  state: ScheduledJobState
  nextRunAt: string | null
  lastRunAt?: string
  lastStatus?: 'ok' | 'error' | 'interrupted' | 'waiting' | 'uncertain'
  lastError?: string
  pausedAt?: string
  pausedReason?: string
  threadId?: string
  projectId?: string
  createThread?: boolean
  /** Provider instance and model every run uses; absent = the thread's model (bound) or the profile default. */
  selection?: ModelOverride
  mode?: 'agent' | 'plan'
  workspace?: ScheduledJobWorkspace
  /** How much the job's runs may do without asking; never wider than `permissionCeiling`. Absent = the thread's mode. */
  permissionMode?: PermissionMode
  /**
   * The widest mode a run of this job may have: the mode its creator (or last editor) held. The daemon
   * sets it; no protocol request can. A run is the stricter of this, `permissionMode` and the thread's mode.
   */
  permissionCeiling?: PermissionMode
  /**
   * The thread and run of the agent that created the job; absent for jobs people create. `requestId` is the
   * creating call's key, so a retried call finds the job it already made.
   */
  createdBy?: { threadId: string; runId?: string; requestId?: string }
  /**
   * The most agent access (SPEC §15.1) a run of this job may be granted: the level of whoever created it. Absent
   * (a creator whose level is not known) reads as `lineage`; a run is never granted more than the profile's setting either.
   */
  accessCap?: import('./settings').AgentAccessLevel
  /** When the job ends: set on jobs agents create (7 days); only a person extends it. Absent: no end. */
  expiresAt?: string
  repeat?: ScheduledJobRepeat
  runHistory?: ScheduledJobRunRecord[]
  /** Present while state === 'running'; cleared on terminal transition. */
  runClaim?: ScheduledJobRunClaim
  /** Present while an admitted occurrence has not reached a terminal run. */
  pendingOccurrence?: ScheduledJobPendingOccurrence
  /** The current occurrence's run is working, or waits for the person's answer; derived when listed, never stored. */
  liveStatus?: 'running' | 'needs_answer'
  /** The thread the current occurrence runs on, with `liveStatus`; derived when listed, never stored. */
  liveThreadId?: string
  /** A signed request starts this job; absent when the job has no webhook. */
  trigger?: { webhook: ScheduledJobWebhookTrigger }
  /** A verified delivery that the next tick starts (one at a time). */
  pendingTrigger?: ScheduledJobPendingTrigger
  createdAt: string
  updatedAt: string
}

/** Profile settings of the scheduler that people choose on the Scheduled page. */
export interface ScheduledSettings {
  /** Agents may list, create, change, pause and run jobs through the Mousse tools. Off by default. */
  agentJobs: boolean
  /** Active jobs agents may have in the profile at once (1 to 100; 10 unless a person changes it). */
  agentJobMaxActive: number
  /** The fewest minutes between runs of a job an agent creates or changes (1 to 1440; 15 unless changed). */
  agentJobMinIntervalMinutes: number
  /** Days a job an agent creates lasts unless a person extends it (1 to 365; 7 unless changed). */
  agentJobLifetimeDays: number
}

/** A change to the scheduler's settings: only the named ones change. */
export type ScheduledSettingsUpdate = Partial<ScheduledSettings>

export interface SchedulerStatus {
  running: boolean
  lastHeartbeatAt: string | null
  lastSuccessAt: string | null
  lastTickError: string | null
  /** The first of `activeJobIds`. */
  activeJobId: string | null
  activeJobIds: string[]
  jobCount: number
  dueCount: number
}

export interface CreateScheduledJobInput {
  name: string
  prompt: string
  schedule: JobSchedule
  threadId?: string
  projectId?: string
  createThread?: boolean
  selection?: ModelOverride
  mode?: 'agent' | 'plan'
  workspace?: ScheduledJobWorkspace
  permissionMode?: PermissionMode
  /** Daemon-only: the protocol refuses it, and the daemon sets it from the creator's mode. */
  permissionCeiling?: PermissionMode
  createdBy?: ScheduledJob['createdBy']
  accessCap?: import('./settings').AgentAccessLevel
  /** Daemon-only, like `accessCap`: the protocol refuses it. */
  expiresAt?: string
  repeat?: { times?: number }
}

/** The edits the Scheduled page sends; `null` clears a field so the job goes back to its default. */
export interface ScheduledJobPatch {
  name?: string
  prompt?: string
  schedule?: JobSchedule
  threadId?: string | null
  projectId?: string | null
  createThread?: boolean
  selection?: ModelOverride | null
  mode?: 'agent' | 'plan' | null
  /** `null` clears it: the run follows its thread's mode again. The job's ceiling is not part of a patch. */
  permissionMode?: PermissionMode | null
  workspace?: ScheduledJobWorkspace | null
}

/**
 * What enabling or rotating a webhook answers. `secret` is in this answer and no other: the page shows it once
 * and drops it. Enabling a webhook that already exists issues no secret.
 */
export interface ScheduledWebhookGrant {
  job: ScheduledJob
  secret?: string
  url: string
  listening?: boolean
  error?: string
  warning?: string
}

export interface ScheduledWebhookDeliveryLog {
  deliveries: ScheduledWebhookDelivery[]
  url: string
}

export interface ThreadSearchResult {
  threadId: string
  threadName: string
  projectId?: string
  projectName?: string
  matchType: 'thread' | 'project' | 'message'
  snippet?: string
  messageId?: string
  /** On a result from another of the user's computers: the computer that runs the thread. */
  node?: string
}

/** A computer that a search did not cover, and why. */
export interface ThreadSearchSkipped {
  node: string
  name: string
  reason: 'offline' | 'slow' | 'unavailable'
}

/** What a search finds: the matches of this computer and of the others that answered, and who did not. */
export interface ThreadSearchResponse {
  results: ThreadSearchResult[]
  /** Computers that were not searched; absent when every computer answered. */
  skipped?: ThreadSearchSkipped[]
}

export const SILENT_MARKER = '[SILENT]'

export type ChannelPlatform = 'telegram' | 'discord' | 'webhook'

export type ChannelConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error'

export type ChannelChatType = 'dm' | 'group' | 'channel' | 'thread'

export interface ChannelPlatformConfig {
  enabled: boolean
  token?: string
  allowedUserIds?: string[]
  allowAllUsers?: boolean
  homeChatId?: string
  webhookPort?: number
  webhookSecret?: string
}

/**
 * The account confirmed as a platform's owner (Settings → Channels → "This is me"). Personal bots
 * answer only this account, in a direct message. Never inferred from allowed users or pairing.
 * Stored in `channels/owners.json`, outside the channel config, so older builds never see it.
 */
export interface ChannelOwner {
  userId: string
  displayName: string
  confirmedAt: string
}

/** A "This is me" code in progress: when it expires, whether its one attempt was used, and who sent it. */
export interface ChannelOwnerClaim {
  expiresAt: string
  /** Accounts that sent a wrong code (each has one attempt). */
  failedAttempts: number
  claimant?: { userId: string; displayName: string }
}

export interface ChannelConfig {
  platforms: Record<ChannelPlatform, ChannelPlatformConfig>
  filterSilenceNarration: boolean
  unauthorizedDmBehavior: 'pair' | 'ignore'
}

export interface ChannelSession {
  sessionKey: string
  platform: ChannelPlatform
  chatId: string
  threadId?: string
  chatName?: string
  userId?: string
  userName?: string
  chatType: ChannelChatType
  mousseThreadId: string
  lastMessageAt?: string
  createdAt: string
  /** Session model; `instanceId` is absent on sessions saved before provider instances existed. */
  modelOverride?: ModelOverride
  /** The personal bot this DM talks to (`/bot <name>`); its messages activate the bot instead of a chat turn. */
  botId?: string
}

export interface ChannelDirectoryEntry {
  id: string
  name: string
  type?: string
  guild?: string
  threadId?: string
}

export interface ChannelStatus {
  platform: ChannelPlatform
  state: ChannelConnectionState
  error?: string
  connectedAt?: string
}

export interface ChannelsSnapshot {
  config: ChannelConfig
  sessions: ChannelSession[]
  statuses: ChannelStatus[]
  directoryUpdatedAt?: string
  /** Each platform's confirmed owner ("This is me"); absent from older daemons. */
  owners?: Partial<Record<ChannelPlatform, ChannelOwner>>
}

export interface PairingRequest {
  code: string
  platform: ChannelPlatform
  userId: string
  userName?: string
  createdAt: string
  expiresAt: string
}

export interface ChannelActivityEvent {
  id: string
  direction: 'inbound' | 'outbound'
  platform: ChannelPlatform
  sessionKey: string
  text: string
  timestamp: string
}

export type BuiltInChatMode = string

export interface SkillChatMode {
  type: 'skill'
  skillId: string
}

export type ChatMode = BuiltInChatMode | SkillChatMode

export const DEFAULT_CHAT_MODE: BuiltInChatMode = 'agent'

/** Image payload for multimodal chat (base64 without data: prefix). */
export interface ChatImageAttachment {
  name: string
  mimeType: string
  data: string
}

export interface OrchestratorSendRequest {
  content: string
  mode?: ChatMode
  images?: ChatImageAttachment[]
  /** Caller-owned logical send identity, retained after an uncertain response. */
  requestId?: string
  /** MMS-only receipt reference. Public ingress never accepts this field. */
  workflowInvocationId?: string
}

export type OrchestratorSendInput = string | OrchestratorSendRequest

export interface OrchestratorContextUsageRequest {
  draftInput?: string
  mode?: ChatMode
}

export type OrchestratorContextUsageInput = string | OrchestratorContextUsageRequest

export interface UserQuestionOption {
  id: string
  label: string
  /** An approval request's option: the decision it means, whatever id the provider gave it. */
  decision?: 'allow' | 'reject'
  scope?: 'once' | 'always'
}

export interface UserQuestion {
  id: string
  prompt: string
  options: UserQuestionOption[]
  allowMultiple?: boolean
}

/**
 * What a saved approval request adds to its card: why the provider asks, whether answering still
 * reaches a waiting provider (`live`) or continues the thread after a restart (`continue`), and how
 * far through the requests one dead run left the user is.
 */
export interface PendingApprovalInfo {
  reason?: string
  answerPath: 'live' | 'continue'
  /** The run the request belonged to was cut off while a tool may have run: `uncertainTools`. */
  uncertain?: boolean
  uncertainTools?: string[]
  /** `continue` requests of one run: how many are answered of how many the run left. */
  answered?: number
  total?: number
}

/** One "Always for this thread" rule, as a client lists it (SPEC §17.8): the exact request it answers, and whether it applies now. */
export interface ApprovalRuleInfo {
  /** Names the rule when it is revoked. */
  id: string
  permissionKey: string
  action: 'command' | 'edit' | 'tool'
  /** A bounded preview of what was allowed, without credentials. */
  summary: string
  /** The permission mode the user was asked under; the rule is ignored while the thread's mode is stricter. */
  grantedUnder: PermissionMode
  /** False while the thread's mode is stricter than the one the rule was granted under. */
  active: boolean
  createdAt: string
}

export interface PendingUserQuestions {
  requestId: string
  questions: UserQuestion[]
  /** Thread that owns this blocking plan-tool request. */
  threadId?: string
  /** Present on a provider's, the Pi agent's or a Mousse tool's saved approval request. */
  approval?: PendingApprovalInfo
}

export type UserQuestionAnswers = Record<string, string | string[]>

/**
 * The daemon's answer to `orchestrator.answerQuestions`. A saved approval request that someone else
 * answered first (or that was closed meanwhile) comes back with who decided what, so a client can say so.
 */
export interface QuestionAnswerOutcome {
  ok: boolean
  reason?: 'already_answered' | 'cancelled'
  decision?: 'allow' | 'reject'
  answeredBy?: { kind: 'user'; via?: string } | { kind: 'agent'; threadId: string; runId: string; toolCallId?: string }
  cancelReason?: string
}

export interface DocumentOpenPayload {
  title: string
  markdown: string
}

export interface DocumentTab {
  id: string
  title: string
  markdown: string
}

export type CliType = 'mousse' | 'claude-code' | 'codex' | 'opencode' | 'cursor-agents-cli'

export type AgentStatus =
  | 'starting'
  | 'running'
  | 'ready'
  | 'merging'
  | 'conflict'
  | 'completed'
  | 'failed'
  /** User/orchestrator stopped the agent without merging. Worktree/branch retained. */
  | 'cancelled'
  /** Session/process was lost (e.g. app restart) while the agent was still active. */
  | 'interrupted'

export type AgentExecutionMode = 'interactive' | 'headless' | 'gui'

export type TaskStatus =
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'failed'
  /** Linked agent was stopped without merge. */
  | 'cancelled'
  /** Linked agent session was lost before a clean completion. */
  | 'interrupted'

/** All known agent statuses. Used for load-time normalization. */
export const AGENT_STATUSES: readonly AgentStatus[] = [
  'starting',
  'running',
  'ready',
  'merging',
  'conflict',
  'completed',
  'failed',
  'cancelled',
  'interrupted'
] as const

/** All known task statuses. Used for load-time normalization. */
export const TASK_STATUSES: readonly TaskStatus[] = [
  'pending',
  'in_progress',
  'completed',
  'failed',
  'cancelled',
  'interrupted'
] as const

const AGENT_STATUS_SET = new Set<string>(AGENT_STATUSES)
const TASK_STATUS_SET = new Set<string>(TASK_STATUSES)

/**
 * Normalize a persisted agent status. Known values (including legacy completed/failed/running)
 * pass through unchanged. Unknown values become 'failed' so stale records never look active.
 */
export function normalizeAgentStatus(status: unknown): AgentStatus {
  if (typeof status === 'string' && AGENT_STATUS_SET.has(status)) {
    return status as AgentStatus
  }
  return 'failed'
}

/**
 * Normalize a persisted task status. Known values pass through; unknown values become 'failed'.
 */
export function normalizeTaskStatus(status: unknown): TaskStatus {
  if (typeof status === 'string' && TASK_STATUS_SET.has(status)) {
    return status as TaskStatus
  }
  return 'failed'
}

/** Agent has finished (successfully or not) and is no longer an active worker. */
export function isTerminalAgentStatus(status: AgentStatus): boolean {
  return (
    status === 'completed' ||
    status === 'failed' ||
    status === 'cancelled' ||
    status === 'interrupted'
  )
}

/** Agent is still in the active lifecycle (including ready-for-merge / conflict). */
export function isActiveAgentStatus(status: AgentStatus): boolean {
  return !isTerminalAgentStatus(status)
}

/** Task is no longer in progress. */
export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return (
    status === 'completed' ||
    status === 'failed' ||
    status === 'cancelled' ||
    status === 'interrupted'
  )
}

/**
 * Statuses that mean a delegation-batch member has settled and the parent may wake.
 * ready = success awaiting merge; failed/cancelled/interrupted = will not contribute a merge.
 */
export function isDelegationSettledStatus(status: AgentStatus): boolean {
  return (
    status === 'ready' ||
    status === 'failed' ||
    status === 'cancelled' ||
    status === 'interrupted'
  )
}

export interface Agent {
  episodeId?: string
  workspacePolicy?: import('./agentEpisodes').AgentWorkspacePolicy
  id: string
  cliType: CliType
  worktreePath: string
  branch: string
  repositoryRoot?: string
  /** Worker-declared edit surface captured before sparse allocation. */
  declaredFiles?: string[]
  /** Files materialized after dependency/dependent blast-radius expansion. */
  includedFiles?: string[]
  executionMode: AgentExecutionMode
  ptyId?: string
  processId?: string
  exitCode?: number | null
  exitSignal?: string | null
  exitedAt?: string
  /** When this agent last left starting or running. Cleared if work resumes. */
  idleAt?: string
  status: AgentStatus
  /** More precise startup stage while status is `starting`. */
  startupPhase?: 'discovery' | 'worktree' | 'launching'
  task: string
  /** Commit and paths validated when the worker declared itself ready. */
  readyCommit?: string
  readyDiffFiles?: string[]
  createdAt: string
}

export interface Task {
  id: string
  agentId?: string
  description: string
  status: TaskStatus
  /** Agent-reported completion percentage, clamped to 0..100. */
  progress?: number
  /** Latest short progress or failure message reported by the agent. */
  progressMessage?: string
  /** Final implementation summary reported by the agent. */
  summary?: string
  createdAt: string
}

export interface PlanCardMetadata {
  originalRequest: string
  planMarkdown: string
}

/** Full transcript delivery; restoration snapshots replace retired presentation rows. */
export interface ThreadMessagesSnapshot {
  threadId: string
  messages: ChatMessage[]
  replace?: boolean
}

export interface ChatMessage {
  /** Durable completed-response applets; generated code never executes in the shell. */
  presentationParts?: import('./applets').AppletPresentationPart[]
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: string
  /** Durable turn/action lineage. */
  turnId?: string
  actionId?: string
  conversationBranchId?: string
  /** Inline images for user messages (shown as previews; also sent to vision models). */
  images?: ChatImageAttachment[]
  /**
   * Provenance for a user message accepted from a durable queue claim.
   * Used on startup recovery so an accepted claim is never re-executed as a duplicate turn.
   */
  queueItemId?: string
  error?: import('./errors').AppErrorShape
  workflowRun?: import('./workflowChat').WorkflowChatRun
  workflowInvocationId?: string
  /**
   * Set on a message that delivered subagent results to this thread (a wake turn, a steer, a queued
   * steer): the tasks it reports, so the app never parses the text.
   */
  subagentNotice?: import('./subagents').SubagentNoticeItem[]
  /** Set on a user message a scheduled job sent, so the thread can show "Scheduled: <name>" instead of passing it off as typed. */
  scheduled?: { jobId: string; jobName?: string }
  /** Set on a user message another thread's agent sent (`thread_send`), so the thread can say whose it is. */
  origin?: AgentOrigin
  /**
   * Set on a scheduled job's result appended to its thread when it ran on another thread (a
   * workflow's): that thread and run, which the transcript links to.
   */
  scheduledRun?: { jobId: string; threadId: string; runId?: string }
  /**
   * A user message added to a turn that was already running (a steer), so it does not start a turn.
   * Older transcripts do not carry it.
   */
  steered?: boolean
  /** Durable model-context input that is intentionally omitted from the user-facing transcript. */
  hidden?: boolean
  /** Original presentation visibility while a conversation-undo is active. */
  hiddenBeforeUndo?: boolean
  /**
   * Chat mode active when this user turn was sent. Stored on visible user
   * messages (and silent mode-change notices) so a mid-chat mode switch can
   * be detected on later turns — including after a restart — without schema
   * migration. Legacy messages omit this and are treated as `agent`.
   */
  mode?: ChatMode
  /**
   * Permission mode the turn ran in (the effective one) when this user turn was sent. Stored on
   * visible user messages and silent permission-change notices so a mid-thread change is detected
   * on later turns, including after a restart. Legacy messages omit this and read as the default.
   */
  permissionMode?: PermissionMode
  kind?:
    | 'message'
    | 'plan_card'
    | 'thinking'
    | 'tool_call'
    | 'mcp_tool_call'
    | 'mcp_tool_result'
    | 'skill_loaded'
    | 'build_tool_call'
    | 'build_tool_result'
    /** Presentation-only progress note (not part of Pi-native context). */
    | 'progress'
    /** Presentation-only warning (e.g. budget); never injected into Pi-native context. */
    | 'warning'
    /** Presentation-only marker emitted when retained model context is compacted. */
    | 'context_compaction'
    /** Presentation-only model transition; never injected into provider context. */
    | 'context_handoff'
  /** Selection actually admitted for this user turn, independent of composer edits. */
  modelSelection?: { provider: string; model: string }
  contextHandoff?: {
    from: { provider: string; model: string }
    to: { provider: string; model: string }
    /** Run Engine handoff artifact (SPEC §16.1) the turn delivered; absent for a display-only switch. */
    handoffId?: string
    strategy?: 'native_resume' | 'delta' | 'full_summary' | 'fork_delta_summary' | 'legacy_import'
    /** "context rebuilt (N of M items)": N = selected, M = selected + omitted. */
    selectedItems?: number
    omittedItems?: number
    /** Set when the handoff came from a thread transfer (SPEC §16.2). */
    transfer?: 'fork' | 'merge_back'
  }
  planCard?: PlanCardMetadata
  thinking?: {
    content: string
    status?: 'processing' | 'complete'
  }
  toolCall?: {
    title: string
    summary: string
    details: string[]
    response?: string
    status?: 'processing' | 'complete'
    /** Structured provider tool identity (e.g. "read", "Bash", "TodoWrite"). */
    toolName?: string
    /** Structured provider tool input (parsed args JSON on start, preserved on complete). */
    input?: Record<string, unknown>
  }
  /**
   * What the agent did, typed. Present on rows saved after typed activity landed; the renderer
   * prefers it to `toolCall`, which stays filled (without large fields) for older readers. Rows
   * without it render from `toolCall` as before.
   */
  activity?: AgentActivityItem
  /** Details captured from the LLM call that produced this assistant response. */
  responseMetadata?: {
    modelName?: string
    totalResponseTimeMs?: number
    tokensUsed?: number
    /** Provider-reported output token rate measured while consuming LLM streams. */
    tokensPerSecond?: number
  }
  /** A stopped stream retained as partial text; it has no response actions or metadata. */
  incomplete?: boolean
  streaming?: boolean
}

export function isToolTimelineMessage(message: Pick<ChatMessage, 'kind'>): boolean {
  return (
    message.kind === 'thinking' ||
    message.kind === 'tool_call' ||
    message.kind === 'mcp_tool_call' ||
    message.kind === 'mcp_tool_result' ||
    message.kind === 'skill_loaded' ||
    message.kind === 'build_tool_call' ||
    message.kind === 'build_tool_result'
  )
}

export interface SubagentAssignment {
  cliType: CliType
  task: string
  /** Mousse subagent LLM provider override. Must be supplied with model. */
  provider?: string
  /** Mousse subagent model override. Must be supplied with provider. */
  model?: string
  /** Mousse subagent reasoning effort override (for example: low, medium, high). */
  effort?: string
}

export interface CompleteTaskAction {
  type: 'complete_task'
  /** Explicit targets prevent completion from affecting unrelated active agents. */
  agentIds: string[]
  merge?: boolean
}

export interface MessageAction {
  type: 'message'
  content: string
}

export type OrchestratorAction =
  | CompleteTaskAction
  | MessageAction

export interface OrchestratorResponse {
  /** False when the bridge did not receive a daemon acknowledgement; retain retry identity. */
  requestAcknowledged?: boolean
  error?: import('./errors').AppErrorShape
  message: string
  actions: OrchestratorAction[]
  /**
   * When true, the send was accepted onto the thread queue instead of starting a turn.
   * `queueItem` identifies the durable pending message.
   */
  queued?: boolean
  queueItem?: QueuedMessage
  workflowRun?: import('./workflowChat').WorkflowChatRun
  /** Run Engine run created for this send (docs/run-engine/SPEC.md §6). */
  runId?: string
  /** Thread event sequence after the send was recorded. */
  sequence?: number
  /** True when the send repeated an earlier `clientRequestId`; nothing new was started. */
  replayed?: boolean
  /**
   * True for an `await: 'ack'` send: the run and its turn.start are committed and the turn's
   * result arrives through run events (SPEC §12.7).
   */
  accepted?: boolean
}

/** Intent of a durable thread message queue entry. */
export type QueuedMessageIntent = 'normal' | 'steer'

/**
 * Lifecycle state of a durable thread message queue entry.
 * `claimed` means an owner has atomically reserved the item for execution without removing it.
 */
export type QueuedMessageState = 'pending' | 'steering' | 'claimed' | 'drained' | 'removed'

/**
 * Minimal durable claim metadata for a normal queue item reserved by an execution owner.
 * Sufficient to identify the owner and claim time; not a broad workflow state machine.
 */
export interface QueuedMessageClaim {
  ownerPid: number
  ownerToken: string
  /** ISO-8601 claim timestamp. */
  claimedAt: string
  /** Optional owner surface tag (gui | cli | channel | orchestrator | …). */
  source?: string
}

/**
 * Durable queued thread input owned by MMS for a single thread.
 * User messages and hidden internal orchestration wakes share FIFO ordering; steer items
 * inject into the active turn and are not replayed as later turns.
 * Claimed normal items stay at their original order until acknowledged or released.
 */
export interface QueuedMessage {
  id: string
  threadId: string
  content: string
  workflowInvocationId?: string
  mode?: ChatMode
  images?: ChatImageAttachment[]
  /** ISO-8601 enqueue timestamp. */
  enqueuedAt: string
  /** Stable FIFO order within the thread (lower first). */
  order: number
  intent: QueuedMessageIntent
  state: QueuedMessageState
  /** Present when state is `claimed`. */
  claim?: QueuedMessageClaim
  /** Optional caller tag (gui | cli | channel | …). */
  source?: string
  /** Internal orchestration input: durable and executable, but hidden from queue/transcript UI. */
  internal?: boolean
  /** Run Engine run this item executes when drained. */
  runId?: string
  /** The paused run a resume item continues (`resume:<runId>`); its drain sends the continue turn for it. */
  continuationOfRunId?: string
  /** Inbox rows whose notice this item delivers (a steer that missed its turn); rebuilt when it runs. */
  inboxIds?: string[]
  /** The subagent results the item's message reports. */
  subagentNotice?: import('./subagents').SubagentNoticeItem[]
  /**
   * The thread's stop generation when the item was queued, for work that starts on behalf of a parent
   * (a steer that missed its turn). Once a Stop raised the generation the item is refused when it would
   * run. Absent for what a person queued, which a Stop never fences.
   */
  stopGeneration?: number
  /** A mode this turn must not exceed, set by a daemon-side sender (a scheduled job); it only tightens. */
  permissionMode?: PermissionMode
  /** The other computer of the user this message was sent or last edited from (a routed call); absent for this computer's own. */
  sentFrom?: ThreadSentFrom
  /**
   * The run a promoted item (`steering`) was promoted into. Only that run's steer drain takes the text, and
   * only when the run's mode is no stricter than the item's own; any other run that meets the item reverts it
   * to a pending message, so a promotion never reaches a run it was not checked against.
   */
  steerRunId?: string
  /**
   * Who the item is from when it is not a person. `schedule`: set on the occurrence of a scheduled job
   * that found its thread busy; the run drains with the job's model and origin, and the ids travel on to
   * the turn so its end completes the occurrence. `agent`: a message another thread's agent sent; it
   * drains as that agent's message, so the turn's transcript row keeps saying so.
   */
  origin?: { kind: 'schedule'; jobId: string; occurrenceKey: string; jobName?: string; selection?: ModelOverride } | AgentOrigin
}

/**
 * The agent a message came from (SPEC §15.1): the thread and run that sent it. Stored on the user
 * message the target thread shows, so a message an agent wrote never passes for one a person typed.
 */
export interface AgentOrigin {
  kind: 'agent'
  threadId: string
  runId: string
  /**
   * How many agent messages in a row led to this one without a person in between (the sender's own count
   * plus one). A message that would pass the limit is refused, so a chain of agents cannot run unwatched.
   */
  hops?: number
}

export interface ContextUsageCategory {
  label: string
  color: string
  tokens: number
}

export interface ContextUsageSnapshot {
  modelLimit?: number
  processedTokens?: number
  percent: number
  used: number
  limit: number
  modelName: string | null
  source: 'measured' | 'estimated' | 'legacy-estimated'
  categories: ContextUsageCategory[]
}

export interface PtyCreateRequest {
  agentId: string
  cwd: string
  command?: string
  env?: Record<string, string>
  shellArgs?: string[]
}

export interface PtyCreateResult {
  ptyId: string
}

export interface Project {
  id: string
  name: string
  path: string
  createdAt: string
  /** Explicit sidebar position; maintained independently of activity timestamps. */
  order: number
  pinnedAt?: string
  /** Set on a project of another of the user's computers: the computer that holds it. Absent on this computer's own. */
  node?: string
  /** On a project of another computer: the project of this computer with the same Git history, when there is one. */
  sameAs?: string
  /** Set while the computer that holds the project cannot be reached; the row is what it last said. */
  offline?: true
}

/**
 * Where a subagent thread came from. Written when the child is created and backfilled for older
 * children from the run store's `thread_lineage`; the run store stays the source of truth.
 */
export interface ThreadLineage {
  parentThreadId: string
  /** The thread at the top of the parent chain, the one a person started. */
  rootThreadId: string
  relationship: 'subagent'
}

/**
 * The workspace a subagent was created on. Later turns use it as written instead of working it out
 * again from the parent's current session.
 */
export interface SubagentWorkspaceBinding {
  /** `primary`: a scheduled run on the project's own checkout, never a provisioned worktree. */
  policy: 'shared' | 'isolated' | 'primary'
  /** The parent's workspace path a `shared` child observes read-only. */
  sharedPath?: string
}

/**
 * The device that started a thread on this one through Bridge (its Net node id), and the id of the
 * project it was started from on that device, which only that device can read.
 */
export interface ThreadStartedFrom {
  node: string
  projectId?: string
}

/** The computer a thread's latest routed message came from. */
export interface ThreadSentFrom {
  node: string
}

export interface Thread {
  id: string
  name: string
  projectId?: string
  createdAt: string
  updatedAt: string
  /** Set on a subagent thread: the thread that started it. Absent on every other thread. */
  lineage?: ThreadLineage
  /**
   * Set on a thread an agent launched with `thread_create`: the creating thread. Unlike `lineage` it
   * is not a subagent relation; it only lets the creator read and stop the thread at any agent access level.
   */
  createdByThreadId?: string
  /** Set on a thread another of the user's devices created through Bridge. */
  startedFrom?: ThreadStartedFrom
  /**
   * Set on a row of the merged lists that is a thread of another of the user's computers: the computer
   * that runs it (its Net node id). The id of such a row is `<node>:<id on that computer>`. Absent on
   * this computer's own threads.
   */
  node?: string
  /** Set while the computer that runs the thread cannot be reached; the row is what it last said. */
  offline?: true
  /** The other computer of the user a message in this thread was last sent from; absent when every message came from this one. */
  sentFrom?: ThreadSentFrom
  /**
   * The most an agent running in this thread may reach beyond its own thread and lineage (agent access
   * level, SPEC §15.1), fixed for the thread's life. Set on a fork from its source and the forking agent,
   * and on a thread a remote person drives (a channel); it only ever narrows. Absent: no limit of its own
   * (the profile's setting and the thread's delegations still apply).
   */
  accessCeiling?: import('./settings').AgentAccessLevel
  /** Set on a subagent created after workspace bindings were recorded, and on a scheduled per-run thread. */
  workspaceBinding?: SubagentWorkspaceBinding
  /** Set on the per-run thread a scheduled job created; counts the job's open per-run threads. */
  scheduledJobId?: string
  /**
   * Explicit model selection for this thread; absent means use global settings. `instanceId` is
   * absent on threads saved before provider instances existed.
   */
  modelOverride?: ModelOverride
  /** How much the agent may do without asking; absent means the profile default. */
  permissionMode?: PermissionMode
  /**
   * Opt-in isolated git worktree for this thread. OFF by default (undefined/false
   * means run on the primary checkout). Toggleable from the new-chat input bar
   * before the first message; locked once a workspace is provisioned or the
   * thread has started.
   */
  worktreeEnabled?: boolean
  /** The pull request this thread created, started from, or watches; set by the daemon, never inferred from a branch name. */
  pullRequest?: ThreadPullRequestLink
  /** Explicit sidebar position within this thread's project (or standalone group). */
  order: number
  pinnedAt?: string
  /** Set while the thread is archived and unavailable for selection. */
  settledAt?: string
  /**
   * Set once the user commits the first message (send/enqueue), so the thread
   * stays in the sidebar even before title generation finishes.
   * Unstarted threads are empty drafts and stay out of the sidebar.
   */
  startedAt?: string
}

/**
 * Sidebar status of a thread. `processing` is Working. `waiting` is Waiting: the turn is blocked
 * only on wait tools, or it ended while thread-owned work that reports back is still running.
 * `awaiting_input` is Input: the agent asked the user something. `paused` is a run stopped by a
 * provider usage limit that continues when the limit resets: not working, and not finished.
 */
export type ThreadActivityState = 'idle' | 'processing' | 'waiting' | 'awaiting_input' | 'completed' | 'paused'

/** Working or Waiting: the thread's work cycle has not finished yet. */
export function isThreadActivityActive(state: ThreadActivityState | undefined): boolean {
  return state === 'processing' || state === 'waiting'
}

export type ThreadActivitySnapshot = Record<string, ThreadActivityState>

export type TurnPhase =
  | 'idle' | 'queued' | 'thinking' | 'streaming'
  | 'tool_running' | 'awaiting_input' | 'finalizing'
  | 'completed' | 'stopped' | 'failed'
  /** The run hit a provider usage limit and waits for it to reset (`TurnState.pause`). Not an active turn. */
  | 'paused'

/** What a client shows of a run paused by a usage limit (the daemon's `RunPause`, with the run's id). */
export interface TurnPause {
  runId: string
  /** ISO-8601 time the limit resets: the provider's, or an estimate when `estimated`. */
  until: string
  estimated: boolean
  provider?: string
  /** The window that was hit, as the provider names it (`five_hour`, `seven_day`, …). */
  limitKind?: string
  /** Whether the run continues by itself at `until`; false means Resume now is the way on. */
  autoResume: boolean
  /** The reset passed while Mousse was off for more than a day: the timer was dropped and only Resume now (or a message) continues the run. */
  stale?: true
}

export interface TurnState {
  threadId: string
  turnId: string | null
  phase: TurnPhase
  activeMessageId?: string
  startedAt?: string
  updatedAt: string
  error?: string
  errorDescriptor?: import('./errors').AppErrorShape
  /** Set only while `phase` is `paused`. */
  pause?: TurnPause
}
export type TurnStateSnapshot = Record<string, TurnState>

export function isTurnActivePhase(phase: TurnPhase): boolean {
  return phase === 'queued' || phase === 'thinking' || phase === 'streaming' || phase === 'tool_running' || phase === 'finalizing'
}

/** Thread activity for a turn phase; `blockedOnWait` marks a tool phase whose calls only wait. */
export function turnPhaseActivity(phase: TurnPhase, blockedOnWait = false): ThreadActivityState {
  if (phase === 'awaiting_input') return 'awaiting_input'
  if (phase === 'paused') return 'paused'
  if (isTurnActivePhase(phase)) return phase === 'tool_running' && blockedOnWait ? 'waiting' : 'processing'
  // Keep a finished turn completed until its runtime activity changes.
  if (phase === 'completed') return 'completed'
  return 'idle'
}

export interface ThreadData {
  messages: ChatMessage[]
  agents: Agent[]
  tasks: Task[]
  /** Canonical, serializable Pi transcript. UI messages are presentation-only. */
  llmContext?: NativeLlmContext
  /**
   * Durable in-app Mousse subagent conversations for this thread.
   * Omitted or empty on legacy threads; invalid entries are dropped on load.
   */
  mousseAgentSessions?: MousseAgentSessionSnapshot[]
  /**
   * Pending/claimed user messages for this thread (FIFO). Omitted on legacy threads.
   * Loaded from dedicated `queue.json` via the queue API. Callers must not rely on
   * `saveThreadData` to persist this field — use `saveMessageQueue` / `mutateDurableQueue`.
   */
  messageQueue?: QueuedMessage[]
}

/** Durable run lifecycle for a Mousse GUI subagent session. */
export type MousseAgentRunState =
  | 'idle'
  | 'running'
  | 'failed'
  | 'interrupted'
  | 'completed'

/** Provider/model selection captured when a Mousse subagent is launched. */
export interface MousseAgentAssignment {
  provider?: string
  model?: string
  effort?: string
}

/** Cumulative usage captured for a Mousse subagent session. */
export interface MousseAgentSessionUsage {
  totalTokens?: number
  totalResponseTimeMs?: number
  modelName?: string
  tokensPerSecond?: number
}

/**
 * Crash-safe snapshot of one in-app Mousse subagent conversation.
 * Presentation messages and Pi-native history are stored separately so UI cards
 * never pollute model context on resume.
 */
export interface MousseAgentSessionSnapshot {
  version: 1 | 2
  agentId: string
  worktreePath: string
  /** Managed episode authority; worktreePath remains the project cwd. */
  managedBinding?: { workspaceRoot: string; episodeId: string }
  /** Original delegated task text (for display / resume metadata). */
  task: string
  assignment: MousseAgentAssignment
  /** Presentation timeline shown in the subagent tab. */
  messages: ChatMessage[]
  /** Pi-native transcript used for LLM resume (assistant + tool results). */
  history?: import('./transcript').Message[]
  /** Version 2 preserves the archive and active compaction checkpoint. */
  nativeContext?: NativeLlmContext
  runState: MousseAgentRunState
  usage?: MousseAgentSessionUsage
  warnings?: string[]
  lastError?: string
  updatedAt: string
}

/**
 * Durable Pi-native conversation state. `messages` is the lossless archive; compaction
 * only changes which suffix is active. Legacy UI history cannot recover tool calls,
 * tool results, provider identities, signatures, or hidden reasoning that was never saved.
 */
/** Last completed-turn provider prompt measurement, persisted with the native transcript. */
export interface NativeLastTurnUsage {
  input: number
  cacheRead: number
  cacheWrite: number
  /** Context-input signature (system prompt + tool schemas) that produced this measurement. */
  signature: string
  /** Active-message length the measurement applied to (excludes the assistant reply it produced). */
  measuredAtHistoryLength: number
  /** Exact durable context revision sent for this measurement. */
  contextRevision?: number
  /** Resolved provider/model/API identity used for tokenization and capacity. */
  modelKey?: string
}

export interface NativeCompactionDirective {
  text: string
  timestamp?: number
  source: 'user' | 'user-steer' | 'host-notice'
  /** Present when only a bounded verbatim head/tail excerpt is provider-visible. */
  originalChars?: number
}

export interface NativeCompactionCheckpoint {
  generation: number
  /** Generated memory is data, never a user-authored message. */
  summary: string
  directives?: NativeCompactionDirective[]
  tokensBefore: number
  tokensAfter?: number
  coveredThroughIndex?: number
  createdAt: number
}

export interface NativeLlmContext {
  version: 1 | 2
  messages: import('./transcript').Message[]
  /** Events removed from the active lineage by explicit undo; retained for audit. */
  retiredMessages?: import('./transcript').Message[]
  fidelity: 'native' | 'legacy-estimated'
  activeStartIndex: number
  /** Incremented whenever provider-visible history or its checkpoint changes. */
  revision?: number
  /** Durable admission evidence for queued turns; must agree with the transcript. */
  acceptedQueueItemIds?: string[]
  /** Steer queue IDs whose content has been checkpointed into native history. */
  acceptedSteerItemIds?: string[]
  compaction?: NativeCompactionCheckpoint
  /** Actual model capacity reported by a native provider, retained across compaction. */
  nativeProviderModel?: {
    /** `llmProvider` of the runtime that reported this capacity. */
    provider: string
    selectedModel: string
    modelName: string
    contextWindow?: number
  }
  /** Restored on session load so context usage stays measured after persist/reload. */
  lastTurnUsage?: NativeLastTurnUsage
}

export interface FileEntry {
  name: string
  path: string
  kind: 'file' | 'directory'
}

export interface FileSearchResult {
  /** Root-relative, `/`-separated. */
  path: string
  kind: 'file' | 'directory'
  score: number
  /** Indexes into `path` of the matched characters. */
  positions: number[]
}

export interface FileSearchResponse {
  /** Absolute root the result paths are relative to (a thread worktree, not necessarily the project). */
  root: string
  /** `null` while the first index has produced nothing yet. */
  source: 'git' | 'walk' | null
  /** Why a Git repository was walked instead of listed by git; absent for `git` and when nothing was indexed. */
  fallbackReason?: 'not-a-repo' | 'git-missing' | 'git-too-old'
  results: FileSearchResult[]
  /** Paths (files and folders) in the index this answer came from. */
  indexed: number
  /** ISO time the index was built; `null` before any snapshot. */
  indexedAt: string | null
  /** The index hit its path cap. */
  truncated: boolean
  /** The index is still building; results come from what was collected so far. */
  indexing: boolean
  /** Neither the index nor the ranking was cut short. */
  complete: boolean
}

export interface FileGrepMatch {
  /** Root-relative, `/`-separated. */
  path: string
  /** 1-based. */
  line: number
  /** 1-based UTF-16 code unit offset of the match within the full line. */
  column: number
  /** UTF-16 length of the match; `null` for a regular-expression match, where only the start is known. */
  matchLength: number | null
  /** The line, cut to a window around the match when it is long. */
  text: string
  /** UTF-16 offset of `text` within the full line; the match starts at `column - 1 - snippetStart` in `text`. */
  snippetStart: number
}

export interface FileGrepResponse {
  /** Absolute root the match paths are relative to. */
  root: string
  /** `git` is `git grep`; `walk` is a fixed-string scan of the file index. */
  source: 'git' | 'walk'
  /** Why a Git repository was scanned instead of searched by git; absent for `git`. */
  fallbackReason?: 'not-a-repo' | 'git-missing' | 'git-too-old'
  matches: FileGrepMatch[]
  filesWithMatches: number
  /** The match limit, a per-file limit or the file index cap cut the results short. */
  truncated: boolean
  /** The time budget ran out; `matches` holds what was found so far. */
  timedOut: boolean
  /** The file index was still building, so the scan covered only part of the project. */
  indexing: boolean
  /** Matching lines too long to return. */
  skippedLongLines: number
  /** Set when a regular expression could not be used and the query was searched literally. */
  regexError?: string
  elapsedMs: number
}

export interface FileStat {
  path: string
  kind: 'file' | 'directory'
  size: number
  modifiedAt: string
}

export interface FileAsset {
  data: Uint8Array
  mimeType: string
  size: number
}

export type GitChangeStatus =
  | 'modified'
  | 'added'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'untracked'
  | 'ignored'
  | 'conflicted'

export interface GitFileChange {
  path: string
  status: GitChangeStatus
  staged: boolean
  originalPath?: string
}

/** A multi-step Git operation that stopped and waits for the user, for example on conflicts. */
export type GitInProgress = 'merge' | 'rebase' | 'cherry-pick' | 'revert'

export interface GitStatusSnapshot {
  upstream?: string | null
  tracking?: 'tracked' | 'none' | 'detached' | 'unborn'
  isRepo: boolean
  branch: string | null
  ahead: number
  behind: number
  /**
   * One entry per side: a path changed in both the index and the working tree
   * (for example staged, then edited again) appears twice, once with `staged: true`
   * and once with `staged: false`. Count files by path.
   */
  changes: GitFileChange[]
  /** A merge, rebase, cherry-pick or revert is stopped in this folder. */
  inProgress?: GitInProgress | null
  /** The repository has at least one remote to push to. */
  hasRemote?: boolean
  /** The folder itself does not exist, for example a removed worktree. */
  missing?: boolean
}

export interface GitCommit {
  hash: string
  shortHash: string
  message: string
  author: string
  date: string
  /** True when the commit is already on the remote tracking branch. */
  pushed: boolean
  /** True when any remote-tracking branch contains the commit, so rewriting it would need a force push. */
  onRemote: boolean
}

export interface GitBranchInfo {
  current: string | null
  branches: string[]
}

export interface GitDiffStats {
  additions: number
  deletions: number
  filesChanged: number
}

export interface GitCommitOptions {
  amend?: boolean
  /**
   * Commit every change, whatever the index holds: runs `git add -A` (leaving out `.mousse/`)
   * first. Thread worktrees use this because their checkpoints sweep the tree anyway; the result
   * is one commit unless a hook edits files without staging them, and the next checkpoint then
   * commits those edits.
   * Unset, the commit uses the index when anything is staged and stages everything otherwise.
   */
  all?: boolean
  /** Refuse with `git_branch_changed` when HEAD is on another branch by now. */
  expectedBranch?: string
  /** Names the action so its live output reaches the caller and Cancel can find it. */
  operationId?: string
}

/** A proposed commit message; the user edits it before committing. */
export interface GitCommitSuggestion {
  message: string
  /** Part of the change was left out of what the model saw (too large, binary, too many files). */
  truncated: boolean
}

export interface GitPushOptions {
  /** Refuse with `git_branch_changed` when HEAD is on another branch by now. */
  expectedBranch?: string
  /** Names the action so its live output reaches the caller and Cancel can find it. */
  operationId?: string
}

export interface GitCheckoutOptions {
  /** Names the action so its live output reaches the caller. A branch switch cannot be cancelled. */
  operationId?: string
  /** With uncommitted changes: `carry` them along (default) or `stash` them, switch and re-apply. */
  dirty?: 'carry' | 'stash'
}

export interface GitCheckoutResult {
  /** The changes were stashed and could not be re-applied cleanly, so the stash is kept. */
  stashKept?: boolean
}

/**
 * Which folder a Git mutation belongs to, as the daemon needs it. A thread working in its own
 * worktree names the thread (the daemon applies the thread rules there); any other folder names its project.
 */
export interface GitScope {
  projectId: string | null
  /** Set only when the folder is the thread's own ready worktree. */
  workspaceThreadId: string | null
}

/** What a daemon Git mutation answers: the folder's fresh status, plus the action's own result. */
export type GitMutationResult<T extends object = object> = { status: GitStatusSnapshot } & T

export type GitPullStrategy = 'ff-only' | 'merge' | 'rebase'

export interface GitPullOptions {
  strategy?: GitPullStrategy
  /** Names the action so its live output reaches the caller and Cancel can find it. */
  operationId?: string
}

export interface GitFetchOptions {
  /** Names the action so its live output reaches the caller and Cancel can find it. */
  operationId?: string
}

export interface GitPullResult {
  result: 'up-to-date' | 'fast-forwarded' | 'merged' | 'rebased' | 'conflicted'
}

export interface GitFetchResult {
  behindBefore: number
  behindAfter: number
}

export type GitOperationKind = 'push' | 'pull' | 'fetch' | 'commit' | 'checkout'

export type GitOperationPhase = 'started' | 'integrating' | 'hook' | 'output' | 'done' | 'failed' | 'cancelled'

/**
 * What a long Git action reports while it runs. Sent only to the client that started it,
 * and never replayed: the request's own answer carries the outcome.
 */
export interface GitOperationEvent {
  /** Chosen by the client that started the action. */
  operationId: string
  kind: GitOperationKind
  /** The folder Git runs in. */
  path: string
  phase: GitOperationPhase
  /** On `started` and `integrating`: whether Cancel can stop it. `integrating` (a pull's merge or rebase) says it no longer can. */
  cancellable?: boolean
  /** On `output`: the new lines, redacted and each at most 500 characters. */
  lines?: string[]
  /** On `hook`: a hook has started, or has ended with `exitCode`. */
  hook?: { name: string; exitCode?: number }
  /** On `failed`: Git's message, redacted. */
  message?: string
  /** On `failed`: the error code the request rejects with. */
  code?: string
  /** Milliseconds since the epoch. */
  at: number
}

/** Passed to a long GitService action to follow it and to stop it. */
export interface GitOperationOptions {
  /** Names the action for `cancelOperation` and in every event. */
  operationId?: string
  /** Only the client that started the action may cancel it. */
  owner?: string
  /** The action is cancelled when this aborts (the starting connection closed), while it still can be. */
  lifetime?: AbortSignal
  onEvent?: (event: GitOperationEvent) => void
}

export interface GitBranchOptions {
  /** Branch or commit to start from; the current HEAD when unset. */
  from?: string
  /** Switch to the new branch (default true). */
  checkout?: boolean
}

export interface GitDeleteBranchOptions {
  /** Delete even when the branch has commits no other branch has. */
  force?: boolean
}

export interface EditorInfo {
  /** Stable id, e.g. 'vscode', 'cursor', 'zed', 'files'. */
  id: string
  label: string
  kind: 'editor' | 'files'
  /** The app's own icon; omitted when unavailable. */
  iconDataUrl?: string
}

export interface BrowserBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface BrowserElementAttachment {
  id: string
  url: string
  tagName: string
  selector: string
  text: string
  ariaLabel?: string
  role?: string
  outerHTML?: string
}

export interface BrowserTabState {
  id: string
  /** null means the tab is pinned and visible from every chat thread. */
  ownerThreadId: string | null
  url: string
  title: string
  zoomFactor: number
  deviceToolbarOpen: boolean
  devicePreset: string
}

export interface BrowserState {
  url: string
  canGoBack: boolean
  canGoForward: boolean
  isLoading: boolean
}

export const PROJECT_SHELL_AGENT_ID = '__project-shell__'

export function isProjectShellAgentId(agentId: string): boolean {
  return agentId === PROJECT_SHELL_AGENT_ID || agentId.startsWith(`${PROJECT_SHELL_AGENT_ID}:`)
}

export interface ProjectTerminalTab {
  id: string
  /** null means the tab is pinned and visible from every chat thread. */
  ownerThreadId: string | null
  ptyId: string | null
  /** Working directory captured when this terminal session was created. */
  cwd?: string
  title: string
  exited: boolean
}
export type { PlatformRequestApi, PlatformRequestErrorShape, PlatformRequestMethod, PlatformResponse } from './platform'
