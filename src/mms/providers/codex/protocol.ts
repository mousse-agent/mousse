/**
 * The slice of the Codex app-server protocol (codex-cli 0.162, `codex app-server
 * generate-ts`) that Mousse uses, hand-written from the generated schema. Only the fields Mousse
 * reads or sends are typed; servers add fields freely, so readers stay tolerant of extras.
 *
 * Wire format: one JSON object per line on stdio, JSON-RPC 2.0 shaped but without the `jsonrpc`
 * member. A request has `id` and `method`, a notification only `method`, a response `id` with
 * `result` or `error`. Both sides send requests: the server asks the client for approvals and
 * user input.
 */

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

export type RequestId = string | number

export interface RpcError {
  code: number
  message: string
  data?: unknown
}

// ---------------------------------------------------------------------------------------------
// Client → server requests

export interface InitializeParams {
  clientInfo: { name: string; title: string | null; version: string }
  capabilities: { experimentalApi: boolean; requestAttestation: boolean; optOutNotificationMethods?: string[] | null } | null
}
export interface InitializeResponse {
  userAgent: string
  /** Absolute path of the server's `$CODEX_HOME` (the user's `~/.codex` unless inherited). */
  codexHome: string
  platformFamily: string
  platformOs: string
}

export type CodexAccount =
  | { type: 'apiKey' }
  | { type: 'chatgpt'; email: string | null; planType: string }
  | { type: 'amazonBedrock'; usesCodexManagedCredentials: boolean }
export interface AccountReadParams {
  refreshToken?: boolean
}
export interface AccountReadResponse {
  account: CodexAccount | null
  requiresOpenaiAuth: boolean
}

export interface ModelListParams {
  cursor?: string | null
  limit?: number | null
  includeHidden?: boolean | null
}
export interface CodexModel {
  id: string
  model: string
  displayName: string
  description: string
  hidden: boolean
  supportedReasoningEfforts: Array<{ reasoningEffort: string; description: string }>
  defaultReasoningEffort: string
  inputModalities?: string[]
  isDefault: boolean
}
export interface ModelListResponse {
  data: CodexModel[]
  nextCursor: string | null
}

export type AskForApproval = 'untrusted' | 'on-request' | 'never'
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'
export type SandboxPolicy =
  | { type: 'readOnly'; networkAccess: boolean }
  | {
      type: 'workspaceWrite'
      writableRoots: string[]
      networkAccess: boolean
      excludeTmpdirEnvVar: boolean
      excludeSlashTmp: boolean
    }

/** Config overrides layered over `config.toml` for one thread; dotted keys are accepted. */
export type ThreadConfig = Record<string, JsonValue>

export interface ThreadStartParams {
  model?: string | null
  /** Model provider id; overrides `model_provider` from any config layer. */
  modelProvider?: string | null
  cwd?: string | null
  approvalPolicy?: AskForApproval | null
  sandbox?: SandboxMode | null
  config?: ThreadConfig | null
  developerInstructions?: string | null
}
export interface ThreadResumeParams extends ThreadStartParams {
  threadId: string
  /** Skip hydrating `thread.turns`; Mousse never reads them. */
  excludeTurns?: boolean
}
export interface CodexThread {
  id: string
}
export interface ThreadStartResponse {
  thread: CodexThread
  /** The model the thread resolved (the config default when none was requested). */
  model: string
  /** The model provider the thread resolved; its credentials pay for the turns. */
  modelProvider: string
  cwd: string
}
export type ThreadResumeResponse = ThreadStartResponse
/** Loads the thread from disk into a new thread, with these overrides applied. */
export type ThreadForkParams = ThreadResumeParams
export type ThreadForkResponse = ThreadStartResponse
export interface ThreadUnsubscribeResponse {
  status: 'notLoaded' | 'notSubscribed' | 'unsubscribed'
}

export type UserInput =
  | { type: 'text'; text: string; text_elements: unknown[] }
  | { type: 'image'; url: string }

export interface TurnStartParams {
  threadId: string
  input: UserInput[]
  cwd?: string | null
  approvalPolicy?: AskForApproval | null
  sandboxPolicy?: SandboxPolicy | null
  model?: string | null
  effort?: string | null
}
export type TurnStatus = 'completed' | 'interrupted' | 'failed' | 'inProgress'
export interface TurnError {
  message: string
  additionalDetails?: string | null
  codexErrorInfo?: CodexErrorInfo | null
}

/**
 * What kind of failure ended a turn, as the app-server names it: a bare kind (`usageLimitExceeded`,
 * `unauthorized`, `serverOverloaded`, `badRequest`, …) or a one-key object whose value may carry the
 * upstream HTTP status (`{ "responseStreamFailed": { "httpStatusCode": 503 } }`). Kinds are read
 * leniently: an unknown one reads as itself and maps like any other unknown failure.
 */
export type CodexErrorKind =
  | 'contextWindowExceeded'
  | 'usageLimitExceeded'
  | 'serverOverloaded'
  | 'httpConnectionFailed'
  | 'responseStreamConnectionFailed'
  | 'responseStreamDisconnected'
  | 'responseTooManyFailedAttempts'
  | 'internalServerError'
  | 'unauthorized'
  | 'badRequest'
  | 'threadRollbackFailed'
  | 'sandboxError'
  | 'other'
export type CodexErrorInfo = CodexErrorKind | string | { [kind: string]: { httpStatusCode?: number | null } | null | undefined }

/** The kind of a `codexErrorInfo` (a bare string, or the single key of an object variant). */
export function codexErrorKind(info: unknown): string | undefined {
  if (typeof info === 'string') return info || undefined
  if (!info || typeof info !== 'object' || Array.isArray(info)) return undefined
  const keys = Object.keys(info)
  return keys.length === 1 ? keys[0] : undefined
}

/** The upstream HTTP status an object variant of `codexErrorInfo` carries, when it is a valid one. */
export function codexHttpStatus(info: unknown): number | undefined {
  if (!info || typeof info !== 'object' || Array.isArray(info)) return undefined
  const kind = codexErrorKind(info)
  const detail = kind ? (info as Record<string, unknown>)[kind] : undefined
  const status = detail && typeof detail === 'object' ? (detail as { httpStatusCode?: unknown }).httpStatusCode : undefined
  return typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined
}
export interface CodexTurn {
  id: string
  status: TurnStatus
  error: TurnError | null
}
export interface TurnStartResponse {
  turn: CodexTurn
}

export interface TurnSteerParams {
  threadId: string
  input: UserInput[]
  /** Precondition: the request fails unless this is the thread's active turn. */
  expectedTurnId: string
}
export interface TurnSteerResponse {
  turnId: string
}

export interface TurnInterruptParams {
  threadId: string
  /**
   * The turn to stop. An empty string submits an interrupt of whatever turn the thread is running
   * (a no-op on an idle thread); the reply only says the interrupt was submitted, not that the
   * turn stopped.
   */
  turnId: string
}
export type TurnInterruptResponse = Record<string, never>

/** What a thread is doing, as the server reports it (`thread.status.type`). */
export type ThreadStatusType = 'idle' | 'active' | 'notLoaded' | 'systemError'
export const THREAD_STATUS_TYPES: readonly string[] = ['idle', 'active', 'notLoaded', 'systemError']

/**
 * `thread/list` filters are experimental (`experimentalApi: true` at `initialize`); an older server
 * ignores them. `parentThreadId` and `ancestorThreadId` exclude each other. `ancestorThreadId`
 * lists the thread's descendants at any depth. Rows are typed loosely: `helperTree` validates them.
 */
export interface ThreadListParams {
  ancestorThreadId?: string | null
  parentThreadId?: string | null
  /** Skip the JSONL scan; relation filters need the state database anyway. */
  useStateDbOnly?: boolean
  limit?: number | null
  cursor?: string | null
}
export interface ThreadListResponse {
  data: unknown[]
  nextCursor?: string | null
}
export interface ThreadReadParams {
  threadId: string
}
export interface ThreadReadResponse {
  /** `id`, `status.type`, `parentThreadId` (null for a root thread) and `createdAt` (unix seconds). */
  thread: unknown
}

export interface ConfigReadParams {
  /** Resolves project config layers as seen from this directory. */
  cwd?: string | null
  includeLayers?: boolean
}
type McpServerEntry = { enabled?: boolean | null } | null
export interface ConfigReadResponse {
  /** The effective config; Mousse reads only the entries under `mcp_servers`. */
  config: { mcp_servers?: Record<string, McpServerEntry> | null } & Record<string, unknown>
  /** Each layer (user, system, project) with why it is switched off, when it is; requires `includeLayers`. */
  layers?: Array<{ disabledReason: string | null; config?: { mcp_servers?: Record<string, McpServerEntry> | null } | null }> | null
}

/** Request methods Mousse calls, with their params and results. `account/logout` is deliberately absent. */
export interface CodexRequestMap {
  initialize: { params: InitializeParams; result: InitializeResponse }
  'config/read': { params: ConfigReadParams; result: ConfigReadResponse }
  'account/read': { params: AccountReadParams; result: AccountReadResponse }
  'model/list': { params: ModelListParams; result: ModelListResponse }
  'thread/start': { params: ThreadStartParams; result: ThreadStartResponse }
  'thread/resume': { params: ThreadResumeParams; result: ThreadResumeResponse }
  'thread/fork': { params: ThreadForkParams; result: ThreadForkResponse }
  'thread/unsubscribe': { params: { threadId: string }; result: ThreadUnsubscribeResponse }
  'turn/start': { params: TurnStartParams; result: TurnStartResponse }
  'turn/steer': { params: TurnSteerParams; result: TurnSteerResponse }
  'turn/interrupt': { params: TurnInterruptParams; result: TurnInterruptResponse }
  'thread/list': { params: ThreadListParams; result: ThreadListResponse }
  'thread/read': { params: ThreadReadParams; result: ThreadReadResponse }
}
export type CodexMethod = keyof CodexRequestMap

// ---------------------------------------------------------------------------------------------
// Server → client notifications

export type ThreadItem =
  | { type: 'userMessage'; id: string; content?: UserInput[] }
  | { type: 'agentMessage'; id: string; text: string; phase?: string | null }
  | { type: 'reasoning'; id: string; summary?: string[]; content?: string[] }
  | {
      type: 'commandExecution'
      id: string
      command: string
      cwd?: string
      status: string
      exitCode?: number | null
    }
  | {
      type: 'fileChange'
      id: string
      changes: Array<{ path: string; kind: { type: string }; diff: string }>
      status: string
    }
  | { type: 'mcpToolCall'; id: string; server: string; tool: string; status: string }
  | { type: 'dynamicToolCall'; id: string; tool: string; status: string }
  | { type: 'webSearch'; id: string; query?: string }
  | { type: string; id: string }

export interface TokenUsageBreakdown {
  totalTokens: number
  inputTokens: number
  cachedInputTokens: number
  cacheWriteInputTokens: number
  outputTokens: number
  reasoningOutputTokens: number
}

export interface CodexNotificationMap {
  'turn/started': { threadId: string; turn: CodexTurn }
  'turn/completed': { threadId: string; turn: CodexTurn }
  'item/started': { threadId: string; turnId: string; item: ThreadItem }
  'item/completed': { threadId: string; turnId: string; item: ThreadItem }
  'item/agentMessage/delta': { threadId: string; turnId: string; itemId: string; delta: string }
  'item/reasoning/summaryTextDelta': { threadId: string; turnId: string; itemId: string; delta: string }
  'thread/tokenUsage/updated': {
    threadId: string
    turnId: string
    tokenUsage: { total: TokenUsageBreakdown; last: TokenUsageBreakdown; modelContextWindow: number | null }
  }
  error: { threadId: string; turnId: string; error: TurnError; willRetry: boolean }
  'account/updated': { authMode: string | null; planType?: string | null }
  /** Broadcast to every connection, not only subscribers of the thread. */
  'thread/status/changed': { threadId: string; status: { type: string } }
  'thread/closed': { threadId: string }
}

export interface CodexNotification {
  method: string
  params: unknown
}

/** `params` of `notification` when it is `method`; undefined otherwise. */
export function notificationParams<M extends keyof CodexNotificationMap>(
  notification: CodexNotification,
  method: M
): CodexNotificationMap[M] | undefined {
  return notification.method === method && notification.params && typeof notification.params === 'object'
    ? (notification.params as CodexNotificationMap[M])
    : undefined
}

// ---------------------------------------------------------------------------------------------
// Server → client requests

export type CommandApprovalDecision = 'accept' | 'acceptForSession' | 'decline' | 'cancel'
export interface CommandExecutionApprovalParams {
  threadId: string
  turnId: string
  itemId: string
  reason?: string | null
  command?: string | null
  cwd?: string | null
}
export type FileChangeApprovalDecision = 'accept' | 'acceptForSession' | 'decline' | 'cancel'
export interface FileChangeApprovalParams {
  threadId: string
  turnId: string
  itemId: string
  reason?: string | null
  grantRoot?: string | null
}
export interface ToolRequestUserInputParams {
  threadId: string
  turnId: string
  itemId: string
  questions: Array<{
    id: string
    header: string
    question: string
    isOther: boolean
    isSecret: boolean
    options: Array<{ label: string; description: string }> | null
  }>
}
export interface ToolRequestUserInputResponse {
  answers: Record<string, { answers: string[] }>
}

export interface CodexServerRequestMap {
  'item/commandExecution/requestApproval': {
    params: CommandExecutionApprovalParams
    result: { decision: CommandApprovalDecision }
  }
  'item/fileChange/requestApproval': {
    params: FileChangeApprovalParams
    result: { decision: FileChangeApprovalDecision }
  }
  'item/tool/requestUserInput': { params: ToolRequestUserInputParams; result: ToolRequestUserInputResponse }
  'item/permissions/requestApproval': {
    params: { threadId: string; turnId: string; itemId: string; reason: string | null }
    result: { permissions: Record<string, never>; scope: 'turn' | 'session' }
  }
  'mcpServer/elicitation/request': {
    params: { threadId: string; turnId: string | null; serverName: string; message?: string }
    result: { action: 'accept' | 'decline' | 'cancel'; content: null; _meta: null }
  }
}

export interface CodexServerRequest {
  id: RequestId
  method: string
  params: unknown
}

/** Error codes the server uses and Mousse reports back. */
export const RPC_INVALID_REQUEST = -32600
export const RPC_METHOD_NOT_FOUND = -32601
export const RPC_INTERNAL_ERROR = -32603
