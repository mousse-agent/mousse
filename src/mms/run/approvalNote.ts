import { redactSecrets } from '../../shared/errors'
import type { ApprovalRecord } from './ThreadApprovals'

const PROMPT_CHARS = 400
const FEEDBACK_CHARS = 300

/** One line about an action, as the user saw it, without credentials and capped. */
export function describeApproval(record: Pick<ApprovalRecord, 'questions'>): string {
  const prompt = record.questions[0]?.prompt ?? 'an action'
  return redactSecrets(prompt.replace(/\s+/g, ' ').trim()).slice(0, PROMPT_CHARS)
}
const describe = describeApproval

/** Who decided, in the words the resumed agent reads: the user, or an agent of another thread (never passed off as the user). */
function decider(record: ApprovalRecord, titleOf?: (threadId: string) => string | undefined): string {
  const by = record.answeredBy
  if (by?.kind !== 'agent') return 'The user'
  const title = titleOf?.(by.threadId)
  return `An agent in thread ${title ? `"${title}" ` : ''}(${by.threadId}), not the user,`
}

/**
 * What a run that was started to deliver approval decisions tells its agent (SPEC §17.4): which
 * actions the user approved or denied while the agent could not be asked, that an approval covers
 * only the same action once, and which tools a crash may have cut off after they started. Empty
 * when the run delivers nothing.
 */
export function formatApprovalDecisions(records: readonly ApprovalRecord[], titleOf?: (threadId: string) => string | undefined): string {
  const decided = records.filter((record) => record.decision)
  if (!decided.length) return ''
  const lines = decided.map((record) => {
    const who = decider(record, titleOf)
    if (record.decision === 'allow') return `- ${who} approved: ${describe(record)}`
    const feedback = record.feedback ? ` Reason: ${redactSecrets(record.feedback).slice(0, FEEDBACK_CHARS)}` : ''
    return `- ${who} denied: ${describe(record)}${feedback}`
  })
  let text = [
    'Your previous run ended while it waited for an answer to these approvals. They were decided while you could not be asked:',
    ...lines
  ].join('\n')
  if (decided.some((record) => record.decision === 'allow'))
    text += '\nAn approved action runs once, only if you request exactly the same action again; anything else asks the user again.'
  const tools = [...new Set(decided.filter((record) => record.uncertain).flatMap((record) => record.uncertainTools ?? []))]
  if (decided.some((record) => record.uncertain))
    text += `\nThe run was cut off while a tool may have been running; check whether it already ran before repeating it${tools.length ? `: ${tools.join(', ')}` : ''}.`
  return text
}
