import { WebTools } from '../../../orchestrator/WebTools'
import type { AppToolHost } from './host'
import { disabledInSettings, plainSchema, type MousseTool } from './types'

/** `web_search` and `web_fetch`; their provider keys stay in Mousse (never in a runtime's env). */
export function webTools(host: AppToolHost): MousseTool[] {
  const definitions = new WebTools({ read: async () => undefined } as unknown as ConstructorParameters<typeof WebTools>[0]).getToolDefinitions()
  return definitions.map((tool): MousseTool => ({
    name: tool.name,
    description: tool.description,
    inputSchema: plainSchema(tool),
    definition: () => tool,
    access: 'reads',
    class: 'read',
    listed: () => Boolean(host.web),
    available: (turn) => (turn.settingsEnabled(tool.name) ? true : disabledInSettings(tool.name)),
    offered: (turn) => turn.settingsEnabled(tool.name) && Boolean(host.web),
    describe: () => `Web tool ${tool.name}`,
    handler: async (args, ctx) => {
      const web = host.web
      if (!web) throw new Error(`Unknown tool: ${tool.name}`)
      const event = { kind: 'build_tool_call' as const, title: `Web tool ${tool.name}`, summary: `Running ${tool.name}.`, details: [`Tool: ${tool.name}`] }
      ctx.timeline?.emit(event, 'start')
      const result = await web.execute(tool.name, args, ctx.signal)
      ctx.timeline?.emit({ ...event, summary: result.isError ? result.text : `Completed ${tool.name}.` }, 'complete')
      return result
    }
  }))
}
