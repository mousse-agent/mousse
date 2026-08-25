export type MainView = 'agents' | 'browser' | 'terminal' | 'files' | 'git' | 'documents'

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
  status: 'ok' | 'error' | 'interrupted'
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
  lastStatus?: 'ok' | 'error' | 'interrupted'
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
  modelOverride?: {
    llmProvider: string
    model: string
  }
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
  id: string
  cliType: CliType
  worktreePath: string
  branch: string
  repositoryRoot?: string
  executionMode: AgentExecutionMode
  ptyId?: string
  processId?: string
  exitCode?: number | null
  exitSignal?: string | null
  exitedAt?: string
  status: AgentStatus
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

export interface ChatMessage {
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
  /** Durable model-context input that is intentionally omitted from the user-facing transcript. */
  hidden?: boolean
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
  }
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

export interface SpawnAgentAction {
  type: 'spawn_agents'
  agents: SubagentAssignment[]
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
  | SpawnAgentAction
  | CompleteTaskAction
  | MessageAction

export interface OrchestratorResponse {
  message: string
  actions: OrchestratorAction[]
  /**
   * When true, the send was accepted onto the thread queue instead of starting a turn.
   * `queueItem` identifies the durable pending message.
   */
  queued?: boolean
  queueItem?: QueuedMessage
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
}

export interface ContextUsageCategory {
  label: string
  color: string
  tokens: number
}

export interface ContextUsageSnapshot {
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
  type: 'click' | 'delay' | 'paste' | 'key' | 'type'
  x?: number
  y?: number
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
  windowTitlePattern: string
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

export interface Thread {
  id: string
  name: string
  projectId?: string
  createdAt: string
  updatedAt: string
  /** Explicit model selection for this thread; absent means use global settings. */
  modelOverride?: {
    llmProvider: string
    model: string
  }
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

export type ThreadActivityState = 'idle' | 'processing' | 'awaiting_input' | 'completed'

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
}
export type TurnStateSnapshot = Record<string, TurnState>

export function isTurnActivePhase(phase: TurnPhase): boolean {
  return phase === 'queued' || phase === 'thinking' || phase === 'streaming' || phase === 'tool_running' || phase === 'finalizing'
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

/** Result of attempting to deliver a turn to a Mousse agent. */
export interface MousseAgentSendResult {
  accepted: boolean
  reason?: 'missing' | 'busy' | 'terminal' | 'empty'
}

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
  version: 1
  agentId: string
  worktreePath: string
  /** Original delegated task text (for display / resume metadata). */
  task: string
  assignment: MousseAgentAssignment
  /** Presentation timeline shown in the subagent tab. */
  messages: ChatMessage[]
  /** Pi-native transcript used for LLM resume (assistant + tool results). */
  history: import('@earendil-works/pi-ai').Message[]
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
}

export interface NativeLlmContext {
  version: 1
  messages: import('@earendil-works/pi-ai').Message[]
  fidelity: 'native' | 'legacy-estimated'
  activeStartIndex: number
  compaction?: {
    generation: number
    summary: string
    tokensBefore: number
    createdAt: number
  }
  /** Restored on session load so context usage stays measured after persist/reload. */
  lastTurnUsage?: NativeLastTurnUsage
}

export interface FileEntry {
  name: string
  path: string
  kind: 'file' | 'directory'
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

export interface GitStatusSnapshot {
  isRepo: boolean
  branch: string | null
  ahead: number
  behind: number
  changes: GitFileChange[]
}

export interface GitCommit {
  hash: string
  shortHash: string
  message: string
  author: string
  date: string
  /** True when the commit is already on the remote tracking branch. */
  pushed: boolean
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
