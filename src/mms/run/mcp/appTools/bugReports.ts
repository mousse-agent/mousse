import { Type, type Tool } from '@earendil-works/pi-ai'
import type { BugReportOutcome } from '../../../../shared/bugReports'
import { BugReportError } from '../../../bugReports/BugReportService'
import type { AppToolHost } from './host'
import { plainSchema, type MousseTool, type ToolOutcome } from './types'

export const REPORT_BUG_TOOL = 'report_bug'

const REPORT_BUG_DEFINITION: Tool = {
  name: REPORT_BUG_TOOL,
  description:
    'File a bug in Mousse itself (the app you run in, not the user\'s project) on GitHub, mousse-agent/mousse. Use it for ' +
    'a Mousse error or a Mousse feature that misbehaves, when the user would want it fixed. Write a short title, what ' +
    'happened and the steps, in plain words, with no content from the user\'s chats, files, project, names or paths. ' +
    'The user sees your draft first and files it, edits it, adds diagnostics or declines. An open issue for the same ' +
    'bug gets a 👍 instead of a second issue. At most 3 a day. Unavailable when the user turned error reports off.',
  parameters: Type.Object({
    title: Type.String({ description: 'One line naming the bug, such as "Changes pane goes blank after a rename".' }),
    whatHappened: Type.String({ description: 'What went wrong, with the error message as Mousse showed it.' }),
    steps: Type.Optional(Type.String({ description: 'How to see it again.' })),
    reference: Type.Optional(Type.String({ description: 'The error\'s Reference id, when Mousse showed one.' })),
    clientRequestId: Type.Optional(Type.String({ description: 'Reuse to retry the same call.' }))
  })
}

const text = (value: unknown, max: number): string => (typeof value === 'string' ? value.trim().slice(0, max) : '')

function outcomeText(outcome: BugReportOutcome | null): string {
  if (!outcome) return 'The user did not file this report. Do not ask again unless they bring it up.'
  switch (outcome.status) {
    case 'filed': return `Filed as #${outcome.number}: ${outcome.url}`
    case 'existing': return `This bug was already open as #${outcome.number} (${outcome.url}); a 👍 was added to it.`
    case 'browser': return `It could not be filed from here: ${outcome.reason} The user was shown the prefilled page: ${outcome.url}`
    case 'limited': return outcome.message
  }
}

/**
 * `report_bug`: an agent's draft of a Mousse bug, which the person files or not in the report dialog, the same one
 * an error's Report button opens. A thread's call waits for their answer; a bot's returns at once, since its chat
 * never waits, and the dialog stays open for its owner.
 */
export function bugReportTools(host: AppToolHost): MousseTool[] {
  return [{
    name: REPORT_BUG_TOOL,
    description: REPORT_BUG_DEFINITION.description,
    botDescription: 'File a bug in Mousse itself on GitHub. Your owner sees the draft in a dialog and files it or not; this returns at once, before they answer. Write a short title, what happened and the steps, with nothing of your owner\'s chats, files, names or paths. At most 3 a day.',
    inputSchema: plainSchema(REPORT_BUG_DEFINITION),
    definition: () => REPORT_BUG_DEFINITION,
    access: 'actsAsCaller',
    class: 'mutation',
    // The person files it: an unattended run cannot ask, a bot's owner answers in the dialog.
    asksUser: 'approval',
    botAsksOwner: true,
    listed: (listing) => !listing.subagent && Boolean(host.bugReports?.()),
    available: () => (host.bugReports?.()?.settings().enabled ? true : 'Error reports are off in Settings → General.'),
    offered: (turn) => !turn.subagent && Boolean(host.bugReports?.()?.settings().enabled),
    describe: (args) => `Report a Mousse bug: ${text(args.title, 80)}`,
    handler: async (args, ctx): Promise<ToolOutcome> => {
      const service = host.bugReports?.()
      if (!service) return { text: 'Bug reports are not available here.', isError: true }
      const title = text(args.title, 200)
      const whatHappened = text(args.whatHappened, 6000)
      if (!title || !whatHappened) return { text: 'report_bug needs a title and whatHappened.', isError: true }
      const threadId = ctx.transport === 'mcp' ? ctx.caller.threadId : ctx.turn.threadId
      const bot = Boolean(ctx.turn.bot)
      try {
        ctx.markEffect?.()
        const proposal = service.propose(
          { kind: 'agent', title, message: whatHappened, steps: text(args.steps, 4000) || undefined, reference: text(args.reference, 80) || undefined, agent: bot ? 'bot' : 'agent' },
          { kind: bot ? 'bot' : 'thread', id: threadId, ...(threadId && host.threadName?.(threadId) ? { name: host.threadName(threadId)! } : {}) }
        )
        if (bot) return { text: 'Your owner was shown the draft and decides whether to file it. Say in one line that you asked; do not wait for it.' }
        const aborted = new Promise<null>((resolve) => ctx.signal.addEventListener('abort', () => resolve(null), { once: true }))
        const outcome = await Promise.race([proposal.settled, aborted])
        if (ctx.signal.aborted) return { text: 'The run ended before the user answered; the draft stays open for them.', isError: true }
        return { text: outcomeText(outcome) }
      } catch (error) {
        return { text: error instanceof BugReportError ? error.message : `The report could not be prepared: ${error instanceof Error ? error.message : String(error)}`, isError: true }
      }
    }
  }]
}
