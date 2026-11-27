import type { Tool, ToolCall } from '@earendil-works/pi-ai'
import type { SkillDescriptor } from '../../../../shared/integrations'
import type { IntegrationActor } from '../../../../shared/integrations/actor'
import type { PermissionMode } from '../../../../shared/permissionMode'
import type { AgentAccessLevel } from '../../../../shared/settings'
import type { ChatMode } from '../../../../shared/types'
import type { AgentToolAccess } from '../../../agents/WorkspaceAccessPolicy'
import type { DefinitionAuthority } from '../../../agentDefinitions/definitionGate'
import type { BotAuthority } from '../../../../shared/bots/personal/authority'
import type { BrowserExecutionBinding } from '../../../orchestrator/browser'
import type { BrowserRuntimePort } from '../../../../shared/browser/runtime'
import type { LlmToolEvent, StreamingLlmToolEvent } from '../../../harness/turnEvents'
import type { ModeCeiling } from '../../types'
import type { DelegationToolHost } from './delegation'
import type { ToolAccessPolicy } from './authority'
import { legacyRefusal, REFUSAL_FAULT_CODES } from './refusal'

/**
 * What a tool may touch (docs/run-engine/SPEC.md §15.1):
 * - `reads`: reads state; the handler limits what the caller may see.
 * - `actsAsCaller`: acts on the caller's own thread and run (delegation, questions, plans, tasks).
 * - `writesThreads`: writes a thread named by `threadId`; only the caller's thread is allowed.
 * - `startsThreads`: creates threads; refused under a `plan` ceiling.
 * - `editsWorkspace`: changes the caller's workspace or hands work over to it (integration, merge-back);
 *   only the caller's own thread, and it asks the thread's user first unless the caller's permission
 *   mode allows edits.
 * - `readsOthers`: reads threads other than the caller's own (`thread_read`, `thread_list`, `thread_search`);
 *   the registry checks the target before the handler runs and the handler limits what it returns by
 *   `ctx.scope`.
 * - `managesOthers`: changes threads other than the caller's own.
 * - `changesSettings`: changes the profile's settings (the theme). Like a change in Settings it needs a turn that may
 *   edit: refused for a read-only child and under a Plan ceiling, and it asks the thread's user first unless the
 *   caller's permission mode allows edits.
 */
export type ToolAccess = 'reads' | 'actsAsCaller' | 'writesThreads' | 'startsThreads' | 'editsWorkspace' | 'readsOthers' | 'managesOthers' | 'changesSettings'

export const ACCESS_CLASSES: ReadonlySet<string> = new Set<ToolAccess>(['reads', 'actsAsCaller', 'writesThreads', 'startsThreads', 'editsWorkspace', 'readsOthers', 'managesOthers', 'changesSettings'])

/**
 * How a caller reaches the thread a `readsOthers` or `managesOthers` call targets: its own thread, a
 * thread below it in the delegation tree (`descendant`), above it or beside it (`ancestor_or_sibling`),
 * a thread it launched, or any other thread (`manage`). `read` is no longer given.
 */
export type ToolScope = 'own' | 'descendant' | 'ancestor_or_sibling' | 'launched' | 'read' | 'manage'

/** How a thread other than the caller's is related to it. */
export type ThreadRelation = 'descendant' | 'ancestor_or_sibling' | 'launched'

/**
 * How a thread sits in the caller's family (docs/plans/tool-api.md §1.2): its parent, a direct child, a sibling, a
 * descendant further down, or a native helper's mirror thread hosted by any of these or by the caller.
 */
export type FamilyRelation = 'parent' | 'child' | 'sibling' | 'descendant' | 'native'

/** What a message to another thread is (docs/plans/tool-api.md §2.2): a new assignment, or information. */
export type MessageIntent = 'work' | 'note'

/**
 * What a call does to the parent's work, read by the gate and the writer barrier of runtimes that
 * run tools concurrently (PR 2 §4): `read` changes nothing outside the caller's own conversation,
 * `mutation` changes state the turn's writer guards, `delegation` starts or steers a child.
 */
export type ToolClass = 'read' | 'mutation' | 'delegation'

/**
 * A capability a tool declares it needs beyond its `access` (docs/plans/tool-api.md §1.3). `threads.delegate` (start a
 * child no wider than yourself) is every delegation tool's and every thread holds it, readers and Plan included;
 * `threads.start` (an independent thread or a fork) is not held under a Plan ceiling or by a read-only child.
 */
export type ToolCapability = 'threads.start' | 'themes' | 'quick_actions'

export const TOOL_CLASSES: ReadonlySet<string> = new Set<ToolClass>(['read', 'mutation', 'delegation'])

/** Who a call acts as: the thread's active run, under the ceiling its turn was given. */
export interface McpCaller {
  threadId: string
  runId: string
  provider: string
  modeCeiling: ModeCeiling
  /** The level the run's credential recorded; it no longer limits anything (every agent reads and manages every thread). */
  accessLevel: AgentAccessLevel
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
  /**
   * The permission mode the turn runs in; an MCP turn's is
   * read from its run's binding (`ToolRegistryOptions.permissionModeFor`). Absent, nothing runs unasked that a
   * known mode would have asked for.
   */
  permissionMode?: PermissionMode
  /**
   * The agent access level recorded for the run (SPEC §15.1). It no longer limits anything.
   */
  accessLevel?: AgentAccessLevel
  /** The thread is a Mousse subagent (its lineage says so): the owner's own preferences do not pass down to it. */
  subagent: boolean
  projectPath?: string
  actor: IntegrationActor
  /** The turn's trusted browser binding, with `vision` from the selected model. */
  browser?: BrowserExecutionBinding
  /**
   * The browser runtime the turn's browser tools run on, when its host supplies its own (an agent
   * chat's shared browser); absent: the profile's (`AppToolHost.browserRuntime`).
   */
  browserRuntime?: BrowserRuntimePort
  /** Stages an applet for the response (a subagent's too, in its own thread); absent when applets are off. */
  onPublishApplet?: (source: unknown) => unknown
  /** Reads a published applet's stored source in pages (`read_applet`); absent when applets are off and for a bot. */
  onReadApplet?: (args: Record<string, unknown>) => unknown
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
   * A definition run on a runtime with its own loop: every app-tool and proxied MCP call is held to
   * the definition's grants, policy and approvals before it runs (PR 4 §5a).
   */
  definition?: DefinitionAuthority
  /**
   * A bot turn (PR 6 §4): every app-tool call is held to the bot's grant before it runs, and its
   * skills are only the granted ones.
   */
  bot?: BotAuthority
  /** The turn's model takes images in tool results (`toolImages`): an MCP result's images reach it, within limits. */
  toolImages?: boolean
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
  /** Set by the registry's central check for `readsOthers` and `managesOthers` tools. */
  scope?: ToolScope
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
  /**
   * The tool ran and `text` is what it produced (a command's output and exit code, what the browser reported): an error
   * result keeps its text as it is rather than becoming a refusal (`asRefusal`). Never sent to the caller.
   */
  ran?: boolean
  /** Images the result carries; the MCP server sends them as `image` content. */
  images?: ToolImage[]
}

export type JsonSchema = Record<string, unknown>

/**
 * A tool's own check of arguments that name a thread, project, source or file beyond the central one
 * (docs/plans/tool-api.md §1.2 `authorize`). Returns the scope the call reaches its target with, or undefined to keep
 * the central check's. `where` says where the check is made when it is the handler's.
 */
export interface ToolAuthorize {
  (actor: McpCaller, args: Record<string, unknown>, targets: ToolAccessPolicy | undefined): ToolScope | undefined
  where?: string
}

/** `authorize` for a tool whose handler checks the thread arguments the central check does not cover; says where. */
export function checkedInHandler(where: string): ToolAuthorize {
  return Object.assign((() => undefined) as ToolAuthorize, { where })
}

/** Per-turn availability: `true`, or why the tool cannot be used now. */
export type Availability = true | string

/**
 * The thread-stable listing a native MCP client caches: a tool is listed when the thread's ceiling,
 * read-only status and the build allow it, whatever the current turn's mode.
 */
export interface ToolListing {
  /** The thread the list is for, when it is one thread's. */
  threadId?: string
  readOnly: boolean
  modeCeiling: ModeCeiling
  /** The thread is a Mousse subagent: it does not list what never passes down (the owner's own preferences). */
  subagent?: boolean
  /** The thread's role when it is a personal bot's thread (PR 6 §5): only bot threads list the bot tools. */
  botRole?: 'activation' | 'context' | 'subagent'
  /**
   * A bot thread's turn now: the app tools it holds. Its thread tools ("use your threads") are listed only when held,
   * so a bot is shown what it can call in that turn; with no turn running, none.
   */
  botTurnTools?: ReadonlySet<string>
  /**
   * A bot thread's turn reaches its tool catalogue so (`BotAuthority.catalogue`): `use_tool` lists the core set only
   * (docs/plans/bot-context.md §15). Absent or `search`: every tool it may be offered, as before.
   */
  botCatalogue?: 'search' | 'use_tool'
}

/**
 * A Mousse tool's declaration. Who may call it (`access`, `class`, `readOnlySafe`, `callable`, `listed`, `available`,
 * `asksUser`, `launchedOk`, `botGrantAnswers`, `botAsksOwner`, `capabilities`, `authorize`) is read only by the authority
 * compiler (`authority.ts`), which the list, the turn preamble and dispatch all ask.
 */
export interface MousseTool {
  name: string
  description: string
  /**
   * What a personal bot's thread lists instead of `description`: the same tool as a bot uses it, without what does not
   * hold for a bot (an agent's counts per run, its limit on agent messages in a row) and with what does.
   */
  botDescription?: string
  /**
   * What a personal bot's thread lists instead of `inputSchema`, where a bot names what a thread's agent has as its own
   * (a bot has no project: the git tools take the thread or project it reads).
   */
  botInputSchema?: JsonSchema
  /** What a personal bot's thread lists instead of `class`, where the bot's tool of a shared name is another kind. */
  botClass?: ToolClass
  /**
   * A tool whose personal bot's call its grant answers: once the registry has held the call to the bot's grant, it asks
   * nobody, whatever `access` would ask of a thread (the owner allowing the permission is the bot's Full access for it).
   */
  botGrantAnswers?: true
  /**
   * A tool whose ask a personal bot's call shows its owner in the bot's own chat (a secret card), where the owner answers
   * it: a bot's turn, which answers no approvals, may still call it, and waits for that answer as a thread's turn would.
   */
  botAsksOwner?: true
  /** Plain JSON Schema (no TypeBox symbols), byte-identical to `definition`'s parameters. */
  inputSchema: JsonSchema
  access: ToolAccess
  /** The permission key an `editsWorkspace` or `changesSettings` tool asks under (`src/shared/permissionKeys.ts`). */
  permissionKey?: string
  /**
   * The question an `editsWorkspace` or `changesSettings` tool asks the person when the permission mode does not allow it;
   * a function when the question names what the call would do (the file a theme would use as its wallpaper).
   */
  approvalPrompt?: string | ((args: Record<string, unknown>) => string)
  /**
   * The permission mode a call runs in without asking: `edit` (default: any mode that allows edits) or `full` (only Full
   * access; every other mode asks).
   */
  runsWithoutAsking?(args: Record<string, unknown>): 'edit' | 'full'
  class: ToolClass
  /**
   * A read-only (`shared`) delegated child may call this although it is not a `reads` tool: it
   * changes nothing but the caller's own conversation.
   */
  readOnlySafe?: boolean
  /**
   * The tool sends a message to the thread its `target` names, of this intent (docs/plans/tool-api.md §2.2): the
   * family rules decide who may send it (`familyMessageScope`), before the central check of a target outside the family.
   */
  messageIntent?(args: Record<string, unknown>): MessageIntent | undefined
  /**
   * Capabilities the tool needs beyond what its `access` says (docs/plans/tool-api.md §1.3): `threads.start` for a tool
   * that starts an independent thread (a Plan ceiling and a read-only child lack it), `themes` and `quick_actions` for
   * the owner's own preferences, which never pass down to a subagent.
   */
  capabilities?: readonly ToolCapability[]
  /**
   * The browser right a call needs (docs/plans/tool-api.md §2.6 "Rights"): `browser.read` to observe, `browser.act` to
   * open, act or change tabs, read from the arguments. A Plan ceiling and a read-only child do not hold `browser.act`.
   */
  browserRight?(args: Record<string, unknown>): 'browser.read' | 'browser.act'
  /**
   * The call needs `person` (docs/plans/tool-api.md §1.3 "Provenance"): only a turn a person started holds it, and it
   * never passes down to a subagent. `true` for every call, or the variants that need it, read from the arguments. A bot's
   * turn is held to its grant instead.
   */
  needsPerson?: true | ((args: Record<string, unknown>) => boolean)
  /**
   * `in_process`: never callable over MCP (an older name kept for replayed transcripts). Whether it is listed is
   * `listed`'s to say.
   */
  callable?: 'in_process'
  /**
   * Listed fully loaded (`_meta['anthropic/alwaysLoad']`): Claude Code then sends its whole
   * definition on every turn instead of deferring it behind tool search. Only for a tool the model
   * must reach without searching (the bot's `memory_save`); every other tool stays deferred.
   */
  alwaysLoad?: true
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
  /**
   * What a `readsOthers` or `managesOthers` call targets. Default: the thread `args.threadId` names
   * (the caller's own when absent). `undefined`: the caller's own thread. A target without a
   * `threadId` is a listing.
   */
  target?(args: Record<string, unknown>, caller: McpCaller): { threadId?: string; projectId?: string } | undefined
  /** A `managesOthers` tool that keeps the `launched` scope for a thread the caller launched. */
  launchedOk?: true
  /**
   * The tool's own check of arguments that name a thread, beyond the central one (which covers `threadId` of a
   * `readsOthers`, `managesOthers`, `writesThreads` or `editsWorkspace` tool); `checkedInHandler` says where the
   * handler checks it. Registration refuses a tool that takes such an argument without it.
   */
  authorize?: ToolAuthorize
  handler(args: Record<string, unknown>, ctx: ToolCallContext): Promise<ToolOutcome> | ToolOutcome
}

export type McpToolErrorCode =
  | 'mousse_scope_denied'
  | 'mousse_caller_not_live'
  | 'mousse_ceiling_exceeded'
  | 'mousse_read_only'
  | 'mousse_conflict'
  | 'mousse_unknown_tool'

/**
 * A refusal a tool throws. The registry and the MCP server turn it into an error result in the refusal shape
 * (`legacyRefusal`), with `details` under its `data`; only the faults in `REFUSAL_FAULT_CODES` (the credential's turn
 * is over, no such tool) stay JSON-RPC errors.
 */
export class McpToolError extends Error {
  /** The message without the code in front. */
  readonly reason: string
  constructor(
    readonly code: McpToolErrorCode,
    message: string,
    readonly details?: Record<string, unknown>
  ) {
    super(`${code}: ${message}`)
    this.name = 'McpToolError'
    this.reason = message
  }
}

/** A thrown refusal as an error result, or undefined for a fault that stays a JSON-RPC error (and anything else). */
export function refusalOutcome(error: unknown): ToolOutcome | undefined {
  if (!(error instanceof McpToolError) || REFUSAL_FAULT_CODES.has(error.code)) return undefined
  return legacyRefusal(error.code, error.reason, error.details)
}

export type ToolLedger = {
  start(call: ToolCall, options?: { idempotent?: boolean }): string | undefined
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
