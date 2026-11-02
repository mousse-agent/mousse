import type { ToolCall } from '@earendil-works/pi-ai'
import { PERMISSION_KEYS } from '../../../../shared/permissionKeys'
import { permissionModeAllows, type PermissionMode } from '../../../../shared/permissionMode'
import type { PendingUserQuestions, UserQuestionAnswers } from '../../../../shared/types'
import type { ApprovalTag } from '../../../orchestrator/UserQuestionService'
import { isAgentAccessLevel, narrowAgentAccess, type AgentAccessLevel } from '../../../../shared/settings'
import type { AgentToolAccess } from '../../../agents/WorkspaceAccessPolicy'
import { authorizeDefinitionCall, definitionRefusal, takeAuthorizedCall, withoutTransportFields } from '../../../agentDefinitions/definitionGate'
import { botAppToolRefusal } from '../../../../shared/bots/personal/walls'
import type { McpToolDescriptor } from '../../../../shared/integrations'
import type { IntegrationActor } from '../../../../shared/integrations/actor'
import type { McpToolCallResult } from '../../../../shared/integrations/results'
import type { McpManager } from '../../../integrations/mcp/McpManager'
import type { ModeCeiling } from '../../types'
import type { AppToolTurns } from './turns'
import { callerThreadOnly } from './thread'
import {
  ACCESS_CLASSES,
  levelAtLeast,
  McpToolError,
  plainSchema,
  TOOL_CLASSES,
  unattendedRefusal,
  type AppToolTurn,
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
  /** The level the credential was granted for this run (SPEC §15.1). */
  accessLevel: AgentAccessLevel
  binding: McpTurnBinding
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
 * §15.1). All of it is read at call time, so lowering the profile setting reaches a turn that is
 * already running.
 */
export interface ToolAccessPolicy {
  /** The profile's agent access level as it is now. */
  profileLevel(): AgentAccessLevel
  /** How `threadId` is related to the caller without the access level, or null. */
  relation(caller: McpCaller, threadId: string): ThreadRelation | null
  /** The thread's project (or `projectId`) is in the profile's current project list; an empty list allows all. */
  projectAllowed(target: { threadId?: string; projectId?: string }): boolean
  threadExists(threadId: string): boolean
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
  botRole?(threadId: string): 'activation' | 'context' | undefined
  /** The turns registered by the `turn.start` executor; MCP calls act only inside one. */
  turns?: AppToolTurns
  /**
   * The permission mode the caller's run enforces, from its attempt's binding (never from the mode
   * ceiling). Without it no `editsWorkspace` tool asks.
   */
  permissionModeFor?(runId: string): PermissionMode | undefined
  /** Asks the thread's user to approve a call (an approval request: see `ApprovalTag`). */
  askApproval?(threadId: string, questions: PendingUserQuestions['questions'], options: { signal: AbortSignal; approval: ApprovalTag }): Promise<UserQuestionAnswers>
  /** Without it a `readsOthers` or `managesOthers` tool reaches the caller's own thread only and the effective level is `lineage`. */
  access?: ToolAccessPolicy
  /**
   * The user's own MCP servers, proxied for a runtime Mousse sends its tools to per turn (a driver
   * with `userMcp: 'proxy'`: Pi's agent). Without it no user MCP tool is listed or called.
   */
  userMcp?: UserMcpProxy
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
    this.tools.set(tool.name, tool)
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
      if (listing.modeCeiling === 'plan' && tool.access === 'startsThreads') return false
      if (tool.minLevel && !levelAtLeast(listing.accessLevel ?? 'lineage', tool.minLevel)) return false
      return tool.listed?.(listing) ?? true
    })
  }

  /**
   * `listFor` a thread: its read-only status and the ceiling its delegations gave it, never the
   * current turn's mode (a Plan turn's narrower ceiling is enforced at call time). `fallback` is the
   * ceiling when the owner does not say. `granted` is the level the caller's credential was granted;
   * tools that need a wider effective level are left out.
   */
  listForThread(threadId: string, fallback: ModeCeiling = 'default', granted: AgentAccessLevel = 'lineage'): MousseTool[] {
    return this.listFor({
      readOnly: this.options.readOnlyThread?.(threadId) === true,
      modeCeiling: this.options.threadCeiling?.(threadId) ?? fallback,
      accessLevel: this.effectiveLevel(granted),
      ...this.botListing(threadId)
    })
  }

  /**
   * The tools a runtime that takes its tool list per turn is sent for `runId` (the Pi RPC engine).
   * A definition's turn gets them as the definition loop sends them: each with the schema the turn
   * is offered (`definition`: the browser's follows the turn's binding, its vision and backend), and
   * none the turn is not offered (`offered`: a browser tool outside the binding, or a screenshot a
   * model without vision cannot see). Any other turn gets the thread's stable listing.
   */
  listForTurn(threadId: string, runId: string | undefined, granted: AgentAccessLevel = 'lineage'): Array<Pick<MousseTool, 'name' | 'description' | 'inputSchema' | 'class'>> {
    const listed = this.listForThread(threadId, 'default', granted)
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
    if (!proxy || !turn || turn.threadId !== threadId || turn.bot) return []
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

  private botListing(threadId: string): { botRole?: 'activation' | 'context' } {
    try {
      const role = this.options.botRole?.(threadId)
      return role ? { botRole: role } : {}
    } catch {
      return {}
    }
  }

  /**
   * What a caller granted `granted` may use now: that level narrowed by the profile's setting as it
   * is at this moment (SPEC §15.1), so lowering the setting applies to a running turn at once.
   * Fails closed: an absent or unknown grant, an owner that cannot say what the profile allows, or any
   * error is `lineage`, the most restrictive level.
   */
  effectiveLevel(granted: AgentAccessLevel): AgentAccessLevel {
    try {
      const profile = this.options.access?.profileLevel()
      if (!isAgentAccessLevel(granted) || !isAgentAccessLevel(profile)) return 'lineage'
      return narrowAgentAccess(granted, profile) ?? 'lineage'
    } catch {
      return 'lineage'
    }
  }

  /** The tools an in-process loop offers this turn, in registration order (none that a `never` run refuses). */
  offeredFor(turn: AppToolTurn): MousseTool[] {
    return this.list().filter((tool) => (tool.offered ? tool.offered(turn) : tool.available?.(turn) ?? true) === true && !unattendedRefusal(tool, turn))
  }

  /**
   * A call over the Mousse MCP server, under the credential the request's bearer resolved to.
   * Refusals before the handler are `McpToolError`s (JSON-RPC errors) and write no ledger row; a
   * tool the turn cannot use now is an error result that says why.
   */
  async call(name: string, rawArgs: Record<string, unknown>, request: McpCallRequest): Promise<ToolOutcome> {
    const registered = this.tools.get(name)
    const tool = registered && !registered.hidden ? registered : undefined
    // Any other name can only be one of the turn's proxied user MCP tools, looked up once the turn is known.
    if (!tool && (registered || !this.options.userMcp)) throw new McpToolError('mousse_unknown_tool', `No Mousse tool named ${name}.`)
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
    if (!tool) return this.callUserMcp(name, args, { threadId, active, turn, credential, boundToken, request })
    // Scope and level are checked first: a refused call asks nobody anything and leaves no ledger row.
    const scope = this.authorize(tool, args, caller, this.options.readOnlyThread?.(threadId) === true)
    const availability = tool.available?.(turn) ?? true
    if (availability !== true) return { text: availability, isError: true }
    const unattended = unattendedRefusal(tool, turn)
    if (unattended) return { text: unattended, isError: true }
    // A bot turn: every app tool is held to the bot's grant, on every call (a list cached before a
    // narrower revision cannot reach a removed tool). Nobody is asked.
    if (turn.bot) {
      const refusal = botAppToolRefusal(turn.bot, name, args)
      if (refusal) return { text: refusal, isError: true }
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
    // runs and writes no ledger row.
    if (tool.access === 'editsWorkspace' && !turn.definition) {
      const refusal = await this.askBeforeEditing(tool, caller, request.signal, args)
      if (refusal) return refusal
    }
    const ctx: ToolCallContext = { caller, turn, toolCallId: request.toolCallId, signal: request.signal, transport: 'mcp', level: this.effectiveLevel(caller.accessLevel), ...(scope ? { scope } : {}) }
    const ledger = this.options.toolLedger?.(active)
    const ledgerId = ledger?.start({ type: 'toolCall', id: ctx.toolCallId, name, arguments: args } as ToolCall)
    let outcome: ToolOutcome
    try {
      outcome = await this.runHandler(tool, args, ctx, turn.toolAccess)
    } catch (error) {
      if (ledgerId) ledger?.failed(ledgerId)
      if (error instanceof McpToolError) throw error
      return { text: error instanceof Error ? error.message : String(error), isError: true }
    }
    if (ledgerId) {
      if (outcome.isError) ledger?.failed(ledgerId)
      else ledger?.commit(ledgerId)
    }
    return outcome
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
      if (refusal) return { text: refusal, isError: true }
      if (request.signal.aborted) return { text: 'Tool dispatch cancelled immediately before side effects.', isError: true }
    } else {
      const decision = await authorizeDefinitionCall(definition, { toolName: name, args: checked, ...projectPath, signal: request.signal })
      if (!decision.allowed) return { text: decision.message, isError: true }
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
    if (turn.bot) throw new McpToolError('mousse_unknown_tool', `No Mousse tool named ${name}.`)
    const tool = this.offeredTool(active, turn, name)
    if (!tool) throw new McpToolError('mousse_unknown_tool', `No Mousse tool named ${name}.`)
    if (turn.definition) {
      const refused = await this.authorizeDefinition(name, args, at)
      if (refused) return refused
    }
    const checked = withoutTransportFields(args)
    const allowed = await proxy.allowed(name, turn.projectPath, turn.actor)
    if (!allowed.allowed) return { text: allowed.reason ?? 'MCP tool is not enabled for this actor.', isError: true }
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
   * Read-only children, thread scope, the plan ceiling and the agent access level, before anything
   * runs. Returns how the caller reaches the target of a `readsOthers` or `managesOthers` tool.
   */
  private authorize(tool: MousseTool, args: Record<string, unknown>, caller: McpCaller, readOnly: boolean): ToolScope | undefined {
    if (tool.access !== 'reads' && tool.access !== 'readsOthers' && !tool.readOnlySafe && readOnly)
      throw new McpToolError('mousse_read_only', `${tool.name} can change threads or the workspace; a read-only subagent cannot call it.`)
    // Scope before any approval: a call refused for naming another thread must not prompt the user first.
    if (tool.access === 'writesThreads' || tool.access === 'editsWorkspace') callerThreadOnly(args, caller)
    if (tool.access === 'startsThreads' && caller.modeCeiling === 'plan')
      throw new McpToolError('mousse_ceiling_exceeded', `${tool.name} starts threads; a plan ceiling cannot.`)
    return tool.access === 'readsOthers' || tool.access === 'managesOthers' ? this.checkOthers(tool, args, caller) : undefined
  }

  /**
   * The central check of `readsOthers` and `managesOthers` tools (SPEC §15.1): how the caller reaches
   * the target, or `mousse_scope_denied` naming the level it needs. The level is the granted one
   * narrowed by the profile's setting now, and the project list is the current one. A thread the caller
   * may not reach is refused the same way whether it exists or not.
   */
  private checkOthers(tool: MousseTool, args: Record<string, unknown>, caller: McpCaller): ToolScope {
    const target = tool.target ? tool.target(args, caller) : { threadId: args.threadId as string | undefined }
    if (!target) return 'own'
    if (target.threadId !== undefined && (typeof target.threadId !== 'string' || !target.threadId))
      throw new McpToolError('mousse_scope_denied', 'threadId must be a non-empty string.')
    if (target.threadId === undefined && !tool.target) return 'own'
    if (target.threadId === caller.threadId) return 'own'
    const manages = tool.access === 'managesOthers'
    const needed: AgentAccessLevel = manages ? 'manage' : 'read'
    const policy = this.options.access
    const effective = this.effectiveLevel(caller.accessLevel)
    const levelOk = levelAtLeast(effective, needed)
    const reachable = (): boolean => {
      try {
        return Boolean(policy) && policy!.projectAllowed(target) && (target.threadId === undefined || policy!.threadExists(target.threadId))
      } catch {
        return false
      }
    }
    const lacks = (what: string): McpToolError =>
      new McpToolError('mousse_scope_denied', `${what} needs the "${needed}" agent access level (yours is "${effective}"); it is set in the profile's agent access setting.`)
    if (target.threadId === undefined) {
      // A listing: the level, and the project when one is named; the handler filters what it returns.
      if (!levelOk) throw lacks(tool.name)
      if (!policy || (target.projectId !== undefined && !reachable()))
        throw new McpToolError('mousse_scope_denied', `${tool.name} is not available for this project.`)
      return effective === 'manage' ? 'manage' : 'read'
    }
    let relation: ThreadRelation | null = null
    try {
      relation = policy?.relation(caller, target.threadId) ?? null
    } catch {
      relation = null
    }
    if (manages) {
      // Lineage is no shortcut for changing a thread; a thread the caller launched is the exception.
      if (relation === 'launched' && tool.launchedOk) return 'launched'
      if (levelOk && reachable()) return 'manage'
    } else {
      if (levelOk && effective === 'manage' && reachable()) return 'manage'
      if (relation) return relation
      if (levelOk && reachable()) return 'read'
    }
    if (levelOk) throw new McpToolError('mousse_scope_denied', `Thread ${target.threadId} is not available to this credential.`)
    throw lacks(`Thread ${target.threadId} is not this thread${manages ? '' : ' or one of its lineage'}; ${tool.name}`)
  }

  /**
   * The outcome a rejected `editsWorkspace` call gets instead of running: null when the call may go
   * ahead (the run's permission mode allows edits, or the user allowed it once). An owner that cannot
   * ask rejects: nothing runs unapproved.
   */
  private async askBeforeEditing(tool: MousseTool, caller: McpCaller, signal: AbortSignal, args: Record<string, unknown>, turnMode?: PermissionMode): Promise<ToolOutcome | null> {
    const mode = turnMode ?? this.options.permissionModeFor?.(caller.runId)
    if (mode === undefined || permissionModeAllows(mode, 'edit')) return null
    const rejected: ToolOutcome = { text: `The user did not approve ${tool.name}, so it did not run. Do not retry it unless they ask.`, isError: true }
    if (!this.options.askApproval) return rejected
    try {
      const answers = await this.options.askApproval(
        caller.threadId,
        [{
          id: 'permission',
          prompt: tool.name === 'thread_merge_back'
            ? "Allow Mousse to hand this fork's work back to the thread it was forked from?"
            : 'Allow this Mousse tool to change files in this workspace?',
          options: [{ id: 'allow', label: 'Allow once' }, { id: 'reject', label: 'Reject' }]
        }],
        {
          signal,
          approval: {
            action: 'edit',
            permissionKey: tool.permissionKey ?? PERMISSION_KEYS.mousseIntegrate,
            options: [{ id: 'allow', decision: 'allow', scope: 'once' }, { id: 'reject', decision: 'reject' }],
            tool: { name: tool.name, input: args }
          }
        }
      )
      if (answers.permission === 'allow' && !signal.aborted) return null
      const why = typeof answers.feedback === 'string' ? answers.feedback.trim().slice(0, 1000) : ''
      return why ? { text: `${rejected.text} Reason: ${why}`, isError: true } : rejected
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
