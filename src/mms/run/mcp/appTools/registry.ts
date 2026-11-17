import type { ToolCall } from '@earendil-works/pi-ai'
import { PERMISSION_KEYS } from '../../../../shared/permissionKeys'
import { APPROVALS_REFUSED_MESSAGE } from '../../../../shared/harness/types'
import { permissionModeAllows, type PermissionMode } from '../../../../shared/permissionMode'
import type { PendingUserQuestions, UserQuestionAnswers } from '../../../../shared/types'
import type { ApprovalTag } from '../../../orchestrator/UserQuestionService'
import type { AgentToolAccess } from '../../../agents/WorkspaceAccessPolicy'
import { authorizeDefinitionCall, definitionRefusal, takeAuthorizedCall, withoutTransportFields } from '../../../agentDefinitions/definitionGate'
import { botAppToolRefusal, botBrowserNotAllowed, botBrowserWithheld } from '../../../../shared/bots/personal/walls'
import { botMayBeOffered, isBotThreadTool, isBotTurnHeldTool } from '../../../../shared/bots/personal/manifest'
import { BOT_USE_TOOL, botCoreTool } from '../../../../shared/bots/personal/catalogue'
import type { McpToolDescriptor } from '../../../../shared/integrations'
import type { IntegrationActor } from '../../../../shared/integrations/actor'
import type { McpToolCallResult } from '../../../../shared/integrations/results'
import type { McpManager } from '../../../integrations/mcp/McpManager'
import type { ModeCeiling } from '../../types'
import type { RelayAdmission, RelayGrant } from '../relay/types'
import { callForBot, type BotMcp } from '../../../bots/mcp/BotMcp'
import type { AppToolTurns } from './turns'
import type { AgentAccessLevel } from '../../../../shared/settings'
import { callerThreadOnly } from './thread'
import {
  ACCESS_CLASSES,
  McpToolError,
  plainSchema,
  refusalOutcome,
  TOOL_CLASSES,
  unattendedRefusal,
  type AppToolTurn,
  type JsonSchema,
  type McpCaller,
  type MousseTool,
  type ToolCallContext,
  type ToolLedger,
  type ThreadRelation,
  type ToolListing,
  type ToolOutcome,
  type ToolScope,
  type ToolTimeline
} from './types'
import { asRefusal, refused } from './refusal'

/**
 * What a call that waited for a run the provider started (`awaitLiveRun`) learns: the run it must act as,
 * or `null` when that run never became active (it timed out, was cancelled or its thread was deleted).
 */
export interface LiveRunGate {
  runId: string | null
}

/** How a native runtime's Mousse MCP calls are tied to the turn that made them (PR 2 §2). */
export type McpTurnBinding = 'per_call' | 'drained_turn' | 'rotate'

/** The input key a `per_call` runtime stamps with its turn token; stripped before the handler. */
export const TURN_TOKEN_KEY = '_mousse_turn'
/** The input key a runtime that tags calls by attempt (the Pi RPC engine) stamps. */
export const ATTEMPT_TOKEN_KEY = '_mousse_attempt'

/** The credential an MCP request's bearer resolved to (`McpAuthority`). */
export interface McpCredentialAuthority {
  threadId: string
  /** The run the credential is bound to; never re-pointed by a call. */
  runId: string
  provider: string
  modeCeiling: ModeCeiling
  /** The level the credential recorded for this run (SPEC §15.1); it no longer limits anything. */
  accessLevel: AgentAccessLevel
  binding: McpTurnBinding
  /** The MCP relay the turn attached (`RelayGrant`), copied from the credential; absent: none. */
  relay?: RelayGrant
  /** Still live and of the thread's current runtime epoch (re-read after any wait). */
  current(): boolean
}

export interface McpCallRequest {
  credential: McpCredentialAuthority
  /** Stable id of this call; derives the `clientRequestId` of the commands it issues. */
  toolCallId: string
  /** Aborted when the HTTP request closes or the caller's turn ends. */
  signal: AbortSignal
}

/**
 * What the central check of `readsOthers` and `managesOthers` tools asks of the thread owner (SPEC
 * §15.1), read at call time.
 */
export interface ToolAccessPolicy {
  /** How `threadId` is related to the caller, or null. */
  relation(caller: McpCaller, threadId: string): ThreadRelation | null
  threadExists(threadId: string): boolean
  /** The thread is private (`Thread.localOnly`); absent: no thread is. */
  localOnly?(threadId: string): boolean
  /**
   * Where a personal bot's thread tool ("use your threads") may reach: the scope for a thread (`botThreadReach`, the
   * rule its list and search follow too) or a project, or the refusal's words. Absent: a bot reaches nothing.
   */
  botReach?(caller: McpCaller, target: { threadId?: string; projectId?: string }, options?: { read?: boolean }): { scope: ToolScope } | { refused: string }
}

export interface ToolRegistryOptions {
  /** The thread's active run (`starting|running|finalizing`), or null when it has none. */
  activeRunId(threadId: string): string | null
  /**
   * A run is about to become the thread's active one (a turn its provider started itself, not yet
   * running): a call waits for it, so it acts as that run and not as the one that just ended.
   */
  awaitLiveRun?(threadId: string): Promise<LiveRunGate | undefined> | undefined
  /** SPEC §12.6 tool ledger of the caller's run, for MCP calls; undefined skips it. */
  toolLedger?(runId: string): ToolLedger | undefined
  /** The thread is a read-only (`shared`) delegated child; it may call only `reads` and `readOnlySafe` tools. */
  readOnlyThread?(threadId: string): boolean
  /** The ceiling a thread's delegations gave it, whatever its current turn's mode (the stable listing). */
  threadCeiling?(threadId: string): ModeCeiling
  /** The thread's role when it is a personal bot's thread; bot tools are listed only there. */
  botRole?(threadId: string): 'activation' | 'context' | 'subagent' | undefined
  /** The turns registered by the `turn.start` executor; MCP calls act only inside one. */
  turns?: AppToolTurns
  /**
   * The permission mode the caller's run enforces, from its attempt's binding (never from the mode
   * ceiling). Without it, or when it knows no mode, an `editsWorkspace` or `changesSettings` tool asks as under Ask:
   * a missing mode never lets a change through unasked.
   */
  permissionModeFor?(runId: string): PermissionMode | undefined
  /** Asks the thread's user to approve a call (an approval request: see `ApprovalTag`). */
  askApproval?(threadId: string, questions: PendingUserQuestions['questions'], options: { signal: AbortSignal; approval: ApprovalTag }): Promise<UserQuestionAnswers>
  /** Without it a `readsOthers` or `managesOthers` tool reaches the caller's own thread only. */
  access?: ToolAccessPolicy
  /**
   * The user's own MCP servers, proxied for a runtime Mousse sends its tools to per turn (a driver
   * with `userMcp: 'proxy'`: Pi's agent). Without it no user MCP tool is listed or called.
   */
  userMcp?: UserMcpProxy
  /**
   * A personal bot's MCP calls (`BotMcp.call`): on Pi, a bot turn is offered its granted MCP tools through the proxy
   * above, and each call runs here once its grant allows it. Absent: no bot turn is offered one.
   */
  botMcp?: Pick<BotMcp, 'call'>
}

/** `ToolRegistryOptions.userMcp`: the profile's `McpManager`, as the registry uses it. */
export interface UserMcpProxy {
  list(projectPath: string | undefined, actor: IntegrationActor): Promise<McpToolDescriptor[]>
  allowed(providerName: string, projectPath: string | undefined, actor: IntegrationActor): Promise<{ allowed: boolean; reason?: string }>
  call(providerName: string, args: Record<string, unknown>, projectPath: string | undefined, signal: AbortSignal, actor: IntegrationActor): Promise<McpToolCallResult>
}

/** `UserMcpProxy` over the profile's MCP manager. */
export function userMcpProxy(manager: Pick<McpManager, 'getEnabledTools' | 'isToolCallAllowed' | 'callTool'>): UserMcpProxy {
  return {
    list: (projectPath, actor) => manager.getEnabledTools(projectPath, actor),
    allowed: (name, projectPath, actor) => manager.isToolCallAllowed(name, projectPath, actor),
    call: (name, args, projectPath, signal, actor) => manager.callTool(name, args, projectPath, signal, actor)
  }
}

/** A user MCP tool as a runtime is sent it: its own name and schema, effects unknown (`mutation`). */
export type UserMcpListing = Pick<MousseTool, 'name' | 'description' | 'inputSchema' | 'class'>

/** An MCP result as a tool outcome: its text blocks and readable stand-ins, then its inline images. */
export function userMcpOutcome(result: McpToolCallResult): ToolOutcome {
  const texts: string[] = []
  const images: Array<{ data: string; mimeType: string }> = []
  for (const block of result.content ?? []) {
    if (block.type === 'text') texts.push(block.text)
    else if (block.type === 'image' && block.data) images.push({ data: block.data, mimeType: block.mimeType })
    else if (block.type === 'image') texts.push(`[image ${block.mimeType}${block.bytes ? `, ${block.bytes} bytes` : ''}${block.artifactId ? `; artifact=${block.artifactId}` : ''}]`)
    else if (block.type === 'resource_link') texts.push(`[resource ${block.uri}]`)
    else if (block.type === 'resource') texts.push(block.text ?? `[resource ${block.uri ?? 'untyped'}]`)
    else texts.push(`[${block.rawType}]`)
  }
  if (result.structuredContent !== undefined) texts.push(`structuredContent: ${JSON.stringify(result.structuredContent)}`)
  const text = texts.length ? texts.join('\n') : result.text || (result.isError ? 'The MCP tool returned an error.' : '')
  return { text, ...(result.isError ? { isError: true } : {}), ...(images.length ? { images } : {}) }
}

/** Every property name an input schema declares, at any depth. */
function schemaPropertyNames(schema: unknown, depth = 0): string[] {
  if (!schema || typeof schema !== 'object' || depth > 8) return []
  const out: string[] = []
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    if (key === 'properties' && value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [name, inner] of Object.entries(value as Record<string, unknown>)) out.push(name, ...schemaPropertyNames(inner, depth + 1))
    } else out.push(...schemaPropertyNames(value, depth + 1))
  }
  return out
}

/**
 * The thread-id inputs of a tool the central check does not cover. The check reads `threadId` of a
 * `readsOthers`, `managesOthers`, `writesThreads` or `editsWorkspace` tool; any other input that names a thread
 * (`sourceThreadId`, `threadIds`, ...) and `threadId` of any other class must be declared as checked
 * by the handler (`threadArgChecked`), so a new tool cannot read another thread by accident.
 */
function uncoveredThreadArgs(tool: MousseTool): string[] {
  if (tool.threadArgChecked?.trim()) return []
  const covered = tool.access === 'readsOthers' || tool.access === 'managesOthers' || tool.access === 'writesThreads' || tool.access === 'editsWorkspace'
  return [...new Set(schemaPropertyNames(tool.inputSchema))].filter((name) => {
    if (!/^(?:\w*ThreadIds?|threadIds?)$/i.test(name)) return false
    return !(name === 'threadId' && covered)
  })
}

/**
 * The tools that change nothing: they read, list, search or wait. Every other tool declares `clientRequestId`
 * (docs/plans/tool-api.md §1.2 "Retry"); a tool's `class` cannot say which, since `read` also covers writes to the
 * caller's own state (§6, finding 6).
 */
export const READ_ONLY_TOOL_NAMES: ReadonlySet<string> = new Set([
  'task_status', 'list_subagents', 'list_computers', 'list_models', 'list_tasks',
  'thread_read', 'thread_list', 'thread_search', 'thread_wait', 'queue_list', 'schedule_list', 'terminal_read',
  'automation_list', 'list_skills', 'load_skill', 'tool_catalogue', 'mcp_servers', 'theme_read',
  'web_search', 'web_fetch', 'browser_observe', 'browser_find', 'browser_wait', 'browser_extract', 'browser_screenshot',
  'mousse_gui_screenshot', 'mousse_gui_console', 'mousse_gui_status',
  'bot_list', 'bot_schedule_list', 'work_models', 'work_list', 'watch_list', 'reminder_list', 'subagent_wait', 'subagent_result',
  'memory_search', 'memory_read', 'memory_list',
  'profiler_overview', 'profiler_service_breakdown', 'profiler_window_breakdown', 'profiler_gpu_hints', 'profiler_children',
  'profiler_sample_now', 'profiler_watch', 'profiler_heap_summary'
])

/** `clientRequestId` as a tool that does not keep its first result declares it: the key a retry reuses. */
const RETRY_KEY_SCHEMA: JsonSchema = {
  type: 'string',
  description: 'Reuse only to retry the same call.'
}

/** Each schema with `clientRequestId` added, kept so a schema read twice is the same object. */
const retryKeyed = new WeakMap<object, JsonSchema>()

/** `schema` with `clientRequestId` among its properties, when it is an object schema that does not have it yet. */
function withRetryKey<T extends JsonSchema | undefined>(schema: T): T {
  if (!schema || typeof schema !== 'object') return schema
  const properties = (schema as { properties?: Record<string, JsonSchema> }).properties
  if ((schema as { type?: unknown }).type !== 'object' || properties?.clientRequestId) return schema
  let keyed = retryKeyed.get(schema)
  if (!keyed) {
    keyed = { ...schema, properties: { ...(properties ?? {}), clientRequestId: RETRY_KEY_SCHEMA } } as JsonSchema
    retryKeyed.set(schema, keyed)
  }
  return keyed as T
}

/**
 * A tool as it is registered: one that changes something declares `clientRequestId` in its input schemas. A view
 * over the tool rather than a copy, so a schema or description the tool computes when read (the schedule tools'
 * limits) stays current.
 */
function declaringRetryKey(tool: MousseTool): MousseTool {
  if (READ_ONLY_TOOL_NAMES.has(tool.name)) return tool
  return new Proxy(tool, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver)
      return key === 'inputSchema' || key === 'botInputSchema' ? withRetryKey(value as JsonSchema | undefined) : value
    }
  })
}

/** Where a call stands once its turn is known (`ToolRegistry.call`). */
interface CallSite {
  threadId: string
  active: string
  turn: AppToolTurn
  credential: McpCredentialAuthority
  boundToken: string
  request: McpCallRequest
}

function notLive(message: string): McpToolError {
  return new McpToolError('mousse_caller_not_live', message)
}

/** A tool as a personal bot's thread reads it: its `botDescription` and `botInputSchema` where it has them. */
function asBotTool(tool: MousseTool): MousseTool {
  return tool.botDescription || tool.botInputSchema
    ? { ...tool, ...(tool.botDescription ? { description: tool.botDescription } : {}), ...(tool.botInputSchema ? { inputSchema: tool.botInputSchema } : {}) }
    : tool
}

/**
 * The tool a `use_tool` call names and its arguments, with the `clientRequestId` a retry gives taken out of them as
 * Mousse's MCP server takes it out of a direct call; or why the call is malformed.
 */
function useToolCall(args: Record<string, unknown>): { name: string; args: Record<string, unknown>; clientRequestId?: string } | { refused: string } {
  const name = typeof args.tool === 'string' ? args.tool.trim().replace(/^mcp__mousse__/, '') : ''
  if (!name) return { refused: 'use_tool needs tool: the name of a tool from tool_catalogue.' }
  const given = args.arguments ?? {}
  if (typeof given !== 'object' || given === null || Array.isArray(given)) return { refused: 'use_tool needs arguments as an object: the arguments of the tool it names.' }
  const { clientRequestId, ...rest } = given as Record<string, unknown>
  return { name, args: rest, ...(typeof clientRequestId === 'string' && clientRequestId.trim() ? { clientRequestId: clientRequestId.trim() } : {}) }
}

/**
 * Tool name → schema, access class, availability and handler, for both transports (PR 2 §2): the
 * Mousse MCP server lists and calls through it with a credential's authority, and the pi loop calls
 * it in process with its own. A caller is never re-pointed to another run: an MCP credential acts
 * only for the run it is bound to, inside that run's registered turn, and a `per_call` runtime's
 * calls must carry that turn's token.
 */
export class ToolRegistry {
  private readonly tools = new Map<string, MousseTool>()
  /**
   * The user MCP tools each run's turn was offered, by the name it was offered them under: a call
   * resolves from here and never lists again (a new listing may name a tool differently).
   */
  private readonly offeredUserMcp = new Map<string, { turn: AppToolTurn; tools: Map<string, McpToolDescriptor> }>()

  constructor(private readonly options: ToolRegistryOptions) {}

  register(tool: MousseTool): this {
    if (!tool || typeof tool.name !== 'string' || !tool.name) throw new Error('A Mousse tool needs a name')
    if (!ACCESS_CLASSES.has(tool.access as string))
      throw new Error(`Mousse tool ${tool.name} has no access class (reads | readsOthers | actsAsCaller | writesThreads | startsThreads | editsWorkspace | managesOthers)`)
    if (!TOOL_CLASSES.has(tool.class as string)) throw new Error(`Mousse tool ${tool.name} has no class (read | mutation | delegation)`)
    if (typeof tool.handler !== 'function') throw new Error(`Mousse tool ${tool.name} has no handler`)
    const uncovered = uncoveredThreadArgs(tool)
    if (uncovered.length)
      throw new Error(
        `Mousse tool ${tool.name} takes a thread id (${uncovered.join(', ')}) that the access check does not cover: make it readsOthers, managesOthers, writesThreads or editsWorkspace (for threadId), or say where it is checked with threadArgChecked`
      )
    if (this.tools.has(tool.name)) throw new Error(`Mousse tool ${tool.name} is already registered`)
    this.tools.set(tool.name, declaringRetryKey(tool))
    return this
  }

  get(name: string): MousseTool | undefined {
    return this.tools.get(name)
  }

  /** Every registered tool, hidden ones included. */
  list(): MousseTool[] {
    return [...this.tools.values()]
  }

  /**
   * The ListTools result of a thread's credential (PR 2 §2 "Tool lists across turns"): stable for
   * the thread, whatever the turn's mode, so a list a runtime cached on a plan turn still works on
   * the next agent turn. What a turn may use is checked at call time.
   */
  listFor(listing: ToolListing): MousseTool[] {
    return this.list().filter((tool) => {
      if (tool.hidden) return false
      if (listing.readOnly && tool.access !== 'reads' && tool.access !== 'readsOthers' && !tool.readOnlySafe) return false
      if (listing.modeCeiling === 'plan' && (tool.access === 'startsThreads' || tool.access === 'changesSettings')) return false
      // A bot's main thread lists the thread tools its grant allows: "use your threads" is what lets it use them. Only
      // those its turn holds now are listed (none without the permission, with the switch off, or in a turn that only
      // reads), and every call is held to it again. A consult never has them. The profiler's tools likewise follow "use
      // the profiler": listed only when the turn holds them (and, as for anyone, while Labs lets agents read it). So do
      // the theme tools, under "change how Mousse looks", scheduled jobs, secrets, quick actions and the task list. A
      // subagent holds only what a thread's subagent may use (`compileBotThread`), and a consult none of them.
      const botHeldTool = listing.botRole !== undefined && isBotTurnHeldTool(tool.name)
      if (botHeldTool && (listing.botRole === 'context' || !listing.botTurnTools?.has(tool.name))) return false
      // A bot's thread lists only what a bot can hold: the model is never shown delegation, queues or tools it can't use.
      if (listing.botRole && !botMayBeOffered(tool.name)) return false
      // A catalogue turn on Codex or Pi (docs/plans/bot-context.md §15) lists the core set only: the rest is looked up with
      // `tool_catalogue` and called through `use_tool`, so the list never changes with what the bot looks up.
      if (listing.botCatalogue === 'use_tool' && !botCoreTool(tool.name)) return false
      return tool.listed?.(listing) ?? true
    })
  }

  /** Whether `threadId` is a personal bot's thread. */
  isBotThread(threadId: string): boolean {
    return this.botListing(threadId).botRole !== undefined
  }

  /**
   * `listFor` a thread: its read-only status and the ceiling its delegations gave it, never the
   * current turn's mode (a Plan turn's narrower ceiling is enforced at call time). `fallback` is the
   * ceiling when the owner does not say.
   */
  listForThread(threadId: string, fallback: ModeCeiling = 'default', runId?: string): MousseTool[] {
    const bot = this.botListing(threadId)
    // A bot's thread tools follow its turn: what the run's registered turn holds now.
    const turn = bot.botRole && runId ? this.options.turns?.get(runId) : undefined
    const listed = this.listFor({
      threadId,
      readOnly: this.options.readOnlyThread?.(threadId) === true,
      modeCeiling: this.options.threadCeiling?.(threadId) ?? fallback,
      ...bot,
      ...(turn?.bot && turn.threadId === threadId ? { botTurnTools: turn.bot.appTools, ...(turn.bot.catalogue ? { botCatalogue: turn.bot.catalogue } : {}) } : {})
    })
    // A bot's thread reads each tool as a bot uses it.
    return bot.botRole ? listed.map(asBotTool) : listed
  }

  /**
   * The tools of a bot turn's catalogue it holds now, as a bot reads them (`tool_catalogue`): every tool of `names` the
   * thread would list without the catalogue, in the order given.
   */
  catalogued(threadId: string, turn: AppToolTurn, names: readonly string[]): MousseTool[] {
    const bot = this.botListing(threadId)
    if (!bot.botRole || !turn.bot) return []
    const listed = new Map(this.listFor({
      threadId,
      readOnly: this.options.readOnlyThread?.(threadId) === true,
      modeCeiling: this.options.threadCeiling?.(threadId) ?? 'default',
      ...bot,
      botTurnTools: turn.bot.appTools
    }).map((tool) => [tool.name, asBotTool(tool)]))
    return names.flatMap((name) => listed.get(name) ?? [])
  }

  /**
   * The tools a runtime that takes its tool list per turn is sent for `runId` (the Pi RPC engine).
   * A definition's turn gets them as the definition loop sends them: each with the schema the turn
   * is offered (`definition`: the browser's follows the turn's binding, its vision and backend), and
   * none the turn is not offered (`offered`: a browser tool outside the binding, or a screenshot a
   * model without vision cannot see). Any other turn gets the thread's stable listing.
   */
  listForTurn(threadId: string, runId: string | undefined): Array<Pick<MousseTool, 'name' | 'description' | 'inputSchema' | 'class'>> {
    const listed = this.listForThread(threadId, 'default', runId)
    const turn = runId ? this.options.turns?.get(runId) : undefined
    const plain = (tool: MousseTool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema, class: tool.class })
    if (!turn?.definition || turn.threadId !== threadId) return listed.map(plain)
    return listed
      .filter((tool) => !tool.offered || tool.offered(turn))
      .map((tool) => {
        const offered = tool.definition?.(turn)
        return offered ? { ...plain(tool), description: offered.description, inputSchema: plainSchema(offered) } : plain(tool)
      })
  }

  /**
   * The user's own MCP tools a turn is offered (`userMcp: 'proxy'` runtimes), as the in-process loop
   * offered them: the turn's actor's enabled tools in its project; a definition's granted ones only;
   * none for a bot's turn, nor for the main agent in a build mode (its tools are the mode's); and in
   * a read-only child only those its workspace capability allows.
   */
  async userMcpForTurn(threadId: string, runId: string | undefined): Promise<McpToolDescriptor[]> {
    const proxy = this.options.userMcp
    const turn = runId ? this.options.turns?.get(runId) : undefined
    if (!proxy || !turn || turn.threadId !== threadId) return []
    // A bot's turn: only the granted tools it was offered (none in a chat turn), each held to its grant when called.
    if (turn.bot) {
      if (!this.options.botMcp) return []
      return (turn.bot.mcpTools ?? []).filter((tool) => !this.tools.has(tool.providerName)).map((tool) => ({
        id: `${tool.server}:${tool.tool}`, serverId: tool.server, installationId: tool.server, serverName: tool.serverName, toolName: tool.tool,
        providerName: tool.providerName, description: tool.description, inputSchema: tool.inputSchema
      }))
    }
    let tools: readonly McpToolDescriptor[]
    if (turn.definition) tools = turn.definition.mcpTools ?? []
    else if (turn.modeFacts.build && !turn.subagent) return []
    else {
      try {
        tools = await proxy.list(turn.projectPath, turn.actor)
      } catch (error) {
        console.warn('[mcp] the user MCP tools could not be listed for the turn', { threadId, error: error instanceof Error ? error.message : String(error) })
        return []
      }
    }
    const readOnly = this.options.readOnlyThread?.(threadId) === true
    const offered = tools.filter((tool) => !this.tools.has(tool.providerName) && (!readOnly || turn.toolAccess?.allows(tool.providerName) === true))
    this.rememberOffered(runId!, turn, offered)
    return offered
  }

  /** Keeps what `runId`'s turn was offered (added to an earlier listing of the same turn), and drops ended runs'. */
  private rememberOffered(runId: string, turn: AppToolTurn, tools: readonly McpToolDescriptor[]): void {
    for (const [id, entry] of this.offeredUserMcp) if (this.options.turns?.get(id) !== entry.turn) this.offeredUserMcp.delete(id)
    const current = this.offeredUserMcp.get(runId)
    const map = current?.turn === turn ? current.tools : new Map<string, McpToolDescriptor>()
    for (const tool of tools) map.set(tool.providerName, tool)
    this.offeredUserMcp.set(runId, { turn, tools: map })
  }

  /** The user MCP tool `name` as the run's current turn was offered it, without listing again. */
  private offeredTool(runId: string, turn: AppToolTurn, name: string): McpToolDescriptor | undefined {
    const entry = this.offeredUserMcp.get(runId)
    if (entry?.turn === turn) return entry.tools.get(name)
    // A definition's tools are fixed for its run: what it was granted, never listed again.
    return turn.definition?.mcpTools?.find((tool) => tool.providerName === name && !this.tools.has(name))
  }

  /** `userMcpForTurn` as a runtime is sent the tools. */
  async userMcpListingForTurn(threadId: string, runId: string | undefined): Promise<UserMcpListing[]> {
    return (await this.userMcpForTurn(threadId, runId)).map((tool) => ({
      name: tool.providerName,
      description: tool.description || `Call ${tool.toolName} on MCP server ${tool.serverName}.`,
      inputSchema: tool.inputSchema && (tool.inputSchema as { type?: unknown }).type === 'object' ? tool.inputSchema : { type: 'object', additionalProperties: true },
      class: 'mutation'
    }))
  }

  private botListing(threadId: string): { botRole?: 'activation' | 'context' | 'subagent' } {
    try {
      const role = this.options.botRole?.(threadId)
      return role ? { botRole: role } : {}
    } catch {
      return {}
    }
  }

  /** The tools an in-process loop offers this turn, in registration order (none that a `never` run refuses). */
  offeredFor(turn: AppToolTurn): MousseTool[] {
    return this.list().filter((tool) => (tool.offered ? tool.offered(turn) : tool.available?.(turn) ?? true) === true && !unattendedRefusal(tool, turn))
  }

  /**
   * A call over the Mousse MCP server, under the credential the request's bearer resolved to.
   * A refused call is an error result in the refusal shape (`refusal.ts`); refusals before the
   * handler write no ledger row. Only the faults (`REFUSAL_FAULT_CODES`: the credential's turn is
   * over, no such tool) are thrown as `McpToolError`s, which the server sends as JSON-RPC errors.
   */
  async call(name: string, rawArgs: Record<string, unknown>, request: McpCallRequest): Promise<ToolOutcome> {
    const registered = this.tools.get(name)
    const tool = registered && !registered.hidden ? registered : undefined
    // Any other name can only be one of the turn's proxied user MCP tools, looked up once the turn is known.
    if (!tool && (registered || !this.options.userMcp)) throw new McpToolError('mousse_unknown_tool', `No Mousse tool named ${name}.`)
    const { threadId, active, turn, args, caller, boundToken } = await this.admit(rawArgs, request)
    const { credential } = request
    const site: CallSite = { threadId, active, turn, credential, boundToken, request }
    try {
      // A catalogue turn's call of a catalogued tool (docs/plans/bot-context.md §15): the tool it names runs exactly as if
      // it were called directly, through every check below. That is a Mousse tool, or one of the owner's MCP tools the
      // turn was offered, which goes through the same dispatcher (grant, masking, asks first) as its direct call.
      if (name === BOT_USE_TOOL && turn.bot?.catalogue === 'use_tool') {
        const inner = useToolCall(args)
        if ('refused' in inner) return refused('invalid_arguments', inner.refused)
        const innerRequest = inner.clientRequestId ? { ...request, toolCallId: `mcp:${inner.clientRequestId}` } : request
        const named = this.tools.get(inner.name)
        if (!named && this.options.userMcp && turn.bot.mcpTools?.some((offered) => offered.providerName === inner.name))
          return await this.callUserMcp(inner.name, inner.args, { ...site, request: innerRequest })
        if (!named || named.hidden || inner.name === BOT_USE_TOOL || !botMayBeOffered(inner.name))
          return refused('unknown_tool', `You have no tool named ${inner.name}. tool_catalogue lists each group's tools.`)
        return await this.callAdmitted(inner.name, named, inner.args, caller, { ...site, request: innerRequest })
      }
      if (!tool) return await this.callUserMcp(name, args, site)
      return await this.callAdmitted(name, tool, args, caller, site)
    } catch (error) {
      const outcome = refusalOutcome(error)
      if (outcome) return outcome
      throw error
    }
  }

  /** A call of the app tool `tool`, admitted (`admit`): the bot's grant, scope, availability, approvals, then its handler. */
  private async callAdmitted(name: string, tool: MousseTool, args: Record<string, unknown>, caller: McpCaller, site: CallSite): Promise<ToolOutcome> {
    const { threadId, active, turn, credential, boundToken, request } = site
    // A bot's thread tool ("use your threads"): its grant first, which this turn holds only in the lanes that may use the
    // tool and only while this computer allows it (a refusal there is the bot's ask, never a scope error), then where the
    // call may reach, decided by the bot's rules.
    const botThreads = turn.bot !== undefined && isBotThreadTool(name)
    if (botThreads) {
      const refusal = botAppToolRefusal(turn.bot!, name, args)
      if (refusal) return refused('not_granted', refusal)
    }
    // Scope is checked first: a refused call asks nobody anything and leaves no ledger row.
    const scope = botThreads ? this.botThreadScope(tool, args, caller) : this.authorize(tool, args, caller, this.options.readOnlyThread?.(threadId) === true)
    // A bot's thread lists the browser tools whatever it holds: one its owner has not allowed says so, and how to ask,
    // not that no browser is bound to the turn. One the owner allowed after the turn started is answered as held: the
    // bot is not sent to ask again, and its turn continues with the browser once it ends.
    if (turn.bot && botBrowserWithheld(turn.bot, name)) return refused('not_granted', turn.bot.held?.({ tool: name }) ?? botBrowserNotAllowed(turn.bot))
    const availability = tool.available?.(turn) ?? true
    if (availability !== true) return refused('unavailable', availability)
    const unattended = unattendedRefusal(tool, turn)
    if (unattended) return refused('needs_person', unattended)
    // A bot turn: every app tool is held to the bot's grant, on every call (a list cached before a
    // narrower revision cannot reach a removed tool). Nobody is asked. A thread tool was checked above.
    if (turn.bot && !botThreads) {
      const refusal = botAppToolRefusal(turn.bot, name, args)
      if (refusal) return refused('not_granted', refusal)
    }
    // A definition run: its grants, policy and approvals hold for every call, as in the in-process loop.
    // A call the runtime's gate already authorized in full (approval included, before it was
    // charged) is revalidated without asking again; any other call is authorized here.
    if (turn.definition) {
      const refused = await this.authorizeDefinition(name, args, { threadId, active, turn, credential, boundToken, request })
      if (refused) return refused
    }
    // A tool that changes the workspace asks first unless the run's permission mode allows edits (a
    // definition run is held to its own grants above); a rejection ends the call before its handler
    // runs and writes no ledger row. A bot's call of a tool its grant answers (`botGrantAnswers`) asks nobody: the
    // grant, checked above, is its owner's answer.
    if ((tool.access === 'editsWorkspace' || tool.access === 'changesSettings') && !turn.definition && !(turn.bot && tool.botGrantAnswers)) {
      const refusal = await this.askBeforeEditing(tool, caller, request.signal, args, undefined, turn.approvals === 'never')
      if (refusal) return refusal
    }
    const ctx: ToolCallContext = { caller, turn, toolCallId: request.toolCallId, signal: request.signal, transport: 'mcp', ...(scope ? { scope } : {}) }
    const ledger = this.options.toolLedger?.(active)
    const ledgerId = ledger?.start({ type: 'toolCall', id: ctx.toolCallId, name, arguments: args } as ToolCall)
    let outcome: ToolOutcome
    try {
      outcome = await this.runHandler(tool, args, ctx, turn.toolAccess)
    } catch (error) {
      if (ledgerId) ledger?.failed(ledgerId)
      if (error instanceof McpToolError) throw error
      return refused('failed', error instanceof Error ? error.message : String(error))
    }
    if (ledgerId) {
      if (outcome.isError) ledger?.failed(ledgerId)
      else ledger?.commit(ledgerId)
    }
    // A handler's own error result says why in words: it is put in the refusal shape here, once for every tool.
    return asRefusal(outcome)
  }

  /**
   * The checks every call over MCP passes before anything about its tool: the thread has an active
   * run, the credential is current and acts for that run (or a run the owner says it waited for),
   * the run's turn is registered, and a `per_call` runtime's call carries that turn's token. Returns
   * where the call stands, with the turn and attempt tokens taken out of its arguments. The MCP relay
   * admits its calls here too.
   */
  async admit(rawArgs: Record<string, unknown>, request: McpCallRequest): Promise<RelayAdmission> {
    const { credential } = request
    const threadId = credential.threadId
    const gate = await this.options.awaitLiveRun?.(threadId)
    const active = this.options.activeRunId(threadId)
    // A call that waited for a particular run acts as that run or not at all: never as another one that
    // happens to be active (a person's turn stuck in its sign-in check, say).
    if (gate && (gate.runId === null || gate.runId !== active))
      throw notLive(`The turn the runtime started for thread ${threadId} did not become active; its tools are closed.`)
    if (!active) throw notLive(`Thread ${threadId} has no active run; its tools are closed until the next turn.`)
    if (!credential.current()) throw notLive(`This credential of thread ${threadId} was replaced; its tools are closed.`)
    // The credential acts for its own run only. A gate is the thread owner's word that the waiting
    // call belongs to the run that became active (a turn the runtime started itself).
    if (credential.runId !== active && !gate) throw notLive(`This credential belongs to an earlier turn of thread ${threadId}; its tools are closed.`)
    const turn = this.options.turns?.get(active)
    if (!turn) throw notLive(`The turn of thread ${threadId} is not running; its tools are closed.`)
    const args = { ...rawArgs }
    const turnToken = args[TURN_TOKEN_KEY]
    const attemptToken = args[ATTEMPT_TOKEN_KEY]
    delete args[TURN_TOKEN_KEY]
    delete args[ATTEMPT_TOKEN_KEY]
    // The token the call is bound to: the attempt's when it carries one, else the turn's.
    const boundToken = turn.attemptToken !== undefined && attemptToken !== undefined ? turn.attemptToken : turn.turnToken
    if (credential.binding === 'per_call') {
      const tagged = turn.attemptToken !== undefined && attemptToken !== undefined
        ? attemptToken === turn.attemptToken
        : turnToken === turn.turnToken
      if (!tagged) throw notLive(`This call was made for an earlier turn of thread ${threadId}; it was not run.`)
    }
    const caller: McpCaller = { threadId, runId: active, provider: credential.provider, modeCeiling: credential.modeCeiling, accessLevel: credential.accessLevel }
    return { threadId, active, turn, args, caller, boundToken }
  }

  /**
   * A definition run's call: its grants, policy and approvals. A call the runtime's gate already
   * authorized in full (approval included, before it was charged) is revalidated without asking
   * again; any other call is authorized here. The run is checked again right before the tool runs,
   * since it may have ended while the approval waited. Returns the refusal, or undefined to run.
   */
  private async authorizeDefinition(name: string, args: Record<string, unknown>, at: CallSite): Promise<ToolOutcome | undefined> {
    const { threadId, active, turn, credential, boundToken, request } = at
    const definition = turn.definition!
    const callId = request.toolCallId.startsWith('mcp:') ? request.toolCallId.slice('mcp:'.length) : request.toolCallId
    // Transport fields are not part of the call, here as at the gate.
    const checked = withoutTransportFields(args)
    const projectPath = turn.projectPath ? { projectPath: turn.projectPath } : {}
    // A per-call runtime's gate authorized this exact call (turn, tool, call id, arguments).
    const handedOver = credential.binding === 'per_call' && takeAuthorizedCall(definition, { turnToken: boundToken, toolName: name, callId, args: checked })
    if (handedOver) {
      const refusal = definitionRefusal(definition, { toolName: name, args: checked, ...projectPath })
      if (refusal) return refused('not_granted', refusal)
      if (request.signal.aborted) return refused('cancelled', 'Tool dispatch cancelled immediately before side effects.')
    } else {
      const decision = await authorizeDefinitionCall(definition, { toolName: name, args: checked, ...projectPath, signal: request.signal })
      if (!decision.allowed) return refused('not_granted', decision.message)
    }
    if (this.options.activeRunId(threadId) !== active || this.options.turns?.get(active) !== turn || !credential.current())
      throw notLive(`Run ${active} is no longer the active run of thread ${threadId}; the tool was not run.`)
    return undefined
  }

  /**
   * A call of one of the turn's proxied user MCP tools (`userMcpForTurn`), held to what an app tool
   * is held to: the turn's liveness (checked by the caller), a definition's grants and approvals,
   * the actor's grant at call time and the run's tool ledger.
   */
  private async callUserMcp(name: string, args: Record<string, unknown>, at: CallSite): Promise<ToolOutcome> {
    const { active, turn, request } = at
    const proxy = this.options.userMcp!
    if (turn.bot) return this.callBotMcp(turn.bot, name, args, at)
    const tool = this.offeredTool(active, turn, name)
    if (!tool) throw new McpToolError('mousse_unknown_tool', `No Mousse tool named ${name}.`)
    if (turn.definition) {
      const refused = await this.authorizeDefinition(name, args, at)
      if (refused) return refused
    }
    const checked = withoutTransportFields(args)
    const allowed = await proxy.allowed(name, turn.projectPath, turn.actor)
    if (!allowed.allowed) return refused('not_granted', allowed.reason ?? 'MCP tool is not enabled for this actor.')
    const ledger = this.options.toolLedger?.(active)
    const ledgerId = ledger?.start({ type: 'toolCall', id: request.toolCallId, name, arguments: checked } as ToolCall)
    let outcome: ToolOutcome
    try {
      outcome = userMcpOutcome(await proxy.call(name, checked, turn.projectPath, request.signal, turn.actor))
    } catch (error) {
      if (ledgerId) ledger?.failed(ledgerId)
      return { text: error instanceof Error ? error.message : String(error), isError: true }
    }
    if (ledgerId) {
      if (outcome.isError) ledger?.failed(ledgerId)
      else ledger?.commit(ledgerId)
    }
    return outcome
  }

  /**
   * A bot turn's call of one of its owner's MCP tools on Pi (`callForBot`): only a tool the turn was offered runs, after
   * the bot's authority allows it, on the owner's connection, within the turn's stop signal and deadline. Its ledger
   * row is written like any proxied call's.
   */
  private async callBotMcp(bot: NonNullable<AppToolTurn['bot']>, name: string, args: Record<string, unknown>, at: CallSite): Promise<ToolOutcome> {
    const mcp = this.options.botMcp
    if (!mcp || !bot.mcpTools?.some((tool) => tool.providerName === name)) throw new McpToolError('mousse_unknown_tool', `No Mousse tool named ${name}.`)
    const checked = withoutTransportFields(args)
    const ledger = this.options.toolLedger?.(at.active)
    const ledgerId = ledger?.start({ type: 'toolCall', id: at.request.toolCallId, name, arguments: bot.maskMcpArguments?.(checked) ?? checked } as ToolCall)
    const outcome = await callForBot({ bot, name, args: checked, toolCallId: at.request.toolCallId, signal: at.request.signal, mcp, images: at.turn.toolImages === true })
    if (ledgerId) {
      if (outcome.isError) ledger?.failed(ledgerId)
      else ledger?.commit(ledgerId)
    }
    return outcome
  }

  /**
   * Read-only children, thread scope and the plan ceiling, before anything runs. Returns how the caller reaches the target of a `readsOthers` or `managesOthers` tool.
   */
  private authorize(tool: MousseTool, args: Record<string, unknown>, caller: McpCaller, readOnly: boolean): ToolScope | undefined {
    if (tool.access !== 'reads' && tool.access !== 'readsOthers' && !tool.readOnlySafe && readOnly)
      throw new McpToolError('mousse_read_only', `${tool.name} can change threads or the workspace; a read-only subagent cannot call it.`)
    // Scope before any approval: a call refused for naming another thread must not prompt the user first.
    if (tool.access === 'writesThreads' || tool.access === 'editsWorkspace') callerThreadOnly(args, caller)
    if (tool.access === 'startsThreads' && caller.modeCeiling === 'plan')
      throw new McpToolError('mousse_ceiling_exceeded', `${tool.name} starts threads; a plan ceiling cannot.`)
    if (tool.access === 'changesSettings' && caller.modeCeiling === 'plan')
      throw new McpToolError('mousse_ceiling_exceeded', `${tool.name} changes settings; a plan ceiling cannot.`)
    return tool.access === 'readsOthers' || tool.access === 'managesOthers' ? this.checkOthers(tool, args, caller) : undefined
  }

  /**
   * The central check of `readsOthers` and `managesOthers` tools (SPEC §15.1): how the caller reaches
   * the target, or `mousse_scope_denied`. Every agent may read and manage every thread; what stays out
   * of reach is a thread that does not exist and, across the private line, a private thread. A thread
   * the caller may not reach is refused the same way whether it exists or not.
   */
  private checkOthers(tool: MousseTool, args: Record<string, unknown>, caller: McpCaller): ToolScope {
    const target = tool.target ? tool.target(args, caller) : { threadId: args.threadId as string | undefined }
    if (!target) return 'own'
    if (target.threadId !== undefined && (typeof target.threadId !== 'string' || !target.threadId))
      throw new McpToolError('mousse_scope_denied', 'threadId must be a non-empty string.')
    if (target.threadId === undefined && !tool.target) return 'own'
    if (target.threadId === caller.threadId) return 'own'
    const manages = tool.access === 'managesOthers'
    const policy = this.options.access
    // A private thread's content stays out of shared threads (their content reaches the user's other devices):
    // a shared thread's agent never sees a private thread, and a private thread's agent never sends to or changes a shared one.
    if (target.threadId !== undefined && policy?.localOnly) {
      const callerPrivate = policy.localOnly(caller.threadId)
      const targetPrivate = policy.localOnly(target.threadId)
      if (targetPrivate && !callerPrivate)
        throw new McpToolError('mousse_scope_denied', `Thread ${target.threadId} is not available to this credential.`)
      if (callerPrivate && !targetPrivate && manages)
        throw new McpToolError('mousse_scope_denied', 'This is a private thread: its agents cannot send to or change a thread that is shared with the user\'s other devices.')
    }
    if (target.threadId === undefined) {
      // A listing; the handler filters what it returns.
      if (!policy) throw new McpToolError('mousse_scope_denied', `${tool.name} is not available here.`)
      return 'manage'
    }
    let relation: ThreadRelation | null = null
    try {
      relation = policy?.relation(caller, target.threadId) ?? null
    } catch {
      relation = null
    }
    // A thread the caller launched keeps that scope for the tools that treat it apart.
    if (manages && relation === 'launched' && tool.launchedOk) return 'launched'
    let exists = false
    try {
      exists = Boolean(policy?.threadExists(target.threadId))
    } catch {
      exists = false
    }
    if (exists) return 'manage'
    if (!manages && relation) return relation
    throw new McpToolError('mousse_scope_denied', `Thread ${target.threadId} is not available to this credential.`)
  }

  /**
   * Where a bot's thread tool may reach (`"use your threads"`, already held by the turn), by the one rule its list,
   * search and handlers follow too (`ToolAccessPolicy.botReach`, `botThreadReach`): the owner's ordinary threads of its
   * projects, and the threads it started. Never its own chat or any bot's thread, the Automation manager's, a private
   * thread or a subagent; a thread that does not exist is refused in the same words. Its scope is `manage` (the bot reads
   * transcripts, bounded by the handler) or `launched` for one it started that is out of its projects.
   */
  private botThreadScope(tool: MousseTool, args: Record<string, unknown>, caller: McpCaller): ToolScope {
    const target = tool.target ? tool.target(args, caller) : { threadId: args.threadId as string | undefined }
    const policy = this.options.access
    if (!policy?.botReach) throw new McpToolError('mousse_scope_denied', `${tool.name} is not available here.`)
    if (!target || (target.threadId === undefined && target.projectId === undefined)) return 'manage'
    if (target.threadId !== undefined && (typeof target.threadId !== 'string' || !target.threadId))
      throw new McpToolError('mousse_scope_denied', 'threadId must be a non-empty string.')
    let reach: { scope: ToolScope } | { refused: string }
    try {
      // A tool that only reads reaches the subagents below the owner's threads too (#1365).
      reach = policy.botReach(caller, target, { read: tool.class === 'read' })
    } catch {
      reach = { refused: target.threadId ? `Thread ${target.threadId} is not available to you.` : `${tool.name} is not available for this project.` }
    }
    if ('refused' in reach) throw new McpToolError('mousse_scope_denied', reach.refused)
    return reach.scope
  }

  /**
   * The outcome a rejected `editsWorkspace` or `changesSettings` call gets instead of running: null when the call may go
   * ahead (the run's permission mode allows edits, or the user allowed it once). An owner that cannot
   * ask rejects, and so does a run nobody answers: nothing runs unapproved.
   */
  private async askBeforeEditing(tool: MousseTool, caller: McpCaller, signal: AbortSignal, args: Record<string, unknown>, turnMode?: PermissionMode, unattended = false): Promise<ToolOutcome | null> {
    // An unknown mode is Ask: it fails closed (docs/plans/tool-api.md §1.3).
    const mode = turnMode ?? this.options.permissionModeFor?.(caller.runId) ?? 'ask'
    const needs = tool.runsWithoutAsking?.(args) ?? 'edit'
    if (needs === 'full' ? mode === 'full' : permissionModeAllows(mode, 'edit')) return null
    // A run nobody answers (`approvals: 'never'`) is refused at once rather than waiting for a person.
    if (unattended) return refused('needs_person', APPROVALS_REFUSED_MESSAGE)
    const notApproved = `The user did not approve ${tool.name}, so it did not run. Do not retry it unless they ask.`
    const rejected: ToolOutcome = refused('not_approved', notApproved)
    if (!this.options.askApproval) return rejected
    try {
      const answers = await this.options.askApproval(
        caller.threadId,
        [{
          id: 'permission',
          prompt: (typeof tool.approvalPrompt === 'function' ? tool.approvalPrompt(args) : tool.approvalPrompt) ?? (tool.name === 'thread_merge_back'
            ? "Allow Mousse to hand this fork's work back to the thread it was forked from?"
            : 'Allow this Mousse tool to change files in this workspace?'),
          options: [{ id: 'allow', label: 'Allow once' }, { id: 'reject', label: 'Reject' }]
        }],
        {
          signal,
          approval: {
            action: 'edit',
            permissionKey: tool.permissionKey ?? PERMISSION_KEYS.mousseIntegrate,
            options: [{ id: 'allow', decision: 'allow', scope: 'once' }, { id: 'reject', decision: 'reject' }],
            tool: { name: tool.name, input: args },
            // A call that needs Full access to run unasked is the person's alone: no agent answers it for them.
            ...(needs === 'full' ? { reason: 'Only you can allow this: it needs Full access to run without asking.' } : {})
          }
        }
      )
      if (answers.permission === 'allow' && !signal.aborted) return null
      const why = typeof answers.feedback === 'string' ? answers.feedback.trim().slice(0, 1000) : ''
      return why ? refused('not_approved', `${notApproved} Reason: ${why}`) : rejected
    } catch {
      return rejected
    }
  }

  /**
   * A read-only child's workspace capability (`SHARED_READER_POLICY`) checks the paths of the tools
   * it governs, as in the pi loop; the tools a read-only child may call over MCP stay as listed.
   */
  private runHandler(tool: MousseTool, args: Record<string, unknown>, ctx: ToolCallContext, access: AgentToolAccess | undefined): Promise<ToolOutcome> {
    const run = async (): Promise<ToolOutcome> => tool.handler(args, ctx)
    return access?.allows(tool.name) ? access.execute(tool.name, args, run) : run()
  }
}
