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
  status: 'ok' | 'error'
  output?: string
  error?: string
  silent?: boolean
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
  lastStatus?: 'ok' | 'error'
  lastError?: string
  pausedAt?: string
  pausedReason?: string
  threadId?: string
  projectId?: string
  createThread?: boolean
  repeat?: ScheduledJobRepeat
  runHistory?: ScheduledJobRunRecord[]
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

export type BuiltInChatMode = 'agent' | 'plan' | 'build'

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

export type AgentExecutionMode = 'interactive' | 'headless' | 'gui'

export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'failed'

export interface Agent {
  id: string
  cliType: CliType
  worktreePath: string
  branch: string
  executionMode: AgentExecutionMode
  ptyId?: string
  processId?: string
  status: AgentStatus
  task: string
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
  /** Inline images for user messages (shown as previews; also sent to vision models). */
  images?: ChatImageAttachment[]
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
  /** Explicit sidebar position within this thread's project (or standalone group). */
  order: number
  pinnedAt?: string
}

export type ThreadActivityState = 'idle' | 'processing' | 'awaiting_input' | 'completed'

export type ThreadActivitySnapshot = Record<string, ThreadActivityState>

export interface ThreadData {
  messages: ChatMessage[]
  agents: Agent[]
  tasks: Task[]
  /** Canonical, serializable Pi transcript. UI messages are presentation-only. */
  llmContext?: NativeLlmContext
}

/**
 * Durable Pi-native conversation state. `messages` is the lossless archive; compaction
 * only changes which suffix is active. Legacy UI history cannot recover tool calls,
 * tool results, provider identities, signatures, or hidden reasoning that was never saved.
 */
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
  ptyId: string | null
  title: string
  exited: boolean
}
