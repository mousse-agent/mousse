import { Type, type Tool, type ToolCall, type ToolResultMessage } from '@earendil-works/pi-ai'
import { recordSubagentCall } from '../../../../shared/subagentTools'
import type { LlmToolEvent, StreamingLlmToolEvent } from '../../../harness/turnEvents'
import {
  CLIENT_REQUEST_ID_SCHEMA,
  McpToolError,
  plainSchema,
  type JsonSchema,
  type McpCaller,
  type MousseTool,
  type ToolCallContext,
  type ToolOutcome,
  type ToolTimeline
} from './types'

/** Named-agent wrapper input (`create_subagent`); `name` becomes the child thread title. */
export interface NamedAgentToolRequest {
  name: string
  task: string
  workspace?: 'shared' | 'isolated'
  access?: 'read-only' | 'write'
}
/** Named-agent wrapper input (`recall_subagent`): a follow-up on the named child thread. */
export interface NamedAgentRecallRequest extends Omit<NamedAgentToolRequest, 'name'> { agent: string; expectedAgentGeneration?: number; contextMode?: 'continue' | 'fresh'; resumeResult?: boolean }

/** `delegate_task` arguments (docs/run-engine/SPEC.md §14.2). */
export interface DelegateTaskInput {
  prompt: string
  /** Provider instance the child runs on (`claude`, `pi:openai`, ...); defaults to the caller's. */
  instanceId?: string
  /** @deprecated Older `llmProvider` name; mapped to an instance id. `instanceId` wins when both are set. */
  provider?: string
  model?: string
  role?: string
  workspace: 'isolated' | 'shared'
  wake?: 'always' | 'settled_only'
  /**
   * The subagent's title: its address among the caller's subagents. The `delegate_task` tool
   * requires it; a host call without one derives a title from the prompt.
   */
  title?: string
  /**
   * The most the child may do (SPEC §15.1). Only the Mousse MCP server offers it; the host
   * defaults it to the caller's ceiling and refuses a broader one.
   */
  modeCeiling?: 'plan' | 'default'
}

/** The model's tool call that invoked a delegation tool; its id derives the clientRequestId. */
export interface DelegationToolCall {
  toolCallId: string
}

/**
 * The task a delegation tool names: a `delegationId`, or `subagent` (a title, a childThreadId or a
 * delegationId) for the subagent's latest task. At least one is set.
 */
export interface SubagentRef {
  delegationId?: string
  subagent?: string
}

/**
 * Delegation tools (SPEC §14.2, `ToolHost`). Host-minted per turn; never accepted from protocol
 * input. The named-agent tools are thin wrappers the host builds on `delegateTask`.
 */
export interface DelegationToolHost {
  delegateTask(input: DelegateTaskInput, call: DelegationToolCall): Promise<unknown>
  continueSubagent(input: { subagent: string; prompt: string }, call: DelegationToolCall): Promise<unknown>
  answerSubagent(input: { subagent: string; requestId: string; answers: Record<string, string | string[]> }, call: DelegationToolCall): Promise<unknown> | unknown
  taskStatus(input: SubagentRef): Promise<unknown> | unknown
  taskCancel(input: SubagentRef): Promise<unknown>
  listDelegations(): unknown
  listSubagents(): unknown
  integrateDelegation(input: SubagentRef, call: DelegationToolCall): Promise<unknown>
  named: {
    create(input: NamedAgentToolRequest, call: DelegationToolCall): Promise<unknown>
    createBatch(input: NamedAgentToolRequest[], call: DelegationToolCall): Promise<unknown>
    recall(input: NamedAgentRecallRequest, call: DelegationToolCall): Promise<unknown>
    integrate(input: { agent: string }, call: DelegationToolCall): Promise<unknown>
  }
}

/** Delegation tool schemas (SPEC §14.2) plus the named-agent compatibility wrappers. */
const DELEGATION_TOOLS: Tool[] = [
  { name: 'delegate_task', description: 'Start a new subagent on its own thread and return at once with its delegationId. Mousse sends you a notice with the result when it finishes. title is a short role-like name ("API reviewer"), unique among your subagents: it is how you address the subagent later (continue_subagent, task_status, task_cancel); when it is taken the call returns title_taken and starts nothing. workspace isolated gives the subagent its own worktree; shared is only for read-only roles (research, review). instanceId (the agent to run, such as "claude" or "pi:openai") and model default to yours; provider is the older name form of instanceId.',
    parameters: Type.Object({ prompt: Type.String(), title: Type.String(), instanceId: Type.Optional(Type.String()), provider: Type.Optional(Type.String()), model: Type.Optional(Type.String()), role: Type.Optional(Type.String()),
      workspace: Type.Union([Type.Literal('isolated'), Type.Literal('shared')]),
      wake: Type.Optional(Type.Union([Type.Literal('always'), Type.Literal('settled_only')])) }) },
  { name: 'continue_subagent', description: 'Send a follow-up to a subagent you already started, by title (or childThreadId, or delegationId). It continues on the same thread with the context it has, so use it when the next step builds on what it read or did. Starts a new task, returns at once with its delegationId, and Mousse sends you a notice with the result. A subagent that is busy runs the follow-up after its current task (status queued). A subagent waiting for an answer returns needs_answer with its question; answer it with answer_subagent. It cannot change workspace, provider or model; start a new subagent for that.',
    parameters: Type.Object({ subagent: Type.String(), prompt: Type.String() }) },
  { name: 'answer_subagent', description: 'Answer a question one of your subagents asked (ask_user), using the requestId from continue_subagent (needs_answer) or from the question notice. answers maps each question id to the chosen option id (an array when several are allowed) or free text.',
    parameters: Type.Object({ subagent: Type.String(), requestId: Type.String(), answers: Type.Record(Type.String(), Type.Union([Type.String(), Type.Array(Type.String())])) }) },
  { name: 'task_status', description: 'Status of a subagent task, with its result once finished (bounded). Pass the delegationId, or the subagent title for its latest task. Reading a result acknowledges it.', parameters: Type.Object({ delegationId: Type.Optional(Type.String()), subagent: Type.Optional(Type.String()) }) },
  { name: 'task_cancel', description: 'Cancel a subagent task and everything that subagent delegated, deepest first. Pass the delegationId, or the subagent title to cancel all of its open tasks.', parameters: Type.Object({ delegationId: Type.Optional(Type.String()), subagent: Type.Optional(Type.String()) }) },
  { name: 'list_delegations', description: 'List the tasks this thread delegated, with their status.', parameters: Type.Object({}) },
  { name: 'integrate_delegation', description: 'Merge a finished isolated subagent task into this thread workspace. Pass the delegationId, or the subagent title for its latest finished task. Merges exactly what that task finished with, even if the subagent has worked since. Runs as its own integration run after this turn; you are notified of the outcome.', parameters: Type.Object({ delegationId: Type.Optional(Type.String()), subagent: Type.Optional(Type.String()) }) },
  { name: 'create_subagent', description: 'Named wrapper over delegate_task: starts a child thread titled with the name and returns at once. Defaults to shared read-only research; access write runs in an isolated worktree.',
    parameters: Type.Object({ name: Type.String(), task: Type.String(),
      workspace: Type.Optional(Type.Union([Type.Literal('shared'), Type.Literal('isolated')])),
      access: Type.Optional(Type.Union([Type.Literal('read-only'), Type.Literal('write')])) }) },
  { name: 'create_subagents', description: 'Start up to eight named delegated tasks at once (see create_subagent).', parameters: Type.Object({ agents: Type.Array(Type.Object({ name: Type.String(), task: Type.String(), workspace: Type.Optional(Type.Union([Type.Literal('shared'), Type.Literal('isolated')])), access: Type.Optional(Type.Union([Type.Literal('read-only'), Type.Literal('write')])) }), { minItems: 1, maxItems: 8 }) }) },
  { name: 'integrate_subagent', description: 'Named wrapper over integrate_delegation for the latest finished task of the named child.', parameters: Type.Object({ agent: Type.String(), episodeId: Type.Optional(Type.String()), expectedResultSha: Type.Optional(Type.String()), expectedDestinationSha: Type.Optional(Type.String()) }) },
  { name: 'recall_subagent', description: 'Send a follow-up task to an existing named child thread; returns at once and wakes you when it finishes.',
    parameters: Type.Object({ agent: Type.String(), task: Type.String(), expectedAgentGeneration: Type.Optional(Type.Integer({ minimum: 0 })),
      workspace: Type.Optional(Type.Union([Type.Literal('shared'), Type.Literal('isolated')])),
      access: Type.Optional(Type.Union([Type.Literal('read-only'), Type.Literal('write')])),
      contextMode: Type.Optional(Type.Union([Type.Literal('continue'), Type.Literal('fresh')])), resumeResult: Type.Optional(Type.Boolean()) }) },
  { name: 'list_subagents', description: 'List your subagents, one row per subagent: title, childThreadId, state, latest delegationId, whether a result is unread, workspace, provider and model.', parameters: Type.Object({}) }
]

/** Every name `dispatchDelegationTool` runs, the hidden compatibility aliases included. */
export const DELEGATION_TOOL_NAMES: ReadonlySet<string> = new Set(DELEGATION_TOOLS.map((tool) => tool.name))

/**
 * The tools both the pi loop and the Mousse MCP server offer, in one list. The older names
 * (`create_subagent(s)`, `recall_subagent`, `integrate_subagent`, `list_delegations`) stay
 * dispatchable for replayed transcripts but are not listed.
 */
export const LISTED_DELEGATION_TOOL_NAMES = ['delegate_task', 'continue_subagent', 'answer_subagent', 'task_status', 'task_cancel', 'list_subagents', 'integrate_delegation'] as const

/** Definitions shared by the pi loop and the Mousse MCP server, so both offer identical schemas. */
export function delegationToolDefinitions(names: readonly string[] = LISTED_DELEGATION_TOOL_NAMES): Tool[] {
  return DELEGATION_TOOLS.filter((tool) => names.includes(tool.name))
}

function requireString(input: Record<string, unknown>, key: string, message: string): string {
  const value = input[key]
  if (typeof value !== 'string' || !value.trim()) throw new Error(message)
  return value
}

/** The task a call names: a `delegationId`, or a `subagent` (its title, childThreadId or delegationId). */
function subagentRef(args: Record<string, unknown>, tool: string): SubagentRef {
  const delegationId = typeof args.delegationId === 'string' && args.delegationId.trim() ? args.delegationId : undefined
  const subagent = typeof args.subagent === 'string' && args.subagent.trim() ? args.subagent : undefined
  if (!delegationId && !subagent) throw new Error(`${tool} requires a delegationId or a subagent title`)
  return { ...(delegationId ? { delegationId } : {}), ...(subagent ? { subagent } : {}) }
}

/** Runs one delegation tool call against the turn's host (also used by the pi replay kit). */
export async function dispatchDelegationTool(host: DelegationToolHost, toolCall: ToolCall): Promise<unknown> {
  const args = (toolCall.arguments ?? {}) as Record<string, unknown>
  const call: DelegationToolCall = { toolCallId: toolCall.id }
  switch (toolCall.name) {
    case 'delegate_task': {
      const prompt = requireString(args, 'prompt', 'delegate_task requires a prompt')
      if (args.workspace !== 'isolated' && args.workspace !== 'shared') throw new Error('delegate_task requires workspace isolated or shared')
      if (args.wake !== undefined && args.wake !== 'always' && args.wake !== 'settled_only') throw new Error('wake must be always or settled_only')
      for (const key of ['instanceId', 'provider', 'model', 'role'] as const)
        if (args[key] !== undefined && (typeof args[key] !== 'string' || !String(args[key]).trim())) throw new Error(`${key} must be a non-empty string`)
      if (args.modeCeiling !== undefined && args.modeCeiling !== 'plan' && args.modeCeiling !== 'default') throw new Error('modeCeiling must be plan or default')
      const title = requireString(args, 'title', 'delegate_task requires a title: a short role-like name for the subagent, such as "API reviewer"').trim()
      return host.delegateTask({ prompt, title, workspace: args.workspace, wake: args.wake as DelegateTaskInput['wake'],
        instanceId: args.instanceId as string | undefined, provider: args.provider as string | undefined, model: args.model as string | undefined, role: args.role as string | undefined,
        ...(args.modeCeiling !== undefined ? { modeCeiling: args.modeCeiling as DelegateTaskInput['modeCeiling'] } : {}) }, call)
    }
    case 'continue_subagent':
      return host.continueSubagent({
        subagent: requireString(args, 'subagent', 'continue_subagent requires a subagent: its title, childThreadId or delegationId'),
        prompt: requireString(args, 'prompt', 'continue_subagent requires a prompt')
      }, call)
    case 'answer_subagent': {
      const answers = args.answers
      if (!answers || typeof answers !== 'object' || Array.isArray(answers) ||
        Object.values(answers).some((value) => typeof value !== 'string' && !(Array.isArray(value) && value.every((item) => typeof item === 'string'))))
        throw new Error('answer_subagent requires answers: an object mapping each question id to an option id, an array of option ids, or text')
      return host.answerSubagent({
        subagent: requireString(args, 'subagent', 'answer_subagent requires a subagent: its title, childThreadId or delegationId'),
        requestId: requireString(args, 'requestId', 'answer_subagent requires the requestId of the question'),
        answers: answers as Record<string, string | string[]>
      }, call)
    }
    case 'task_status':
      return host.taskStatus(subagentRef(args, 'task_status'))
    case 'task_cancel':
      return host.taskCancel(subagentRef(args, 'task_cancel'))
    case 'list_delegations':
      return host.listDelegations()
    case 'integrate_delegation':
      return host.integrateDelegation(subagentRef(args, 'integrate_delegation'), call)
    case 'create_subagent': {
      if (typeof args.name !== 'string' || typeof args.task !== 'string') throw new Error('Named subagent requires name and task')
      return host.named.create(args as unknown as NamedAgentToolRequest, call)
    }
    case 'create_subagents': {
      const agents = args.agents as NamedAgentToolRequest[] | undefined
      if (!Array.isArray(agents) || agents.some((agent) => typeof agent?.name !== 'string' || typeof agent?.task !== 'string')) throw new Error('Parallel named assignments require names and tasks')
      return host.named.createBatch(agents, call)
    }
    case 'integrate_subagent':
      return host.named.integrate({ agent: requireString(args, 'agent', 'Integration requires the agent name') }, call)
    case 'recall_subagent': {
      if (typeof args.agent !== 'string' || typeof args.task !== 'string' || args.contextMode !== undefined && !['continue', 'fresh'].includes(String(args.contextMode))) throw new Error('Recall requires agent and task')
      return host.named.recall(args as unknown as NamedAgentRecallRequest, call)
    }
    case 'list_subagents':
      return host.listSubagents()
    default:
      throw new Error(`Unknown delegation tool ${toolCall.name}`)
  }
}

/**
 * Runs one delegation tool and writes it to the timeline as a Mousse MCP call, the shape Claude
 * and Codex rows have, with the bounded record the app needs to tell which task it started
 * (`recordSubagentCall`): never the prompt or the result text. Throws what the host throws, after
 * the row says so.
 */
async function dispatchWithTimeline(host: DelegationToolHost, toolCall: ToolCall, ctx: ToolCallContext): Promise<string> {
  const timeline = ctx.timeline
  if (!timeline) return JSON.stringify(await dispatchDelegationTool(host, toolCall))
  const callEvent: LlmToolEvent = {
    kind: 'mcp_tool_call',
    title: `Called mousse.${toolCall.name}`,
    summary: 'The orchestrator called a Mousse tool.',
    details: ['Server: mousse', `Tool: ${toolCall.name}`]
  }
  const started = recordSubagentCall(toolCall.name, toolCall.arguments, {})
  timeline.record(callEvent, 'start', started ? { input: started.input } : undefined)
  const finish = (text: string, isError: boolean): void => {
    const record = recordSubagentCall(toolCall.name, toolCall.arguments, { text, isError })
    const resultEvent: LlmToolEvent = {
      kind: 'mcp_tool_result',
      title: callEvent.title,
      summary: isError ? 'The MCP tool returned an error.' : 'The MCP tool returned successfully.',
      details: callEvent.details,
      ...(record?.response ? { response: record.response } : {})
    }
    timeline.record(resultEvent, 'complete', record ? { input: record.input } : undefined)
  }
  let text: string
  try {
    text = JSON.stringify(await dispatchDelegationTool(host, toolCall))
  } catch (error) {
    finish(error instanceof Error ? error.message : String(error), true)
    throw error
  }
  finish(text, false)
  return text
}

/**
 * Runs one delegation tool with the pi loop's timeline rows, outside a registry (the pi replay kit
 * and tests). Throws what the host throws, after the row says so.
 */
export async function executeDelegationTool(
  host: DelegationToolHost,
  toolCall: ToolCall,
  toolEvents: LlmToolEvent[],
  onToolEvent?: (event: StreamingLlmToolEvent) => void
): Promise<ToolResultMessage> {
  const timeline: ToolTimeline = {
    record: (event, phase, extra) => {
      toolEvents.push(event)
      onToolEvent?.({ ...event, phase, callId: toolCall.id, ...extra })
    },
    emit: (event, phase) => onToolEvent?.({ ...event, phase, callId: toolCall.id })
  }
  const text = await dispatchWithTimeline(host, toolCall, { timeline } as ToolCallContext)
  return { role: 'toolResult', toolCallId: toolCall.id, toolName: toolCall.name, content: [{ type: 'text', text }], isError: false, timestamp: Date.now() }
}

/** Where a delegation call's host comes from: the in-process turn's, else the thread owner's for the MCP caller. */
export interface DelegationToolsHost {
  delegation(caller: McpCaller): DelegationToolHost
}

/**
 * The delegation tools of the registry. The listed ones carry the MCP extras (`modeCeiling`,
 * `clientRequestId`); the older names are hidden and run in process only, as before.
 */
export function delegationTools(host: DelegationToolsHost): MousseTool[] {
  const listed = new Set<string>(LISTED_DELEGATION_TOOL_NAMES)
  const tool = (definition: Tool, extra: Record<string, JsonSchema>, before?: (args: Record<string, unknown>, caller: McpCaller) => void): MousseTool => ({
    name: definition.name,
    description: definition.description,
    inputSchema: plainSchema(definition, extra),
    definition: () => definition,
    access: 'actsAsCaller',
    class: 'delegation',
    hidden: !listed.has(definition.name),
    // A read-only subagent may start (read-only) subagents and follow them; `delegateTask` checks the
    // workspace of each one. Integration writes the workspace and stays refused.
    readOnlySafe: definition.name !== 'integrate_delegation' && definition.name !== 'integrate_subagent',
    describe: () => `Called mousse.${definition.name}`,
    handler: async (args, ctx): Promise<ToolOutcome> => {
      // The ceiling checks and defaults are the MCP surface's; the in-process host applies its own.
      if (ctx.transport === 'mcp') before?.(args, ctx.caller)
      // In process, only a turn the host gave delegation tools runs them (a trusted definition never
      // has them); over MCP the thread owner builds them for the caller.
      const delegation = ctx.turn.delegation ?? (ctx.transport === 'mcp' ? host.delegation(ctx.caller) : undefined)
      if (!delegation) throw new Error(`Unknown tool: ${definition.name}`)
      const call: ToolCall = { type: 'toolCall', id: ctx.toolCallId, name: definition.name, arguments: args }
      return { text: await dispatchWithTimeline(delegation, call, ctx) }
    }
  })
  return DELEGATION_TOOLS.map((definition) => {
    if (definition.name === 'delegate_task')
      return tool(definition, {
        modeCeiling: { type: 'string', enum: ['plan', 'default'], description: 'The most the child may do. Defaults to yours and cannot exceed it.' },
        clientRequestId: CLIENT_REQUEST_ID_SCHEMA
      }, (args, caller) => {
        const requested = args.modeCeiling
        if (requested === 'default' && caller.modeCeiling === 'plan')
          throw new McpToolError('mousse_ceiling_exceeded', 'A plan-ceiling caller cannot start a child with the default ceiling.')
        if (requested === undefined) args.modeCeiling = caller.modeCeiling
      })
    if (definition.name === 'integrate_delegation')
      return tool(definition, { clientRequestId: CLIENT_REQUEST_ID_SCHEMA }, (_args, caller) => {
        if (caller.modeCeiling === 'plan')
          throw new McpToolError('mousse_ceiling_exceeded', 'Integration writes the workspace; a plan ceiling cannot integrate.')
      })
    // Both act on the caller's own subagent, which the host's handler checks; they stay `actsAsCaller`
    // like `delegate_task` rather than loosening the thread-writing scope check for other tools.
    if (definition.name === 'continue_subagent' || definition.name === 'answer_subagent')
      return tool(definition, { clientRequestId: CLIENT_REQUEST_ID_SCHEMA })
    return tool(definition, {})
  })
}
