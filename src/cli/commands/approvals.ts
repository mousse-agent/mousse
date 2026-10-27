import type { ParsedArgs } from '../parseArgs'
import { flagString } from '../parseArgs'
import { closeMmsContext, openMms } from '../mmsContext'
import { exitWithError, writeOutput } from '../output'
import {
  answerApproval,
  describeAnswerResult,
  describeApproval,
  describeRules,
  listApprovalRules,
  listPendingApprovals,
  revokeApprovalRules
} from '../interactive/approvals'

export const APPROVALS_HELP = `Usage:
  mousse-cli approvals [--thread <id>]
  mousse-cli approvals answer <requestId> <optionId> [--feedback <text>]
  mousse-cli approvals rules <threadId>
  mousse-cli approvals reset <threadId> [ruleId]

Lists the approval requests that wait for an answer, with their option ids and why they ask, or
answers one. A request saved before a daemon restart is answered the same way: answering continues the
thread. Another client may answer first; the command then says who did.

A request may offer the option allow_always ("Always for this thread"): answer it with that id to allow
this exact request again, in this thread only, without asking. Other commands, folders and tools still
ask, and the rule is ignored while the thread's permission mode is stricter than when it was made.
"rules" lists a thread's rules; "reset" revokes one (by the start of its id) or all of them.
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
    if (subcommand === 'rules') {
      const threadId = positional[0] ?? flagString(flags, 'thread') ?? globals.sessionId
      if (!threadId) exitWithError('approvals rules requires a thread id.', globals.mode)
      const rules = await listApprovalRules(client, threadId)
      writeOutput(globals.mode, rules, (data) => {
        const rows = data as typeof rules
        return rows.length ? describeRules(rows).join('\n') : 'No "always" rules on this thread.'
      })
      return
    }
    if (subcommand === 'reset') {
      const [threadId, ruleId] = positional
      if (!threadId) exitWithError('approvals reset requires a thread id.', globals.mode)
      // A rule is named by the start of its id (eight characters are enough); the daemon is given the whole id.
      let fullId: string | undefined
      if (ruleId) {
        const matches = ruleId.length >= 8 ? (await listApprovalRules(client, threadId)).filter((rule) => rule.id.startsWith(ruleId)) : []
        if (matches.length !== 1) exitWithError(matches.length > 1 ? `More than one rule starts with ${ruleId}; give more of its id.` : `No rule of this thread starts with ${ruleId} (give at least eight characters).`, globals.mode)
        fullId = matches[0]!.id
      }
      const removed = await revokeApprovalRules(client, threadId, fullId)
      writeOutput(globals.mode, { removed }, () => (removed ? `Revoked ${removed} rule${removed === 1 ? '' : 's'}.` : 'No rules to revoke.'))
      return
    }
    exitWithError(`Unknown approvals subcommand: ${subcommand}`, globals.mode)
  } finally {
    await closeMmsContext(context)
  }
}
