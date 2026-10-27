import type { ToolCall } from '@earendil-works/pi-ai'
import type { AgentToolAccess } from '../../../agents/WorkspaceAccessPolicy'
import { authorizeDefinitionCall, definitionRefusal, takeAuthorizedCall, withoutTransportFields } from '../../../agentDefinitions/definitionGate'
import type { ModeCeiling } from '../../types'
import type { AppToolTurns } from './turns'
import { callerThreadOnly } from './thread'
import {
  ACCESS_CLASSES,
  McpToolError,
  TOOL_CLASSES,
  unattendedRefusal,
  type AppToolTurn,
  type McpCaller,
  type MousseTool,
  type ToolCallContext,
  type ToolLedger,
  type ToolListing,
  type ToolOutcome,
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
 * Who an in-process call acts for (PR 2 §2 `InProcessAuthority`). `run`: the legacy loop of a run
 * engine turn, which must still be the thread's active run (read by the run's owner through
 * `active`, else by the registry's own run engine).
 * `trusted`: a definition, bot or scheduled run with no run engine turn; its grants and budget were
 * checked by the caller (`LlmClient`), exactly as before. Either way the caller writes the ledger
 * (`ledgerEntryId`), so the registry writes none.
 */
export type InProcessAuthority =
  | {
      kind: 'run'
      runId: string
      ledgerEntryId?: string
      /** Whether the run is still the thread's active run, read by the run's owner (the registry may not know the run engine). */
      active?: () => boolean
    }
  | { kind: 'trusted'; ledgerEntryId?: string }

export interface InProcessCall {
  turn: AppToolTurn
  toolCallId: string
  signal: AbortSignal
  timeline?: ToolTimeline
  markEffect?(): void
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
  /** The turns registered by the `turn.start` executor; MCP calls act only inside one. */
  turns?: AppToolTurns
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

  constructor(private readonly options: ToolRegistryOptions) {}

  register(tool: MousseTool): this {
    if (!tool || typeof tool.name !== 'string' || !tool.name) throw new Error('A Mousse tool needs a name')
    if (!ACCESS_CLASSES.has(tool.access as string))
      throw new Error(`Mousse tool ${tool.name} has no access class (reads | actsAsCaller | writesThreads | startsThreads)`)
    if (!TOOL_CLASSES.has(tool.class as string)) throw new Error(`Mousse tool ${tool.name} has no class (read | mutation | delegation)`)
    if (typeof tool.handler !== 'function') throw new Error(`Mousse tool ${tool.name} has no handler`)
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
      if (listing.readOnly && tool.access !== 'reads' && !tool.readOnlySafe) return false
      if (listing.modeCeiling === 'plan' && tool.access === 'startsThreads') return false
      return tool.listed?.(listing) ?? true
    })
  }

  /**
   * `listFor` a thread: its read-only status and the ceiling its delegations gave it, never the
   * current turn's mode (a Plan turn's narrower ceiling is enforced at call time). `fallback` is the
   * ceiling when the owner does not say.
   */
  listForThread(threadId: string, fallback: ModeCeiling = 'default'): MousseTool[] {
    return this.listFor({
      readOnly: this.options.readOnlyThread?.(threadId) === true,
      modeCeiling: this.options.threadCeiling?.(threadId) ?? fallback
    })
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
    const tool = this.tools.get(name)
    if (!tool || tool.hidden) throw new McpToolError('mousse_unknown_tool', `No Mousse tool named ${name}.`)
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
    const caller: McpCaller = { threadId, runId: active, provider: credential.provider, modeCeiling: credential.modeCeiling }
    this.authorize(tool, args, caller, this.options.readOnlyThread?.(threadId) === true)
    const availability = tool.available?.(turn) ?? true
    if (availability !== true) return { text: availability, isError: true }
    const unattended = unattendedRefusal(tool, turn)
    if (unattended) return { text: unattended, isError: true }
    // A definition run: its grants, policy and approvals hold for every call, as in the in-process loop.
    // A call the runtime's gate already authorized in full (approval included, before it was
    // charged) is revalidated without asking again; any other call is authorized here.
    if (turn.definition) {
      const callId = request.toolCallId.startsWith('mcp:') ? request.toolCallId.slice('mcp:'.length) : request.toolCallId
      // Transport fields are not part of the call, here as at the gate.
      const checked = withoutTransportFields(args)
      const projectPath = turn.projectPath ? { projectPath: turn.projectPath } : {}
      // A per-call runtime's gate authorized this exact call (turn, tool, call id, arguments).
      const handedOver = credential.binding === 'per_call' && takeAuthorizedCall(turn.definition, { turnToken: boundToken, toolName: name, callId, args: checked })
      if (handedOver) {
        const refusal = definitionRefusal(turn.definition, { toolName: name, args: checked, ...projectPath })
        if (refusal) return { text: refusal, isError: true }
        if (request.signal.aborted) return { text: 'Tool dispatch cancelled immediately before side effects.', isError: true }
      } else {
        const decision = await authorizeDefinitionCall(turn.definition, { toolName: name, args: checked, ...projectPath, signal: request.signal })
        if (!decision.allowed) return { text: decision.message, isError: true }
      }
    }
    const ctx: ToolCallContext = { caller, turn, toolCallId: request.toolCallId, signal: request.signal, transport: 'mcp' }
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
   * A call from an in-process loop (the pi loop, a definition, the scheduled job). The caller has
   * already applied its own authority (a read-only child's workspace capability, a definition's
   * grants and budget) and writes the ledger; refusals come back as error results, as the loop has
   * always reported them.
   */
  async callInProcess(name: string, args: Record<string, unknown>, authority: InProcessAuthority, call: InProcessCall): Promise<ToolOutcome> {
    const tool = this.tools.get(name)
    if (!tool) return { text: `Unknown tool: ${name}`, isError: true }
    const { turn } = call
    try {
      if (authority.kind === 'run') {
        const active = turn.threadId ? this.options.activeRunId(turn.threadId) : null
        const live = authority.active ? authority.active() : active === null || active === authority.runId
        if (!live) throw notLive(`Run ${authority.runId} is no longer the active run of thread ${turn.threadId}.`)
      }
      const availability = tool.available?.(turn) ?? true
      if (availability !== true) return { text: availability, isError: true }
      const unattended = unattendedRefusal(tool, turn)
      if (unattended) return { text: unattended, isError: true }
      const caller: McpCaller = { threadId: turn.threadId, runId: turn.runId, provider: 'in_process', modeCeiling: turn.modeCeiling }
      return await tool.handler(args, {
        caller,
        turn,
        toolCallId: call.toolCallId,
        signal: call.signal,
        transport: 'in_process',
        timeline: call.timeline,
        markEffect: call.markEffect
      })
    } catch (error) {
      return { text: error instanceof Error ? error.message : String(error), isError: true }
    }
  }

  /** Read-only children, thread scope and the plan ceiling, before anything runs. */
  private authorize(tool: MousseTool, args: Record<string, unknown>, caller: McpCaller, readOnly: boolean): void {
    if (tool.access !== 'reads' && !tool.readOnlySafe && readOnly)
      throw new McpToolError('mousse_read_only', `${tool.name} can change threads or the workspace; a read-only subagent cannot call it.`)
    if (tool.access === 'writesThreads') callerThreadOnly(args, caller)
    if (tool.access === 'startsThreads' && caller.modeCeiling === 'plan')
      throw new McpToolError('mousse_ceiling_exceeded', `${tool.name} starts threads; a plan ceiling cannot.`)
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
