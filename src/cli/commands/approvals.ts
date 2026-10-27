import type { ParsedArgs } from '../parseArgs'
import { flagString } from '../parseArgs'
import { closeMmsContext, openMms } from '../mmsContext'
import { exitWithError, writeOutput } from '../output'
import { answerApproval, describeAnswerResult, describeApproval, listPendingApprovals } from '../interactive/approvals'

export const APPROVALS_HELP = `Usage:
  mousse-cli approvals [--thread <id>]
  mousse-cli approvals answer <requestId> <optionId> [--feedback <text>]

Lists the approval requests that wait for an answer, with their option ids and why they ask, or
answers one. A request saved before a daemon restart is answered the same way: answering continues the
thread. Another client may answer first; the command then says who did.
`

export async function runApprovals(args: ParsedArgs): Promise<void> {
  const { globals, subcommand, positional, flags } = args
  if (globals.help || subcommand === 'help') {
    process.stdout.write(APPROVALS_HELP)
    return
  }
  const context = await openMms(globals)
  try {
    const { client } = context
    if (!subcommand || subcommand === 'list') {
      const threadId = flagString(flags, 'thread') ?? globals.sessionId
      const pending = await listPendingApprovals(client, threadId)
      writeOutput(globals.mode, pending, (data) => {
        const rows = data as typeof pending
        return rows.length ? rows.map((entry) => describeApproval(entry).join('\n')).join('\n\n') : 'No approvals are waiting.'
      })
      return
    }
    if (subcommand === 'answer') {
      const [requestId, optionId] = positional
      if (!requestId || !optionId) exitWithError('approvals answer requires a request id and an option id.', globals.mode)
      const result = await answerApproval(client, requestId, optionId, { feedback: flagString(flags, 'feedback') })
      if (!result.ok) {
        if (globals.mode === 'json') writeOutput(globals.mode, result)
        exitWithError(describeAnswerResult(result), globals.mode)
      }
      writeOutput(globals.mode, { answered: requestId, option: optionId }, () => describeAnswerResult(result, optionId))
      return
    }
    exitWithError(`Unknown approvals subcommand: ${subcommand}`, globals.mode)
  } finally {
    await closeMmsContext(context)
  }
}
