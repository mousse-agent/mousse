/**
 * Approval requests in the CLI (SPEC §17): listing what waits, answering by option id, and the
 * interactive `/approve` and `/deny`. The daemon decides who may answer and who won; this only
 * speaks the protocol (`orchestrator.pendingQuestions`, `orchestrator.answerQuestions`).
 */

import { ALWAYS_OPTION_NOTE } from '../../shared/permissionKeys'
import type { ApprovalRuleInfo, PendingApprovalInfo, UserQuestion, UserQuestionOption } from '../../shared/types'

export interface ApprovalClient {
  request<T>(method: string, params?: unknown): Promise<T>
}

export interface PendingApproval {
  requestId: string
  threadId: string
  questions: UserQuestion[]
  approval?: PendingApprovalInfo
}

export interface AnswerResult {
  ok: boolean
  reason?: string
  decision?: string
  answeredBy?: { kind: string; via?: string; threadId?: string }
  cancelReason?: string
}

const REJECT_LIKE = /reject|deny|decline|cancel|dismiss|\bno\b/i

/** The saved approval requests that wait for an answer, oldest first; plain questions are not listed. */
export async function listPendingApprovals(client: ApprovalClient, threadId?: string): Promise<PendingApproval[]> {
  const result = await client.request<{ pending: PendingApproval[] }>('orchestrator.pendingQuestions', threadId ? { threadId } : {})
  return result.pending.filter((entry) => entry.approval !== undefined)
}

/** The option that allows (once), by the decision it declares. */
export function allowOption(question: UserQuestion): UserQuestionOption | undefined {
  return question.options.find((option) => option.decision === 'allow' && option.scope !== 'always')
}

/** The option that allows the same request again for the whole thread, when the request offers one. */
export function alwaysOption(question: UserQuestion): UserQuestionOption | undefined {
  return question.options.find((option) => option.decision === 'allow' && option.scope === 'always')
}

/** The option that rejects, by the decision it declares, else by what it is called. */
export function rejectOption(question: UserQuestion): UserQuestionOption | undefined {
  return question.options.find((option) => option.decision === 'reject') ?? question.options.find((option) => !option.decision && (REJECT_LIKE.test(option.id) || REJECT_LIKE.test(option.label)))
}

/** The lines that show a request: what it asks, why, what happens after a restart, and the options. */
export function describeApproval(entry: PendingApproval): string[] {
  const lines = [`Approval ${entry.requestId} (thread ${entry.threadId.slice(0, 8)})`]
  for (const question of entry.questions) {
    lines.push(...question.prompt.split('\n').map((line) => `  ${line}`))
    lines.push(`  Options: ${question.options.map((option) => `${option.id} (${option.label})`).join(', ')}`)
  }
  const info = entry.approval
  if (info?.reason) lines.push(`  Why: ${info.reason}`)
  if (entry.questions.some((question) => alwaysOption(question))) lines.push(`  ${ALWAYS_OPTION_NOTE}`)
  if (info?.answerPath === 'continue') {
    lines.push(info.uncertain
      ? `  The agent's process ended and ${info.uncertainTools?.length ? info.uncertainTools.join(', ') : 'a tool'} may already have run. Answering continues the thread.`
      : "  The agent's process ended. Answering continues the thread.")
    if (info.total && info.total > 1) lines.push(`  ${info.answered ?? 0} of ${info.total} answered; the thread continues when all are.`)
    lines.push('  Sending a message denies the pending approvals with your message as the reason.')
  }
  return lines
}

/** Answers `requestId` with `optionId`; a loser or a closed request comes back as `ok: false` with the reason. */
export async function answerApproval(
  client: ApprovalClient,
  requestId: string,
  optionId: string,
  options: { feedback?: string; threadId?: string } = {}
): Promise<AnswerResult> {
  const pending = (await listPendingApprovals(client, options.threadId)).find((entry) => entry.requestId === requestId)
  const questionId = pending?.questions[0]?.id ?? 'permission'
  if (pending && !pending.questions[0]?.options.some((option) => option.id === optionId))
    return { ok: false, reason: `unknown_option` }
  const answers: Record<string, string> = { [questionId]: optionId }
  if (options.feedback?.trim()) answers.feedback = options.feedback.trim()
  return client.request<AnswerResult>('orchestrator.answerQuestions', { requestId, answers })
}

/** The thread's "Always for this thread" rules. */
export async function listApprovalRules(client: ApprovalClient, threadId: string): Promise<ApprovalRuleInfo[]> {
  return (await client.request<{ rules: ApprovalRuleInfo[] }>('threads.approvalRules', { threadId })).rules
}

/** Revokes one rule of the thread (by id) or all of them; returns how many were removed. */
export async function revokeApprovalRules(client: ApprovalClient, threadId: string, ruleId?: string): Promise<number> {
  return (await client.request<{ removed: number }>('threads.clearApprovalRules', { threadId, ...(ruleId ? { ruleId } : {}) })).removed
}

/** The lines that show a thread's rules: the id that revokes one, what it allows, and under which mode. */
export function describeRules(rules: readonly ApprovalRuleInfo[]): string[] {
  return rules.map((rule) => `${rule.id.slice(0, 12)}  ${rule.summary}  (granted under ${rule.grantedUnder}${rule.active ? '' : '; paused while this thread is stricter'})`)
}

/** One line for the outcome of an answer. */
export function describeAnswerResult(result: AnswerResult, optionId?: string): string {
  if (result.ok) return optionId ? `Answered: ${optionId}` : 'Answered.'
  if (result.reason === 'already_answered') {
    const via = result.answeredBy?.kind === 'agent' ? 'an agent' : result.answeredBy?.via ?? 'another client'
    return `Already answered: ${result.decision ?? 'decided'} from ${via}.`
  }
  if (result.reason === 'cancelled') return `Closed without an answer (${result.cancelReason ?? 'cancelled'}).`
  if (result.reason === 'unknown_option') return 'That is not one of the request\'s options.'
  return 'Not answered: the request is gone or you may not answer it.'
}

/**
 * `/approve` and `/deny [reason]` for the latest request waiting on the thread. Returns the reply
 * to print, or null when `text` is not one of the two.
 */
export async function handleApprovalCommand(text: string, client: ApprovalClient, threadId: string): Promise<string | null> {
  const match = /^\/(approve|deny)(?:\s+([\s\S]*))?$/i.exec(text.trim())
  if (!match) return null
  const verb = match[1]!.toLowerCase()
  let rest = match[2]?.trim() ?? ''
  // `/approve always [id]`: allow this exact request again for the thread, not just once.
  let always = false
  if (verb === 'approve' && /^always(\s|$)/i.test(rest)) {
    always = true
    rest = rest.slice('always'.length).trim()
  }
  const pending = await listPendingApprovals(client, threadId)
  if (!pending.length) return 'No approval is waiting on this thread.'
  // The request is the one named by its id (four or more characters of it are enough); without an id the
  // only waiting request is meant. With several waiting, an answer for "the latest" could allow an action
  // other than the one the user read, so an id is required.
  const [first = ''] = rest.split(/\s+/)
  const named = first.length >= 4 ? pending.filter((entry) => entry.requestId.startsWith(first)) : []
  let latest: PendingApproval
  let reason = rest
  if (named.length === 1) {
    latest = named[0]!
    reason = rest.slice(first.length).trim()
  } else if (named.length > 1) {
    return `More than one waiting request starts with ${first}; give more of its id.`
  } else if (pending.length === 1) {
    latest = pending[0]!
  } else {
    return [`${pending.length} approvals are waiting; name the one you mean with /${verb} <id>:`, ...pending.map((entry) => `  ${entry.requestId}  ${(entry.questions[0]?.prompt ?? '').split('\n')[0]}`)].join('\n')
  }
  const question = latest.questions[0]
  if (!question) return 'The waiting approval has no options to answer.'
  if (verb === 'approve' && always) {
    const option = alwaysOption(question)
    if (!option) return 'This request cannot be allowed for the thread: it has no "always" option. Use /approve to allow it once.'
    return describeAnswerResult(await answerApproval(client, latest.requestId, option.id, { threadId }), option.id)
  }
  if (verb === 'approve') {
    const option = allowOption(question)
    if (!option) return 'This request has no option that allows it once.'
    return describeAnswerResult(await answerApproval(client, latest.requestId, option.id, { threadId }), option.id)
  }
  const option = rejectOption(question)
  if (!option) return 'This request has no option that denies it.'
  return describeAnswerResult(await answerApproval(client, latest.requestId, option.id, { threadId, ...(reason ? { feedback: reason } : {}) }), option.id)
}
