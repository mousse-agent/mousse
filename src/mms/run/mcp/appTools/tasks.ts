import { TaskControlTools } from '../../../tasks/TaskControlTools'
import { TaskQueue } from '../../../tasks/TaskQueue'
import type { AppToolHost } from './host'
import { CLIENT_REQUEST_ID_SCHEMA, disabledInSettings, McpToolError, plainSchema, truncateForDisplay, type MousseTool, type ToolCallContext, type ToolOutcome } from './types'

type CreateReceipt = { fingerprint: string; answer: Promise<ToolOutcome> }

/**
 * `task_create`'s receipts, per thread queue, by request key (docs/plans/tool-api.md §1.1, Retry). The key is the caller's run
 * and its `clientRequestId` (or the runtime's call id), so a provider that reuses a call id in another run makes a new task.
 * A retry gets the first answer, even after the task changed, and other arguments under the same key are refused. A run never
 * outlives this process, so memory holds every receipt its retries can reach.
 */
const createReceipts = new WeakMap<TaskQueue, Map<string, CreateReceipt>>()

async function createOnce(queue: TaskQueue, args: Record<string, unknown>, ctx: ToolCallContext): Promise<ToolOutcome> {
  const { clientRequestId, ...rest } = args
  if (clientRequestId !== undefined && (typeof clientRequestId !== 'string' || !clientRequestId)) throw new Error('clientRequestId must be a non-empty string')
  const key = `task_create:${ctx.caller.runId}:${clientRequestId ?? ctx.toolCallId}`
  const text = (value: unknown) => (typeof value === 'string' ? value.trim() : value ?? null)
  const fingerprint = JSON.stringify([text(rest.description), rest.status ?? null, text(rest.agentId)])
  const receipts = createReceipts.get(queue) ?? new Map<string, CreateReceipt>()
  createReceipts.set(queue, receipts)
  const earlier = receipts.get(key)
  if (earlier) {
    if (earlier.fingerprint !== fingerprint)
      throw new McpToolError('mousse_conflict', 'That clientRequestId was already used to create a different task; use a new one for a new task.', { conflict: 'client_request_id_conflict' })
    return earlier.answer
  }
  const answer = new TaskControlTools(queue).execute('task_create', rest)
  receipts.set(key, { fingerprint, answer })
  // A refused create made nothing: a retry may try again.
  if ((await answer).isError) receipts.delete(key)
  return answer
}

/** The thread's task-queue tools, for the main orchestrator in every chat mode (not subagents). */
export function taskTools(host: AppToolHost): MousseTool[] {
  return new TaskControlTools(new TaskQueue()).getToolDefinitions().map((tool): MousseTool => ({
    name: tool.name,
    description: tool.description,
    // `task_create` keeps its first answer under a retry's `clientRequestId` (`createOnce`).
    inputSchema: tool.name === 'task_create' ? plainSchema(tool, { clientRequestId: CLIENT_REQUEST_ID_SCHEMA }) : plainSchema(tool),
    definition: () => tool,
    access: 'actsAsCaller',
    class: 'read',
    available: (turn) => {
      if (!turn.settingsEnabled(tool.name)) return disabledInSettings(tool.name)
      return host.tasks(turn.threadId || undefined) ? true : `Unknown tool: ${tool.name}`
    },
    offered: (turn) => !turn.subagent && turn.settingsEnabled(tool.name) && Boolean(host.tasks(turn.threadId || undefined)),
    describe: () => `Task tool ${tool.name}`,
    handler: async (args, ctx) => {
      const queue = host.tasks(ctx.turn.threadId || undefined)
      if (!queue) throw new Error(`Unknown tool: ${tool.name}`)
      const execute = () => (tool.name === 'task_create' ? createOnce(queue, args, ctx) : new TaskControlTools(queue).execute(tool.name, args))
      if (ctx.transport === 'mcp') return execute()
      ctx.timeline?.record({
        kind: 'build_tool_call',
        title: `Task tool ${tool.name}`,
        summary: 'The orchestrator updated the thread task queue.',
        details: [`Tool: ${tool.name}`],
        response: JSON.stringify(args, null, 2)
      }, 'start')
      ctx.markEffect?.()
      const result = await execute()
      ctx.timeline?.record({
        kind: 'build_tool_result',
        title: `Task tool ${tool.name}`,
        summary: result.isError ? 'The task tool returned an error.' : 'The task tool returned successfully.',
        details: [`Tool: ${tool.name}`],
        response: truncateForDisplay(result.text)
      }, 'complete')
      return result
    }
  }))
}
