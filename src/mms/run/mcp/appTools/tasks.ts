import { TaskControlTools } from '../../../tasks/TaskControlTools'
import { TaskQueue } from '../../../tasks/TaskQueue'
import type { AppToolHost } from './host'
import { disabledInSettings, plainSchema, truncateForDisplay, type MousseTool } from './types'

/** The thread's task-queue tools, for the main orchestrator in every chat mode (not subagents). */
export function taskTools(host: AppToolHost): MousseTool[] {
  return new TaskControlTools(new TaskQueue()).getToolDefinitions().map((tool): MousseTool => ({
    name: tool.name,
    description: tool.description,
    inputSchema: plainSchema(tool),
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
      if (ctx.transport === 'mcp') return new TaskControlTools(queue).execute(tool.name, args)
      ctx.timeline?.record({
        kind: 'build_tool_call',
        title: `Task tool ${tool.name}`,
        summary: 'The orchestrator updated the thread task queue.',
        details: [`Tool: ${tool.name}`],
        response: JSON.stringify(args, null, 2)
      }, 'start')
      ctx.markEffect?.()
      const result = await new TaskControlTools(queue).execute(tool.name, args)
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
