import type { Tool, ToolCall } from '@earendil-works/pi-ai'
import type { PendingUserQuestions, UserQuestionAnswers } from '../../../shared/types'
import {
  delegationToolDefinitions,
  dispatchDelegationTool,
  type DelegationToolHost,
  type LlmChatOptions
} from '../../orchestrator/LlmClient'
import { PlanModeTools } from '../../orchestrator/PlanModeTools'
import { TaskControlTools } from '../../tasks/TaskControlTools'
import { TaskQueue } from '../../tasks/TaskQueue'
import type { RunEngine } from '../RunEngine'
import type { DelegationRecord, ModeCeiling, ThreadEvent } from '../types'

/**
 * What a tool may touch (docs/run-engine/SPEC.md §15.1):
 * - `reads`: reads state; the handler limits what the caller may see.
 * - `actsAsCaller`: acts on the caller's own thread and run (delegation, questions, plans, tasks).
 * - `writesThreads`: writes a thread named by `threadId`; only the caller's thread is allowed.
 * - `startsThreads`: creates threads; refused under a `plan` ceiling.
 */
export type ToolAccess = 'reads' | 'actsAsCaller' | 'writesThreads' | 'startsThreads'

const ACCESS_CLASSES: ReadonlySet<string> = new Set<ToolAccess>(['reads', 'actsAsCaller', 'writesThreads', 'startsThreads'])

/**
 * Who a credential acts as. `runId` is the thread's active run, resolved for each call (the stored
 * credential only names the thread's latest run); `modeCeiling` is the one stored by that turn.
 */
export interface McpCaller {
  threadId: string
  runId: string
  provider: string
  modeCeiling: ModeCeiling
}

export interface ToolCallContext {
  caller: McpCaller
  /** Stable id of this call; derives the `clientRequestId` of the commands it issues. */
  toolCallId: string
  /** Aborted when the HTTP request closes or the caller's run ends. */
  signal: AbortSignal
}

export interface ToolOutcome {
  text: string
  isError?: boolean
}

export type JsonSchema = Record<string, unknown>

export interface MousseTool {
  name: string
  description: string
  inputSchema: JsonSchema
  access: ToolAccess
  /**
   * A read-only (`shared`) delegated child may call this although it is not a `reads` tool: it
   * changes nothing but the caller's own conversation.
   */
  readOnlySafe?: boolean
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

type ToolLedger = NonNullable<LlmChatOptions['toolLedger']>

export interface ToolRegistryOptions {
  /** The thread's active run (`starting|running|finalizing`), or null when it has none. */
  activeRunId(threadId: string): string | null
  /** SPEC §12.6 tool ledger of the caller's run; undefined skips it. */
  toolLedger?(runId: string): ToolLedger | undefined
  /** The thread is a read-only (`shared`) delegated child; it may call only `reads` and `readOnlySafe` tools. */
  readOnlyThread?(threadId: string): boolean
}

/**
 * A credential acts only while its thread has an active run; the call then acts as that run.
 * Returns the caller with `runId` set to it.
 */
export function assertLiveCaller(activeRunId: string | null, caller: McpCaller): McpCaller {
  if (!activeRunId)
    throw new McpToolError('mousse_caller_not_live', `Thread ${caller.threadId} has no active run; its tools are closed until the next turn.`)
  return { ...caller, runId: activeRunId }
}

/**
 * Tool name → schema, access class and handler. The Mousse MCP server lists and calls through
 * it; every call checks that the caller's run is live and that a thread-writing tool targets the
 * caller's own thread before the handler runs.
 */
export class ToolRegistry {
  private readonly tools = new Map<string, MousseTool>()

  constructor(private readonly options: ToolRegistryOptions) {}

  register(tool: MousseTool): this {
    if (!tool || typeof tool.name !== 'string' || !tool.name) throw new Error('A Mousse tool needs a name')
    if (!ACCESS_CLASSES.has(tool.access as string))
      throw new Error(`Mousse tool ${tool.name} has no access class (reads | actsAsCaller | writesThreads | startsThreads)`)
    if (typeof tool.handler !== 'function') throw new Error(`Mousse tool ${tool.name} has no handler`)
    if (this.tools.has(tool.name)) throw new Error(`Mousse tool ${tool.name} is already registered`)
    this.tools.set(tool.name, tool)
    return this
  }

  get(name: string): MousseTool | undefined {
    return this.tools.get(name)
  }

  list(): MousseTool[] {
    return [...this.tools.values()]
  }

  async call(name: string, args: Record<string, unknown>, request: ToolCallContext): Promise<ToolOutcome> {
    const tool = this.tools.get(name)
    if (!tool) throw new McpToolError('mousse_unknown_tool', `No Mousse tool named ${name}.`)
    const ctx: ToolCallContext = { ...request, caller: assertLiveCaller(this.options.activeRunId(request.caller.threadId), request.caller) }
    if (tool.access !== 'reads' && !tool.readOnlySafe && this.options.readOnlyThread?.(ctx.caller.threadId))
      throw new McpToolError('mousse_read_only', `${name} can change threads or the workspace; a read-only subagent cannot call it.`)
    if (tool.access === 'writesThreads') callerThreadOnly(args, ctx.caller)
    if (tool.access === 'startsThreads' && ctx.caller.modeCeiling === 'plan')
      throw new McpToolError('mousse_ceiling_exceeded', `${name} starts threads; a plan ceiling cannot.`)
    const ledger = this.options.toolLedger?.(ctx.caller.runId)
    const ledgerId = ledger?.start({ type: 'toolCall', id: ctx.toolCallId, name, arguments: args } as ToolCall)
    let outcome: ToolOutcome
    try {
      outcome = await tool.handler(args, ctx)
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
}

/** `threadId` (when given) must be the caller's thread. Returns the caller's thread. */
function callerThreadOnly(args: Record<string, unknown>, caller: McpCaller): string {
  const target = args.threadId
  if (target !== undefined && target !== caller.threadId)
    throw new McpToolError('mousse_scope_denied', `This credential acts for thread ${caller.threadId} only.`)
  return caller.threadId
}

// ------------------------------------------------------------------------------------------------
// Phase 5 tools

/** `ask_user` blocks at most this long (or until the caller's run ends). */
export const ASK_USER_TIMEOUT_MS = 60 * 60 * 1000

const THREAD_READ_DEFAULT_LIMIT = 200
const THREAD_READ_MAX_LIMIT = 500
/** Lineage walks stop here; deeper chains are treated as unrelated. */
const LINEAGE_MAX_DEPTH = 64

/** What the thread owner (the orchestrator) provides to the Mousse tools. */
export interface MousseToolHost {
  /** The SPEC §14.2 delegation tools acting as `caller`; children default to its ceiling. */
  delegation(caller: McpCaller): DelegationToolHost
  askUser(
    threadId: string,
    questions: PendingUserQuestions['questions'],
    options: { signal: AbortSignal; timeoutMs: number }
  ): Promise<UserQuestionAnswers>
  presentPlan(threadId: string, payload: { title: string; markdown: string }): void
  tasks(threadId: string): TaskQueue
  listQueue(threadId: string): unknown[]
  enqueue(threadId: string, input: { content: string; mode: 'agent' | 'plan' }): unknown
  toolLedger?(runId: string): ToolLedger | undefined
  readOnlyThread?(threadId: string): boolean
}

const CLIENT_REQUEST_ID_SCHEMA: JsonSchema = {
  type: 'string',
  description: 'Fresh per new action; reuse only to retry the same call, which then returns the first result.'
}

/** A plain JSON Schema copy of a pi-ai tool's parameters (TypeBox adds symbol keys). */
function plainSchema(tool: Tool, extra: Record<string, JsonSchema> = {}): JsonSchema {
  const schema = JSON.parse(JSON.stringify(tool.parameters)) as JsonSchema & { properties?: Record<string, JsonSchema> }
  return Object.keys(extra).length ? { ...schema, properties: { ...(schema.properties ?? {}), ...extra } } : schema
}

const json = (value: unknown): ToolOutcome => ({ text: JSON.stringify(value) })

/** Event types a lineage thread may read of another thread (M7): run lifecycle and lineage only. */
function lineageVisible(type: string): boolean {
  return type.startsWith('run.') || type.startsWith('attempt.') || type === 'command.ignored' || type === 'restart.note' || type === 'thread.lineage'
}

/**
 * Another thread's events as a lineage relative sees them (M7): run and attempt lifecycle,
 * ignored commands, restart notes and the lineage row; plus `delegation.status` rows whose result is shown only to
 * the delegation's own child (a sibling's result and the parent's other prompts stay private).
 * Inbox, effect (turn payloads carry prompts), tool and transfer events are left out.
 */
function lineageView(events: ThreadEvent[], callerThreadId: string): ThreadEvent[] {
  const out: ThreadEvent[] = []
  for (const event of events) {
    if (lineageVisible(event.type)) out.push(event)
    else if (event.type === 'delegation.status') {
      const delegation = event.payload as DelegationRecord
      out.push(delegation.childThreadId === callerThreadId ? event : { ...event, payload: { ...delegation, result: null } })
    }
  }
  return out
}

function isRelated(engine: RunEngine, callerThreadId: string, targetThreadId: string): boolean {
  const ancestors = (threadId: string): string[] => {
    const out: string[] = []
    let current = threadId
    for (let depth = 0; depth < LINEAGE_MAX_DEPTH; depth += 1) {
      const lineage = engine.delegations.getLineage(current)
      if (!lineage || out.includes(lineage.parentThreadId)) break
      out.push(lineage.parentThreadId)
      current = lineage.parentThreadId
    }
    return out
  }
  return ancestors(callerThreadId).includes(targetThreadId) || ancestors(targetThreadId).includes(callerThreadId)
}

function boundedInt(value: unknown, name: string, min: number, max: number, fallback: number): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max)
    throw new Error(`${name} must be an integer from ${min} to ${max}`)
  return value
}

/**
 * The Phase 5 registry: the same definitions and handlers the pi loop uses (`LlmClient`'s
 * delegation dispatch, `PlanModeTools`, `TaskControlTools`) plus `thread_read` and the queue tools.
 */
export function createMousseToolRegistry(deps: { engine: RunEngine; host: MousseToolHost }): ToolRegistry {
  const { engine, host } = deps
  const registry = new ToolRegistry({
    activeRunId: (threadId) => engine.getActiveRun(threadId)?.runId ?? null,
    toolLedger: host.toolLedger ? (runId) => host.toolLedger!(runId) : undefined,
    readOnlyThread: host.readOnlyThread ? (threadId) => host.readOnlyThread!(threadId) : undefined
  })

  const delegationTool = (tool: Tool, extra: Record<string, JsonSchema>, before?: (args: Record<string, unknown>, caller: McpCaller) => void): MousseTool => ({
    name: tool.name,
    description: tool.description,
    inputSchema: plainSchema(tool, extra),
    access: 'actsAsCaller',
    // A read-only subagent may start (read-only) subagents and follow them; `delegateTask` checks the
    // workspace of each one. Integration writes the workspace and stays refused.
    readOnlySafe: tool.name !== 'integrate_delegation',
    handler: async (args, ctx) => {
      before?.(args, ctx.caller)
      const call: ToolCall = { type: 'toolCall', id: ctx.toolCallId, name: tool.name, arguments: args }
      return json(await dispatchDelegationTool(host.delegation(ctx.caller), call))
    }
  })
  for (const tool of delegationToolDefinitions()) {
    if (tool.name === 'delegate_task') {
      registry.register(delegationTool(tool, {
        modeCeiling: { type: 'string', enum: ['plan', 'default'], description: 'The most the child may do. Defaults to yours and cannot exceed it.' },
        clientRequestId: CLIENT_REQUEST_ID_SCHEMA
      }, (args, caller) => {
        const requested = args.modeCeiling
        if (requested === 'default' && caller.modeCeiling === 'plan')
          throw new McpToolError('mousse_ceiling_exceeded', 'A plan-ceiling caller cannot start a child with the default ceiling.')
        if (requested === undefined) args.modeCeiling = caller.modeCeiling
      }))
    } else if (tool.name === 'integrate_delegation') {
      registry.register(delegationTool(tool, { clientRequestId: CLIENT_REQUEST_ID_SCHEMA }, (_args, caller) => {
        if (caller.modeCeiling === 'plan')
          throw new McpToolError('mousse_ceiling_exceeded', 'Integration writes the workspace; a plan ceiling cannot integrate.')
      }))
    } else if (tool.name === 'continue_subagent' || tool.name === 'answer_subagent') {
      // Both act on the caller's own subagent, which the host's handler checks; they stay `actsAsCaller`
      // like `delegate_task` rather than loosening the thread-writing scope check for other tools.
      registry.register(delegationTool(tool, { clientRequestId: CLIENT_REQUEST_ID_SCHEMA }))
    } else {
      registry.register(delegationTool(tool, {}))
    }
  }

  const planTools = (signal?: AbortSignal) => new PlanModeTools(
    (questions, threadId) => host.askUser(threadId, questions, { signal: signal ?? new AbortController().signal, timeoutMs: ASK_USER_TIMEOUT_MS }),
    () => undefined,
    (payload, threadId) => { if (threadId) host.presentPlan(threadId, payload) }
  )
  const definitions = planTools()
  for (const tool of [definitions.getAskUserToolDefinition(), definitions.getPresentPlanToolDefinition()]) {
    registry.register({
      name: tool.name,
      description: tool.name === 'ask_user'
        ? `${tool.description} Blocks until the user answers (at most one hour) or your run ends.`
        : tool.description,
      inputSchema: plainSchema(tool),
      access: 'actsAsCaller',
      readOnlySafe: true,
      handler: (args, ctx) => planTools(ctx.signal).execute(tool.name, args, ctx.caller.threadId)
    })
  }

  for (const tool of new TaskControlTools(new TaskQueue()).getToolDefinitions()) {
    registry.register({
      name: tool.name,
      description: tool.description,
      inputSchema: plainSchema(tool),
      access: 'actsAsCaller',
      handler: (args, ctx) => new TaskControlTools(host.tasks(ctx.caller.threadId)).execute(tool.name, args)
    })
  }

  registry.register({
    name: 'thread_read',
    description: 'Read run events (runs, attempts, delegations, tool calls) of your thread, or of a thread you delegated to or were delegated from. Page with afterSeq.',
    inputSchema: {
      type: 'object',
      properties: {
        threadId: { type: 'string', description: 'Defaults to your thread.' },
        afterSeq: { type: 'integer', minimum: 0, description: 'Return events after this sequence number.' },
        limit: { type: 'integer', minimum: 1, maximum: THREAD_READ_MAX_LIMIT }
      }
    },
    access: 'reads',
    handler: (args, ctx) => {
      const threadId = args.threadId === undefined ? ctx.caller.threadId : args.threadId
      if (typeof threadId !== 'string' || !threadId) throw new Error('threadId must be a non-empty string')
      if (threadId !== ctx.caller.threadId && !isRelated(engine, ctx.caller.threadId, threadId))
        throw new McpToolError('mousse_scope_denied', `Thread ${threadId} is not this thread or one of its lineage.`)
      const afterSeq = boundedInt(args.afterSeq, 'afterSeq', 0, Number.MAX_SAFE_INTEGER, 0)
      const limit = boundedInt(args.limit, 'limit', 1, THREAD_READ_MAX_LIMIT, THREAD_READ_DEFAULT_LIMIT)
      const page = engine.listEvents(threadId, { afterSeq, limit })
      const events = threadId === ctx.caller.threadId ? page : lineageView(page, ctx.caller.threadId)
      // `nextAfterSeq` pages on even when a lineage view filtered events out of this page.
      return json({ threadId, events, maxSeq: engine.maxSeq(threadId), nextAfterSeq: page.at(-1)?.seq ?? afterSeq })
    }
  })

  registry.register({
    name: 'queue_list',
    description: 'List the messages queued on your thread (they run after the current turn).',
    inputSchema: { type: 'object', properties: { threadId: { type: 'string', description: 'Your thread only.' } } },
    access: 'reads',
    handler: (args, ctx) => json({ items: host.listQueue(callerThreadOnly(args, ctx.caller)) })
  })

  registry.register({
    name: 'queue_enqueue',
    description: 'Queue a message on your thread; it runs as a new turn after the current one.',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string' },
        mode: { type: 'string', enum: ['agent', 'plan'], description: 'Defaults to plan under a plan ceiling, else agent.' },
        threadId: { type: 'string', description: 'Your thread only.' }
      },
      required: ['content']
    },
    access: 'writesThreads',
    handler: (args, ctx) => {
      const threadId = callerThreadOnly(args, ctx.caller)
      if (typeof args.content !== 'string' || !args.content.trim()) throw new Error('queue_enqueue requires content')
      if (args.mode !== undefined && args.mode !== 'agent' && args.mode !== 'plan') throw new Error('mode must be agent or plan')
      if (args.mode === 'agent' && ctx.caller.modeCeiling === 'plan')
        throw new McpToolError('mousse_ceiling_exceeded', 'A plan-ceiling caller can only queue plan turns.')
      const mode = (args.mode as 'agent' | 'plan' | undefined) ?? (ctx.caller.modeCeiling === 'plan' ? 'plan' : 'agent')
      return json({ item: host.enqueue(threadId, { content: args.content, mode }) })
    }
  })

  registry.register({
    name: 'thread_fork',
    description: 'Fork a thread into a new thread that starts after one of its finished runs (default: the latest completed, failed, interrupted or cancelled run). The fork gets the conversation up to that run and its own worktree seeded from that run\'s code checkpoint when its first message arrives.',
    inputSchema: {
      type: 'object',
      properties: {
        sourceThreadId: { type: 'string', description: 'Defaults to your thread; otherwise a thread of your lineage.' },
        atRunOrdinal: { type: 'integer', minimum: 1, description: 'The source run to fork after; the latest finished run when omitted.' },
        title: { type: 'string' },
        seedFrom: { type: 'string', enum: ['checkpoint', 'current_head'], description: 'When the fork point has no code checkpoint the fork is refused (fork_point_unavailable) unless this is current_head: start from the source\'s current code.' },
        clientRequestId: CLIENT_REQUEST_ID_SCHEMA
      }
    },
    access: 'startsThreads',
    handler: async (args, ctx) => {
      const sourceThreadId = args.sourceThreadId === undefined ? ctx.caller.threadId : args.sourceThreadId
      if (typeof sourceThreadId !== 'string' || !sourceThreadId) throw new Error('sourceThreadId must be a non-empty string')
      if (sourceThreadId !== ctx.caller.threadId && !isRelated(engine, ctx.caller.threadId, sourceThreadId))
        throw new McpToolError('mousse_scope_denied', `Thread ${sourceThreadId} is not this thread or one of its lineage.`)
      const atRunOrdinal = args.atRunOrdinal === undefined ? 'latest_stable' : boundedInt(args.atRunOrdinal, 'atRunOrdinal', 1, Number.MAX_SAFE_INTEGER, 1)
      if (args.title !== undefined && typeof args.title !== 'string') throw new Error('title must be a string')
      if (args.seedFrom !== undefined && args.seedFrom !== 'checkpoint' && args.seedFrom !== 'current_head')
        throw new Error("seedFrom must be 'checkpoint' or 'current_head'")
      const forked = await engine.forkThread({
        sourceThreadId,
        atRunOrdinal,
        title: args.title as string | undefined,
        seedFrom: args.seedFrom as 'checkpoint' | 'current_head' | undefined,
        clientRequestId: `thread_fork:${ctx.caller.runId}:${toolRequestId(args, ctx)}`
      })
      return json({ threadId: forked.threadId, transferId: forked.transferId })
    }
  })

  registry.register({
    name: 'thread_merge_back',
    description: 'From a fork, hand what it did since the fork point to the thread it was forked from. The parent receives a summary on its next turn; code is not merged (integrate it explicitly). Only when the fork\'s latest run completed.',
    inputSchema: {
      type: 'object',
      properties: {
        forkThreadId: { type: 'string', description: 'Your thread only (the fork).' },
        threadId: { type: 'string', description: 'Your thread only.' },
        clientRequestId: CLIENT_REQUEST_ID_SCHEMA
      }
    },
    access: 'writesThreads',
    handler: async (args, ctx) => {
      const forkThreadId = callerThreadOnly({ threadId: args.forkThreadId ?? args.threadId }, ctx.caller)
      const merged = await engine.mergeBack({
        forkThreadId,
        clientRequestId: `thread_merge_back:${ctx.caller.runId}:${toolRequestId(args, ctx)}`
      })
      return json({ transferId: merged.transferId, parentThreadId: merged.parentThreadId })
    }
  })

  return registry
}

/** The caller's `clientRequestId` when given (a retry), else this call's id. */
function toolRequestId(args: Record<string, unknown>, ctx: ToolCallContext): string {
  if (args.clientRequestId === undefined) return ctx.toolCallId
  if (typeof args.clientRequestId !== 'string' || !args.clientRequestId) throw new Error('clientRequestId must be a non-empty string')
  return args.clientRequestId
}
