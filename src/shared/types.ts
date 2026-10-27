import type { AgentActivityItem } from './agentActivity'
import type { ModelOverride } from './providerInstances'
export type MainView = 'browser' | 'terminal' | 'files' | 'git' | 'review' | 'documents'

export type ScheduledJobState = 'scheduled' | 'running' | 'paused' | 'completed' | 'error'

export type ScheduleKind = 'once' | 'interval' | 'cron'

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

export interface ScheduledJobRunRecord {
  runAt: string
  status: 'ok' | 'error' | 'interrupted' | 'waiting'
  output?: string
  error?: string
  silent?: boolean
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
  lastStatus?: 'ok' | 'error' | 'interrupted' | 'waiting'
  lastError?: string
  pausedAt?: string
  pausedReason?: string
  threadId?: string
  projectId?: string
  createThread?: boolean
  repeat?: ScheduledJobRepeat
  runHistory?: ScheduledJobRunRecord[]
  /** Present while state === 'running'; cleared on terminal transition. */
  runClaim?: ScheduledJobRunClaim
  createdAt: string
  updatedAt: string
}

export interface SchedulerStatus {
  running: boolean
  lastHeartbeatAt: string | null
  lastSuccessAt: string | null
  lastTickError: string | null
  activeJobId: string | null
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
  repeat?: { times?: number }
}

export interface ThreadSearchResult {
  threadId: string
  threadName: string
  projectId?: string
  projectName?: string
  matchType: 'thread' | 'project' | 'message'
  snippet?: string
  messageId?: string
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
}

export interface UserQuestion {
  id: string
  prompt: string
  options: UserQuestionOption[]
  allowMultiple?: boolean
}

export interface PendingUserQuestions {
  requestId: string
  questions: UserQuestion[]
  /** Thread that owns this blocking plan-tool request. */
  threadId?: string
}

export type UserQuestionAnswers = Record<string, string | string[]>

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

export interface MacroStep {
  type: 'delay' | 'paste' | 'key' | 'type'
  ms?: number
  key?: string
  text?: string
  usePrompt?: boolean
}

export interface MacroHeadlessConfig {
  command: string
  args: string[]
  appendPrompt?: boolean
}

export interface MacroConfig {
  name: string
  cliType: CliType
  cliCommand: string
  steps: MacroStep[]
  headless?: MacroHeadlessConfig
}

export interface Project {
  id: string
  name: string
  path: string
  createdAt: string
  /** Explicit sidebar position; maintained independently of activity timestamps. */
  order: number
  pinnedAt?: string
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
  policy: 'shared' | 'isolated'
  /** The parent's workspace path a `shared` child observes read-only. */
  sharedPath?: string
}

export interface Thread {
  id: string
  name: string
  projectId?: string
  createdAt: string
  updatedAt: string
  /** Set on a subagent thread: the thread that started it. Absent on every other thread. */
  lineage?: ThreadLineage
  /** Set on a subagent created after workspace bindings were recorded. */
  workspaceBinding?: SubagentWorkspaceBinding
  /**
   * Explicit model selection for this thread; absent means use global settings. `instanceId` is
   * absent on threads saved before provider instances existed.
   */
  modelOverride?: ModelOverride
  /**
   * Opt-in isolated git worktree for this thread. OFF by default (undefined/false
   * means run on the primary checkout). Toggleable from the new-chat input bar
   * before the first message; locked once a workspace is provisioned or the
   * thread has started.
   */
  worktreeEnabled?: boolean
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
 * `awaiting_input` is Input: the agent asked the user something.
 */
export type ThreadActivityState = 'idle' | 'processing' | 'waiting' | 'awaiting_input' | 'completed'

/** Working or Waiting: the thread's work cycle has not finished yet. */
export function isThreadActivityActive(state: ThreadActivityState | undefined): boolean {
  return state === 'processing' || state === 'waiting'
}

export type ThreadActivitySnapshot = Record<string, ThreadActivityState>

export type TurnPhase =
  | 'idle' | 'queued' | 'thinking' | 'streaming'
  | 'tool_running' | 'awaiting_input' | 'finalizing'
  | 'completed' | 'stopped' | 'failed'

export interface TurnState {
  threadId: string
  turnId: string | null
  phase: TurnPhase
  activeMessageId?: string
  startedAt?: string
  updatedAt: string
  error?: string
  errorDescriptor?: import('./errors').AppErrorShape
}
export type TurnStateSnapshot = Record<string, TurnState>

export function isTurnActivePhase(phase: TurnPhase): boolean {
  return phase === 'queued' || phase === 'thinking' || phase === 'streaming' || phase === 'tool_running' || phase === 'finalizing'
}

/** Thread activity for a turn phase; `blockedOnWait` marks a tool phase whose calls only wait. */
export function turnPhaseActivity(phase: TurnPhase, blockedOnWait = false): ThreadActivityState {
  if (phase === 'awaiting_input') return 'awaiting_input'
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
}

export interface GitPushOptions {
  /** Refuse with `git_branch_changed` when HEAD is on another branch by now. */
  expectedBranch?: string
}

export interface GitCheckoutOptions {
  /** With uncommitted changes: `carry` them along (default) or `stash` them, switch and re-apply. */
  dirty?: 'carry' | 'stash'
}

export interface GitCheckoutResult {
  /** The changes were stashed and could not be re-applied cleanly, so the stash is kept. */
  stashKept?: boolean
}

export type GitPullStrategy = 'ff-only' | 'merge' | 'rebase'

export interface GitPullOptions {
  strategy?: GitPullStrategy
}

export interface GitPullResult {
  result: 'up-to-date' | 'fast-forwarded' | 'merged' | 'rebased' | 'conflicted'
}

export interface GitFetchResult {
  behindBefore: number
  behindAfter: number
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

export type PullRequestCheckState = 'passing' | 'failing' | 'pending' | 'none'

export interface GitPullRequestInfo {
  number: number
  title: string
  url: string
  state: 'open' | 'closed' | 'merged'
  isDraft: boolean
  checks: PullRequestCheckState
  checkCounts: { passed: number; failed: number; pending: number; total: number }
}

export type GitPullRequestLookup =
  | { state: 'found'; pullRequest: GitPullRequestInfo }
  /** isDefaultBranch is null when the repository's default branch could not be read. */
  | { state: 'none'; isDefaultBranch: boolean | null }
  | {
      state: 'unavailable'
      reason: 'gh-missing' | 'unauthenticated' | 'not-github' | 'no-branch' | 'error'
      message: string
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
