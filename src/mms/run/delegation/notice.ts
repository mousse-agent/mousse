import { notice, quoted, relayed, type NoticePart } from '../../../shared/mousseContext'
import type { SubagentNoticeItem } from '../../../shared/subagents'
import { isQuestionAnswerRow, type QuestionAnswerPayload } from '../OpenQuestions'
import { isChildQuestionRow, type ChildQuestionPayload, type ChildResultPayload, type InboxRecord } from '../types'

/** Characters of one subagent's result a notice shows (issue #142: the result is inlined once). */
export const NOTICE_TASK_CHARS = 4_000

/** Characters of results one notice shows in all. */
export const NOTICE_WAKE_CHARS = 16_000

/** What a notice may name besides the rows: a subagent's current title and what it is asking. */
export interface NoticeContext {
  titleOf?(threadId: string): string | undefined
  /** The prompts of the pending question `requestId`, or null when it is not pending any more. */
  questionPrompts?(requestId: string): string[] | null
  /** What a finished task left in its folder and Git (`formatSubagentResultReport`), when it is known. */
  resultReport?(payload: ChildResultPayload): string | undefined
}

export interface PlannedNotice {
  /** The wake turn's prompt or the steer text. */
  text: string
  /**
   * What the notice reports about subagents, in order: a finished task, a subagent's question, a task that was stopped.
   * The app shows these and never the text; a notice with none is shown as its text.
   */
  items: SubagentNoticeItem[]
}

function head(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > 200 ? `${flat.slice(0, 200)}…` : flat
}

/**
 * The notice for a batch of inbox rows; server-authored, never model-supplied. Each subagent row is one
 * `<mousse_notice>` with the task's delegation id as its `ref`. A finished task names its subagent by
 * title and thread and quotes the result, inlined once: up to `NOTICE_TASK_CHARS` per task and
 * `NOTICE_WAKE_CHARS` in all. One that was cut points at `task_status` for the rest.
 */
export function planWakeNotice(rows: readonly InboxRecord[], context: NoticeContext = {}): PlannedNotice {
  let budget = NOTICE_WAKE_CHARS
  const items: SubagentNoticeItem[] = []
  const lines = rows.map((row) => {
    if (row.kind !== 'child_result') return noticeText(row, context, items)
    const payload = row.payload as ChildResultPayload
    const { result } = payload
    const title = context.titleOf?.(payload.childThreadId) ?? null
    const who = title ? `Subagent "${title}" (thread ${payload.childThreadId})` : `Subagent thread ${payload.childThreadId}`
    const body = (result.runStatus === 'completed' ? result.text : result.text || result.error) ?? ''
    const allowed = Math.max(0, Math.min(NOTICE_TASK_CHARS, budget))
    const shown = body.slice(0, allowed)
    budget -= shown.length
    const fullyShown = shown.length === body.length
    items.push({ delegationId: payload.delegationId, childThreadId: payload.childThreadId, title, runStatus: result.runStatus, fullyShown })
    const parts: NoticePart[] = [result.runStatus === 'completed'
      ? `${who} finished its task.`
      : `${who} ended its task (${result.runStatus}${result.error && result.text ? `: ${head(result.error)}` : ''}).`]
    if (shown.trim()) parts.push(quoted('subagent result', shown))
    else if (fullyShown) parts.push('It left no message.')
    if (!fullyShown) parts.push(`The result is cut at ${shown.length} of ${body.length} characters; call task_status with ${payload.delegationId} for the rest.`)
    // The files and Git state it left, outside the text budget: Mousse merges nothing, the parent brings them in.
    const workspace = context.resultReport?.(payload)
    if (workspace) parts.push(workspace)
    return notice({ kind: 'subagent_result', ref: payload.delegationId }, parts)
  })
  return { text: lines.join('\n\n'), items }
}

/**
 * A row that is not a child's result: its own text, or for a subagent's question the question itself. A row about a
 * subagent adds what the app shows for it to `items`.
 */
function noticeText(row: InboxRecord, context: NoticeContext, items: SubagentNoticeItem[]): string {
  if (isQuestionAnswerRow(row)) {
    const payload = row.payload as QuestionAnswerPayload
    items.push({
      delegationId: '',
      childThreadId: row.threadId,
      title: null,
      runStatus: payload.dismissed ? 'dismissed' : 'answered',
      fullyShown: true,
      event: 'answer',
      requestId: payload.requestId,
      answers: payload.answered
    })
    return questionAnswerNotice(payload)
  }
  if (isChildQuestionRow(row)) {
    const payload = row.payload as ChildQuestionPayload
    items.push({
      delegationId: payload.delegationId ?? '',
      childThreadId: payload.childThreadId,
      title: context.titleOf?.(payload.childThreadId) ?? null,
      runStatus: 'needs_input',
      fullyShown: true,
      event: 'question',
      requestId: payload.requestId
    })
    return questionNotice(payload, context)
  }
  const stopped = row.payload as { kind?: unknown; delegationId?: string; childThreadId?: string } | null
  if (stopped?.kind === 'delegation_stopped' && stopped.childThreadId) {
    const title = context.titleOf?.(stopped.childThreadId) ?? null
    items.push({ delegationId: stopped.delegationId ?? '', childThreadId: stopped.childThreadId, title, runStatus: 'cancelled', fullyShown: true, event: 'stopped' })
    const who = title ? `Subagent "${title}" (thread ${stopped.childThreadId})` : `Subagent thread ${stopped.childThreadId}`
    return notice({ kind: 'subagent_stopped', ...(stopped.delegationId ? { ref: stopped.delegationId } : {}) }, [`${who} was stopped before it finished its task.`])
  }
  const text = (row.payload as { text?: unknown } | null)?.text
  return typeof text === 'string' && text.trim() ? text.trim() : `Mousse notice ${row.inboxId}.`
}

/** What a parent is told when its subagent waits for an answer: who asks, what, and how to answer. */
function questionNotice(payload: ChildQuestionPayload, context: NoticeContext): string {
  const title = context.titleOf?.(payload.childThreadId) ?? null
  const who = title ? `Subagent "${title}" (thread ${payload.childThreadId})` : `Subagent thread ${payload.childThreadId}`
  const prompts = context.questionPrompts?.(payload.requestId) ?? []
  const parts: NoticePart[] = [`${who} is waiting for an answer to question ${payload.requestId}.`]
  if (prompts.length) parts.push(quoted('subagent question', prompts.map((prompt) => head(prompt)).join('\n')))
  parts.push(`Answer it with answer_subagent (subagent "${title ?? payload.childThreadId}", requestId ${payload.requestId}), or ask the user.`)
  return notice({ kind: 'subagent_question', ...(payload.delegationId ? { ref: payload.delegationId } : {}) }, parts)
}

/**
 * What the agent is told when the person answers (or dismisses) a question it asked without waiting: a notice with the
 * question's id as its `ref`, then each question by its id, with what the person chose and typed as their own words
 * (`<mousse_message from="user">`).
 */
function questionAnswerNotice(payload: QuestionAnswerPayload): string {
  if (payload.dismissed)
    return notice({ kind: 'question_dismissed', ref: payload.requestId }, [`The user dismissed your open question ${payload.requestId} without answering it. Decide it yourself, and say what you chose.`])
  const parts: NoticePart[] = [`The user answered your open question ${payload.requestId}.`]
  payload.answered.forEach((answer, index) => {
    const id = payload.questionIds[index] ?? String(index + 1)
    const said = [
      ...(answer.chosen.length ? [`Chose ${answer.chosen.map((label) => JSON.stringify(label)).join(', ')}.`] : []),
      ...(answer.reply?.trim() ? [answer.reply.trim()] : [])
    ]
    const question = `Question ${id} (${JSON.stringify(head(answer.prompt))})`
    if (!said.length) parts.push(`${question}: no answer.`)
    else parts.push(`${question}:`, relayed('user', said.join('\n')))
  })
  return notice({ kind: 'question_answered', ref: payload.requestId }, parts)
}

/** One line per inbox row; server-authored, never model-supplied. */
export function formatInboxNotice(row: InboxRecord, context: NoticeContext = {}): string {
  return planWakeNotice([row], context).text
}

/** The wake turn's prompt or steer text for a batch of rows. */
export function formatWakeNotice(rows: readonly InboxRecord[], context: NoticeContext = {}): string {
  return planWakeNotice(rows, context).text
}
