import { describeQuickActionKind, QuickActionTools, type StagedQuickAction } from '../../../orchestrator/QuickActionTools'
import type { UserQuestionService } from '../../../orchestrator/UserQuestionService'
import type { AppToolHost } from './host'
import { disabledInSettings, plainSchema, truncateForDisplay, type MousseTool } from './types'

/**
 * The approval an agent-created quick action needs: the same user-question flow as `ask_user`, so
 * it renders in the existing question UI (modal and inline question card).
 */
export function questionApproval(questions: Pick<UserQuestionService, 'requestAnswers'>) {
  return async (staged: StagedQuickAction, threadId: string): Promise<boolean> => {
    const preview = staged.kind === 'bash' ? `$ ${staged.payload}` : staged.payload
    const answers = await questions.requestAnswers(
      [
        {
          id: 'approval',
          prompt:
            `Create quick action "${staged.label}" (${describeQuickActionKind(staged.kind)})? ` +
            `Content: ${preview.slice(0, 300)}`,
          options: [
            { id: 'approve', label: 'Approve and create' },
            { id: 'reject', label: 'Reject' }
          ]
        }
      ],
      threadId
    )
    const decision = answers['approval']
    return decision === 'approve' || (Array.isArray(decision) && decision.includes('approve'))
  }
}

/** Agent-created quick actions: the main agent only, since each one needs the user's approval. */
export function quickActionTools(host: AppToolHost): MousseTool[] {
  const definitions = new QuickActionTools(async () => false, () => undefined).getToolDefinitions()
  return definitions.map((tool): MousseTool => ({
    name: tool.name,
    description: tool.description,
    inputSchema: plainSchema(tool),
    definition: () => tool,
    access: 'actsAsCaller',
    class: 'mutation',
    listed: () => Boolean(host.quickActions),
    available: (turn) => (turn.settingsEnabled(tool.name) ? true : disabledInSettings(tool.name)),
    offered: (turn) => !turn.subagent && turn.settingsEnabled(tool.name) && Boolean(host.quickActions),
    describe: () => `Quick action ${tool.name}`,
    handler: async (args, ctx) => {
      const quickActions = host.quickActions
      if (!quickActions) throw new Error(`Unknown tool: ${tool.name}`)
      ctx.timeline?.record({
        kind: 'build_tool_call',
        title: `Quick action ${tool.name}`,
        summary: 'The orchestrator is creating a quick action.',
        details: [`Tool: ${tool.name}`],
        response: JSON.stringify(args, null, 2)
      }, 'start')
      ctx.markEffect?.()
      const result = await quickActions.execute(tool.name, args, ctx.turn.threadId || undefined)
      ctx.timeline?.record({
        kind: 'build_tool_result',
        title: `Quick action ${tool.name}`,
        summary: result.isError ? 'The quick-action tool returned an error.' : 'The quick-action tool returned successfully.',
        details: [`Tool: ${tool.name}`],
        response: truncateForDisplay(result.text)
      }, 'complete')
      return result
    }
  }))
}
