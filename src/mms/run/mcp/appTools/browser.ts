import type { Tool } from '@earendil-works/pi-ai'
import { BROWSER_AUTOMATION_TOOLS, type BrowserAutomationTool } from '../../../../shared/browser/automation'
import type { BrowserRuntimePort } from '../../../../shared/browser/runtime'
import {
  BROWSER_READ_TOOLS,
  dispatchBrowserTool,
  getBrowserToolDefinitions,
  resolveTrustedBrowserTarget
} from '../../../orchestrator/browser'
import type { LlmToolEvent } from '../../../harness/turnEvents'
import type { AppToolHost } from './host'
import { disabledInSettings, plainSchema, type AppToolTurn, type MousseTool, type ToolOutcome } from './types'

/** The runtime a turn's browser tools run on: its host's own (an agent chat's), else the profile's. */
function runtimeFor(host: AppToolHost, turn: AppToolTurn): BrowserRuntimePort | undefined {
  return turn.browserRuntime ?? host.browserRuntime?.()
}

/** The browser tools as a turn's binding offers them (vision, backend and screenshot support). */
function turnDefinitions(host: AppToolHost, turn: AppToolTurn): Tool[] {
  const runtime = runtimeFor(host, turn)
  const binding = turn.browser
  if (!runtime || !binding || binding.mode !== 'structured') return []
  return getBrowserToolDefinitions({
    vision: binding.vision === true,
    backend: resolveTrustedBrowserTarget(runtime, binding.execution).target?.backend ?? 'electron-attached',
    screenshots: runtime.capabilities?.(binding.execution)?.screenshots
  })
}

/**
 * The host-bound browser tools. A native MCP client lists every one with the widest schema (a
 * vision binding with screenshots) so its list stays stable; the turn's binding decides at call time
 * what runs, and an in-process loop (or a runtime sent a definition turn's tools) is sent the turn's
 * own definitions.
 */
export function browserTools(host: AppToolHost): MousseTool[] {
  const listing = getBrowserToolDefinitions({ vision: true, screenshots: true })
  const perTurn = new WeakMap<AppToolTurn, Tool[]>()
  const definitions = (turn: AppToolTurn): Tool[] => {
    let tools = perTurn.get(turn)
    if (!tools) perTurn.set(turn, (tools = turnDefinitions(host, turn)))
    return tools
  }
  // In the order the pi loop has always sent them.
  const names = [...listing.map((tool) => tool.name), ...BROWSER_AUTOMATION_TOOLS.filter((name) => !listing.some((tool) => tool.name === name))]
  return names.map((name): MousseTool => {
    const listed = listing.find((tool) => tool.name === name) ?? { name, description: name, parameters: { type: 'object', properties: {} } as unknown as Tool['parameters'] }
    return {
      name,
      description: listed.description,
      inputSchema: plainSchema(listed),
      definition: (turn) => definitions(turn).find((tool) => tool.name === name) ?? listed,
      access: 'actsAsCaller',
      class: BROWSER_READ_TOOLS.has(name as BrowserAutomationTool) ? 'read' : 'mutation',
      listed: () => Boolean(host.browserRuntime?.()),
      available: (turn) => {
        const runtime = runtimeFor(host, turn)
        if (!runtime || !turn.browser || turn.browser.mode === 'disabled')
          return runtime
            ? 'Browser tools are not bound for this turn. Root must supply a trusted execution context.'
            : 'Browser runtime is not bound. Call setBrowserRuntime before dispatching browser tools.'
        if (!turn.trusted && !turn.settingsEnabled(name)) return disabledInSettings(name)
        return true
      },
      offered: (turn) => Boolean(turn.browser) && turn.settingsEnabled(name) &&
        turn.browser!.policy.allowedTools.includes(name) && definitions(turn).some((tool) => tool.name === name),
      describe: () => `Browser tool ${name}`,
      handler: async (args, ctx): Promise<ToolOutcome> => {
        const runtime = runtimeFor(host, ctx.turn)
        const binding = ctx.turn.browser
        if (!runtime || !binding) throw new Error('Browser runtime is not bound. Call setBrowserRuntime before dispatching browser tools.')
        const callEvent: LlmToolEvent = {
          kind: 'build_tool_call',
          title: `Browser tool ${name}`,
          summary: 'The assistant called a host-bound browser tool.',
          details: [`Tool: ${name}`],
          response: JSON.stringify(args, null, 2)
        }
        ctx.timeline?.record(callEvent, 'start')
        const result = await dispatchBrowserTool({ port: runtime, binding, name, args, signal: ctx.signal })
        if (result.dispatched) ctx.markEffect?.()
        ctx.timeline?.record({
          kind: 'build_tool_result',
          title: `Browser tool ${name}`,
          summary: result.isError ? 'The browser tool returned an error.' : 'The browser tool returned successfully.',
          details: [`Tool: ${name}`],
          response: result.text
        }, 'complete')
        return {
          text: result.text,
          isError: result.isError,
          ...(result.image && binding.vision ? { images: [{ data: result.image.data, mimeType: result.image.mimeType }] } : {})
        }
      }
    }
  })
}
