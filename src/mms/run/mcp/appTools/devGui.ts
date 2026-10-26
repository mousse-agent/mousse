import { DevGuiTools, isDevGuiToolsEnabled } from '../../../devgui/DevGuiTools'
import type { AppToolHost } from './host'
import { disabledInSettings, plainSchema, truncateForDisplay, type MousseTool } from './types'

/**
 * Dev-only self-inspection of the Mousse window (`npm run dev`), for the main agent; gated by
 * Settings → Skills & MCP like every other Mousse tool. Listed only in development builds.
 */
export function devGuiTools(host: AppToolHost): MousseTool[] {
  return new DevGuiTools().getToolDefinitions().map((tool): MousseTool => ({
    name: tool.name,
    description: tool.description,
    inputSchema: plainSchema(tool),
    definition: () => tool,
    access: 'actsAsCaller',
    class: 'mutation',
    listed: () => Boolean(host.devGui) && isDevGuiToolsEnabled(),
    // Settings decide at call time too: a runtime with its own loop may have listed the tool before it was turned off.
    available: (turn) => {
      if (!isDevGuiToolsEnabled()) return 'Dev GUI tools are only available in development (`npm run dev`).'
      return turn.settingsEnabled(tool.name) ? true : disabledInSettings(tool.name)
    },
    offered: (turn) => !turn.subagent && isDevGuiToolsEnabled() && turn.settingsEnabled(tool.name) && Boolean(host.devGui),
    describe: () => `Dev GUI ${tool.name}`,
    handler: async (args, ctx) => {
      const devGui = host.devGui
      if (!devGui) throw new Error(`Unknown tool: ${tool.name}`)
      ctx.timeline?.record({
        kind: 'build_tool_call',
        title: `Dev GUI ${tool.name}`,
        summary: 'The orchestrator is inspecting the dev Electron window.',
        details: [`Tool: ${tool.name}`],
        response: JSON.stringify(args, null, 2)
      }, 'start')
      ctx.markEffect?.()
      const result = await devGui.execute(tool.name, args)
      ctx.timeline?.record({
        kind: 'build_tool_result',
        title: `Dev GUI ${tool.name}`,
        summary: result.isError ? 'The dev GUI tool returned an error.' : 'The dev GUI tool returned successfully.',
        details: [`Tool: ${tool.name}`],
        response: truncateForDisplay(result.text)
      }, 'complete')
      // A screenshot carries a vision image; every other tool is text only.
      return { text: result.text, isError: result.isError, ...(result.image ? { images: [result.image] } : {}) }
    }
  }))
}
