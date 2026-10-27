import type { Tool, ToolCall } from '@earendil-works/pi-ai'
import type { SkillDescriptor } from '../../../../shared/integrations'
import type { IntegrationActor } from '../../../../shared/integrations/actor'
import { APPROVALS_REFUSED_MESSAGE, QUESTIONS_REFUSED_MESSAGE } from '../../../../shared/harness/types'
import type { ChatMode } from '../../../../shared/types'
import type { AgentToolAccess } from '../../../agents/WorkspaceAccessPolicy'
import type { BrowserExecutionBinding } from '../../../orchestrator/browser'
import type { LlmToolEvent, StreamingLlmToolEvent } from '../../../harness/turnEvents'
import type { ModeCeiling } from '../../types'
import type { DelegationToolHost } from './delegation'

/**
 * What a tool may touch (docs/run-engine/SPEC.md §15.1):
 * - `reads`: reads state; the handler limits what the caller may see.
 * - `actsAsCaller`: acts on the caller's own thread and run (delegation, questions, plans, tasks).
 * - `writesThreads`: writes a thread named by `threadId`; only the caller's thread is allowed.
 * - `startsThreads`: creates threads; refused under a `plan` ceiling.
 */
export type ToolAccess = 'reads' | 'actsAsCaller' | 'writesThreads' | 'startsThreads'

export const ACCESS_CLASSES: ReadonlySet<string> = new Set<ToolAccess>(['reads', 'actsAsCaller', 'writesThreads', 'startsThreads'])

/**
 * What a call does to the parent's work, read by the gate and the writer barrier of runtimes that
 * run tools concurrently (PR 2 §4): `read` changes nothing outside the caller's own conversation,
 * `mutation` changes state the turn's writer guards, `delegation` starts or steers a child.
 */
export type ToolClass = 'read' | 'mutation' | 'delegation'

export const TOOL_CLASSES: ReadonlySet<string> = new Set<ToolClass>(['read', 'mutation', 'delegation'])

/** Who a call acts as: the thread's active run, under the ceiling its turn was given. */
export interface McpCaller {
  threadId: string
  runId: string
  provider: string
  modeCeiling: ModeCeiling
}

/** A mode's permissions as tool selection reads them. */
export interface ModeFacts {
  /** Edits or shell are denied (Plan and other read-only modes). */
  readOnly: boolean
  agent: boolean
  build: boolean
}

/**
 * One turn's app-tool context (`AppToolTurns`), registered by the `turn.start` executor before the
 * gateway starts the turn and dropped when it ends; an in-process loop builds its own for the
 * request it runs. Every field is daemon-minted; none comes from protocol or model input.
 */
export interface AppToolTurn {
  threadId: string
  runId: string
  /** Fences calls a runtime made for an earlier turn (`per_call` turn binding). */
  turnToken: string
  /** The attempt a `per_call` runtime that tags calls by attempt runs (the Pi RPC engine). */
  attemptToken?: string
  mode: ChatMode
  /** What the mode allows, from its descriptor (`ModeRegistry`). */
  modeFacts: ModeFacts
  modeCeiling: ModeCeiling
  /** A Mousse subagent implementing a delegated task in the in-process loop (`LlmChatOptions.subagent`). */
  subagent: boolean
  /** The read-only pre-allocation phase of such a subagent (`LlmChatOptions.subagentDiscovery`). */
  discovery: boolean
  projectPath?: string
  actor: IntegrationActor
  /** The turn's trusted browser binding, with `vision` from the selected model. */
  browser?: BrowserExecutionBinding
  /** Stages an applet for the response; absent when applets are off or the caller is a subagent. */
  onPublishApplet?: (source: unknown) => unknown
  enabledSkills: SkillDescriptor[]
  loadedSkills: Array<{ name: string; content: string }>
  /** A read-only (`shared`) child's workspace capability. */
  toolAccess?: AgentToolAccess
  /** Delegation tools of an in-process turn; an MCP caller's come from the host, by caller. */
  delegation?: DelegationToolHost
  /** Settings → Skills & MCP, read at call time. */
  settingsEnabled(name: string): boolean
  /** A trusted definition caller: its grants were checked before dispatch. */
  trusted?: boolean
  /**
   * The run refuses everything that would wait for the user (`RunPolicy.approvals: 'never'`):
   * tools that ask for approval or put a question to the user are refused at call time.
   */
  approvals?: 'never'
}

/** Writes an in-process call's timeline rows (`LlmToolEvent`s), as the pi loop always has. */
export interface ToolTimeline {
  /** Keeps the row with the turn's tool events and streams it. */
  record(event: LlmToolEvent, phase: StreamingLlmToolEvent['phase'], extra?: Pick<StreamingLlmToolEvent, 'input'>): void
  /** Streams the row only. */
  emit(event: LlmToolEvent, phase: StreamingLlmToolEvent['phase']): void
}

export interface ToolCallContext {
  caller: McpCaller
  turn: AppToolTurn
  /** Stable id of this call; derives the `clientRequestId` of the commands it issues. */
  toolCallId: string
  /** Aborted when the request closes, the caller's run ends or the in-process turn stops. */
  signal: AbortSignal
  transport: 'mcp' | 'in_process'
  /** In-process calls only: the caller's timeline. */
  timeline?: ToolTimeline
  /** A trusted definition's call is about to leave Mousse (`effects.dispatched`). */
  markEffect?(): void
}

export interface ToolImage {
  data: string
  mimeType: string
}

export interface ToolOutcome {
  text: string
  isError?: boolean
  /** Images the result carries; the MCP server sends them as `image` content. */
  images?: ToolImage[]
}

export type JsonSchema = Record<string, unknown>

/** Why a run that nobody answers (`approvals: 'never'`) refuses a tool that waits for the user; undefined when it may run. */
export function unattendedRefusal(tool: Pick<MousseTool, 'asksUser'>, turn: Pick<AppToolTurn, 'approvals'>): string | undefined {
  if (turn.approvals !== 'never' || !tool.asksUser) return undefined
  return tool.asksUser === 'question' ? QUESTIONS_REFUSED_MESSAGE : APPROVALS_REFUSED_MESSAGE
}

/** Per-turn availability: `true`, or why the tool cannot be used now. */
export type Availability = true | string

/**
 * The thread-stable listing a native MCP client caches: a tool is listed when the thread's ceiling,
 * read-only status and the build allow it, whatever the current turn's mode.
 */
export interface ToolListing {
  readOnly: boolean
  modeCeiling: ModeCeiling
}

export interface MousseTool {
  name: string
  description: string
  /** Plain JSON Schema (no TypeBox symbols), byte-identical to `definition`'s parameters. */
  inputSchema: JsonSchema
  access: ToolAccess
  class: ToolClass
  /**
   * A read-only (`shared`) delegated child may call this although it is not a `reads` tool: it
   * changes nothing but the caller's own conversation.
   */
  readOnlySafe?: boolean
  /** Callable in process only and never listed (older names kept for replayed transcripts). */
  hidden?: boolean
  /**
   * The call waits for the user: an approval (a quick action) or a question (`ask_user`). A run
   * whose approvals are `never` refuses it before the handler runs.
   */
  asksUser?: 'approval' | 'question'
  /** The pi-ai definition an in-process loop sends for this turn (default: the static one). */
  definition?(turn: AppToolTurn): Tool
  /** Per-turn availability, checked at call time on every transport. */
  available?(turn: AppToolTurn): Availability
  /** Whether an in-process loop offers the tool this turn (default: `available` is true). */
  offered?(turn: AppToolTurn): boolean
  /** Thread-stable listing filter (dev builds, profile features); default listed. */
  listed?(listing: ToolListing): boolean
  /** The timeline title of a call. */
  describe?(args: Record<string, unknown>): string
  handler(args: Record<string, unknown>, ctx: ToolCallContext): Promise<ToolOutcome> | ToolOutcome
}

export type McpToolErrorCode =
  | 'mousse_scope_denied'
  | 'mousse_caller_not_live'
  | 'mousse_ceiling_exceeded'
  | 'mousse_read_only'
  | 'mousse_unknown_tool'

/** A refusal the server reports as a JSON-RPC error, not as a tool result. */
export class McpToolError extends Error {
  constructor(
    readonly code: McpToolErrorCode,
    message: string
  ) {
    super(`${code}: ${message}`)
    this.name = 'McpToolError'
  }
}

export type ToolLedger = {
  start(call: ToolCall): string | undefined
  commit(id: string): void
  failed(id: string): void
}

/** `ask_user` over MCP blocks at most this long (or until the caller's run ends). */
export const ASK_USER_TIMEOUT_MS = 60 * 60 * 1000

export const CLIENT_REQUEST_ID_SCHEMA: JsonSchema = {
  type: 'string',
  description: 'Fresh per new action; reuse only to retry the same call, which then returns the first result.'
}

/** A plain JSON Schema copy of a pi-ai tool's parameters (TypeBox adds symbol keys). */
export function plainSchema(tool: Tool, extra: Record<string, JsonSchema> = {}): JsonSchema {
  const schema = JSON.parse(JSON.stringify(tool.parameters)) as JsonSchema & { properties?: Record<string, JsonSchema> }
  return Object.keys(extra).length ? { ...schema, properties: { ...(schema.properties ?? {}), ...extra } } : schema
}

export const json = (value: unknown): ToolOutcome => ({ text: JSON.stringify(value) })

/** The text legacy tools return when Settings → Skills & MCP turned a tool off. */
export function disabledInSettings(name: string): string {
  return `Tool "${name}" is disabled in Settings → Skills & MCP.`
}

/** `available` for a tool gated only by Settings → Skills & MCP. */
export function settingsGate(name: string) {
  return (turn: AppToolTurn): Availability => (turn.settingsEnabled(name) ? true : disabledInSettings(name))
}

/** Bounded copies for the timeline (the pi loop's `truncateForDisplay` / `truncateForModel`). */
export function truncateForDisplay(value: string): string {
  return value.length > 1_200 ? `${value.slice(0, 1_200)}\n...[truncated]` : value
}

export function truncateForModel(value: string): string {
  return value.length > 16_000 ? `${value.slice(0, 16_000)}\n...[truncated]` : value
}

/** Rejects once `signal` aborts, running `onAbort` first; never settles otherwise. */
export function abortRace<T>(work: Promise<T>, signal: AbortSignal | undefined, onAbort?: () => void): Promise<T> {
  if (!signal) return work
  return Promise.race([
    work,
    new Promise<never>((_resolve, reject) => {
      const abort = (): void => {
        onAbort?.()
        reject(signal.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError'))
      }
      if (signal.aborted) abort()
      else signal.addEventListener('abort', abort, { once: true })
      void work.finally(() => signal.removeEventListener('abort', abort)).catch(() => {})
    })
  ])
}
