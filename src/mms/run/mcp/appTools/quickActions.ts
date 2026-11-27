import { describeQuickActionKind, QuickActionTools, type StagedQuickAction } from '../../../orchestrator/QuickActionTools'
import type { UserQuestionService } from '../../../orchestrator/UserQuestionService'
import { RUNNING_LIST_TOOL } from '../../../running/RunningRegistry'
import type { AppToolHost } from './host'
import { disabledInSettings, plainSchema, truncateForDisplay, type MousseTool } from './types'

/**
 * The approval an agent-created quick action needs: the same user-question flow as `question_ask`, so
 * it renders in the existing question UI (modal and inline question card).
 */
export function questionApproval(questions: Pick<UserQuestionService, 'requestAnswers'>) {
  return async (staged: StagedQuickAction, threadId: string, signal?: AbortSignal): Promise<boolean> => {
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
      threadId,
      // The question goes away with the call that asked it.
      signal ? { signal } : {}
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
    // Each quick action needs the user's approval. A personal bot's owner gave it once, allowing "add quick actions": the
    // registry holds every call of a bot's turn to that grant, and nothing asks again.
    asksUser: 'approval',
    botGrantAnswers: true,
    // A button in the owner's own Actions list: an owner preference, which never passes down to a subagent.
    capabilities: ['quick_actions'],
    botDescription: 'Add a quick action for your owner: a button in their Actions list that sends a message (send-current, send-new-chat) or runs a shell command (bash) when they press it. Your owner allowed "add quick actions", so nothing asks first; add one only when they ask for it, and say what you added.',
    listed: () => Boolean(host.quickActions),
    available: (turn) => (turn.settingsEnabled(tool.name) ? true : disabledInSettings(tool.name)),
    offered: (turn) => turn.settingsEnabled(tool.name) && Boolean(host.quickActions),
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
      const result = await quickActions.execute(tool.name, args, ctx.turn.threadId || undefined, ctx.signal, { preApproved: ctx.turn.bot?.appTools.has(tool.name) === true })
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

/**
 * `running_list`: what runs now for the caller's folder, so an agent checks before it starts a dev server and reuses one
 * that is up. The same list as the turn's "Running now" note, read again now. Every agent has it: a thread's, a
 * subagent's (its parent's folder) and a bot's (its own folders).
 */
export function runningTools(host: AppToolHost): MousseTool[] {
  if (!host.running) return []
  const running = host.running
  return [{
    name: RUNNING_LIST_TOOL,
    description:
      'List what runs now for your folder: quick actions and commands in Mousse\'s terminals, background commands left running by ' +
      'this or another thread or by a bot, and other processes listening on a port there. Each has what started it, how long it ' +
      'has been up and its local address (http://localhost:<port>) when it listens or printed one. Call it before you start a ' +
      'dev server or another long-running command: reuse a running one instead of starting a second copy, and restart it only ' +
      'when the user asks or when it has to.',
    inputSchema: { type: 'object', properties: {} },
    access: 'actsAsCaller',
    class: 'read',
    readOnlySafe: true,
    describe: () => 'Check what is running',
    handler: async (_args, ctx) => ({ text: await running(ctx.turn) })
  }]
}
