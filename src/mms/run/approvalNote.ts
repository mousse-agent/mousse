import { redactSecrets } from '../../shared/errors'
import type { ApprovalRecord } from './ThreadApprovals'

const PROMPT_CHARS = 400
const FEEDBACK_CHARS = 300

/** One line about an action, as the user saw it, without credentials and capped. */
function describe(record: ApprovalRecord): string {
  const prompt = record.questions[0]?.prompt ?? 'an action'
  return redactSecrets(prompt.replace(/\s+/g, ' ').trim()).slice(0, PROMPT_CHARS)
}

/**
 * What a run that was started to deliver approval decisions tells its agent (SPEC §17.4): which
 * actions the user approved or denied while the agent could not be asked, that an approval covers
 * only the same action once, and which tools a crash may have cut off after they started. Empty
 * when the run delivers nothing.
 */
export function formatApprovalDecisions(records: readonly ApprovalRecord[]): string {
  const decided = records.filter((record) => record.decision)
  if (!decided.length) return ''
  const lines = decided.map((record) => {
    if (record.decision === 'allow') return `- The user approved: ${describe(record)}`
    const feedback = record.feedback ? ` Reason: ${redactSecrets(record.feedback).slice(0, FEEDBACK_CHARS)}` : ''
    return `- The user denied: ${describe(record)}${feedback}`
  })
  let text = [
    'Your previous run ended while it waited for the user to approve these actions. They were decided while you could not be asked:',
    ...lines
  ].join('\n')
  if (decided.some((record) => record.decision === 'allow'))
    text += '\nAn approved action runs once, only if you request exactly the same action again; anything else asks the user again.'
  const tools = [...new Set(decided.filter((record) => record.uncertain).flatMap((record) => record.uncertainTools ?? []))]
  if (decided.some((record) => record.uncertain))
    text += `\nThe run was cut off while a tool may have been running; check whether it already ran before repeating it${tools.length ? `: ${tools.join(', ')}` : ''}.`
  return text
}
