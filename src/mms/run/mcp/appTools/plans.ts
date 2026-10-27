import type { LlmToolEvent } from '../../../harness/turnEvents'
import { PlanModeTools } from '../../../orchestrator/PlanModeTools'
import type { AppToolHost } from './host'
import {
  abortRace,
  ASK_USER_TIMEOUT_MS,
  disabledInSettings,
  plainSchema,
  truncateForDisplay,
  type AppToolTurn,
  type Availability,
  type MousseTool,
  type ToolCallContext,
  type ToolOutcome
} from './types'

/**
 * Plan tools are offered in Plan mode and in Agent mode alike: the Agent-mode model decides whether
 * presenting a plan, asking, editing or delegating fits the turn. Subagents and Build/Skill modes
 * stay plan-free so workers implement instead of re-planning.
 */
function offeredInMode(turn: AppToolTurn): boolean {
  return !turn.discovery && (turn.modeFacts.readOnly || (!turn.subagent && turn.modeFacts.agent))
}

/** `ask_user`, `present_plan` and the unlisted `show_document`, run by `PlanModeTools`. */
export function planTools(host: AppToolHost): MousseTool[] {
  const tools = (ctx?: ToolCallContext) => new PlanModeTools(
    (questions, threadId) => host.askUser(threadId, questions, ctx?.transport === 'mcp'
      ? { signal: ctx.signal, timeoutMs: ASK_USER_TIMEOUT_MS }
      // The pi loop's questions keep the service's default wait; its stop dismisses them below.
      : {}),
    (payload) => host.openDocument?.(payload),
    (payload, threadId) => host.presentPlan(threadId, payload)
  )
  const definitions = tools()
  const run = async (name: string, args: Record<string, unknown>, ctx: ToolCallContext): Promise<ToolOutcome> => {
    const threadId = ctx.transport === 'mcp' ? ctx.caller.threadId : ctx.turn.threadId || undefined
    if (ctx.transport === 'mcp') return tools(ctx).execute(name, args, threadId)
    const callEvent: LlmToolEvent = {
      kind: 'build_tool_call',
      title: `Plan tool ${name}`,
      summary: 'The assistant called a plan tool.',
      details: [`Tool: ${name}`],
      response: JSON.stringify(args, null, 2)
    }
    ctx.timeline?.record(callEvent, 'start')
    ctx.markEffect?.()
    const execution = tools(ctx).execute(name, args, threadId)
    const result = await abortRace(execution, ctx.signal, () => { if (threadId) host.dismissQuestions?.(threadId) })
    ctx.timeline?.record({
      kind: 'build_tool_result',
      title: `Plan tool ${name}`,
      summary: result.isError ? 'The plan tool returned an error.' : 'The plan tool returned successfully.',
      details: [`Tool: ${name}`],
      response: truncateForDisplay(result.text)
    }, 'complete')
    return result
  }
  const available = (name: string) => (turn: AppToolTurn): Availability => (turn.settingsEnabled(name) ? true : disabledInSettings(name))
  const offered = (name: string) => (turn: AppToolTurn): boolean => offeredInMode(turn) && turn.settingsEnabled(name)
  return [
    ...[definitions.getAskUserToolDefinition(), definitions.getPresentPlanToolDefinition()].map((tool): MousseTool => ({
      name: tool.name,
      description: tool.name === 'ask_user'
        ? `${tool.description} Blocks until the user answers (at most one hour) or your run ends.`
        : tool.description,
      inputSchema: plainSchema(tool),
      definition: () => tool,
      access: 'actsAsCaller',
      class: 'read',
      readOnlySafe: true,
      ...(tool.name === 'ask_user' ? { asksUser: 'question' as const } : {}),
      available: available(tool.name),
      offered: offered(tool.name),
      describe: () => `Plan tool ${tool.name}`,
      handler: (args, ctx) => run(tool.name, args, ctx)
    })),
    {
      // Deprecated: no longer advertised (preview is a button on the plan card). Kept so a replayed turn
      // that already planned a call still resolves.
      name: 'show_document',
      description: 'Open a markdown document in the preview tab.',
      inputSchema: { type: 'object', properties: { title: { type: 'string' }, markdown: { type: 'string' } } },
      access: 'actsAsCaller',
      class: 'read',
      hidden: true,
      available: available('show_document'),
      offered: () => false,
      handler: (args, ctx) => run('show_document', args, ctx)
    }
  ]
}
