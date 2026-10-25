import type { SubagentNoticeItem } from '../../../shared/subagents'
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
}

export interface PlannedNotice {
  /** The wake turn's prompt or the steer text. */
  text: string
  /** The `child_result` tasks the notice reports, in order. */
  items: SubagentNoticeItem[]
}

function head(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > 200 ? `${flat.slice(0, 200)}…` : flat
}

/**
 * The notice for a batch of inbox rows; server-authored, never model-supplied. A finished task names
 * its subagent by title and thread and carries the result, inlined once: up to `NOTICE_TASK_CHARS`
 * per task and `NOTICE_WAKE_CHARS` in all. A result that fit says so; one that was cut points at
 * `task_status` for the rest.
 */
export function planWakeNotice(rows: readonly InboxRecord[], context: NoticeContext = {}): PlannedNotice {
  let budget = NOTICE_WAKE_CHARS
  const items: SubagentNoticeItem[] = []
  const lines = rows.map((row) => {
    if (row.kind !== 'child_result') return noticeText(row, context)
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
    const headline = result.runStatus === 'completed'
      ? `${who} finished task ${payload.delegationId}.`
      : `${who} ended task ${payload.delegationId} (${result.runStatus}${result.error && result.text ? `: ${head(result.error)}` : ''}).`
    const text = shown.trim() ? `${headline}\n${shown}` : headline
    return fullyShown
      ? `${text}\n${shown.trim() ? 'Full result above.' : 'It left no message.'}`
      : `${text}\n[Result cut at ${shown.length} of ${body.length} characters; call task_status with ${payload.delegationId} for the rest.]`
  })
  return { text: lines.join('\n\n'), items }
}

/** A row that is not a child's result: its own text, or for a subagent's question the question itself. */
function noticeText(row: InboxRecord, context: NoticeContext): string {
  if (isChildQuestionRow(row)) return questionNotice(row.payload as ChildQuestionPayload, context)
  const stopped = row.payload as { kind?: unknown; delegationId?: string; childThreadId?: string } | null
  if (stopped?.kind === 'delegation_stopped' && stopped.childThreadId) {
    const title = context.titleOf?.(stopped.childThreadId) ?? null
    const who = title ? `Subagent "${title}" (thread ${stopped.childThreadId})` : `Subagent thread ${stopped.childThreadId}`
    return `${who} was stopped before it finished task ${stopped.delegationId}.`
  }
  const text = (row.payload as { text?: unknown } | null)?.text
  return typeof text === 'string' && text.trim() ? text.trim() : `Mousse notice ${row.inboxId}.`
}

/** What a parent is told when its subagent waits for an answer: who asks, what, and how to answer. */
function questionNotice(payload: ChildQuestionPayload, context: NoticeContext): string {
  const title = context.titleOf?.(payload.childThreadId) ?? null
  const who = title ? `Subagent "${title}" (thread ${payload.childThreadId})` : `Subagent thread ${payload.childThreadId}`
  const prompts = context.questionPrompts?.(payload.requestId) ?? []
  const asking = prompts.length ? `\n${prompts.map((prompt) => head(prompt)).join('\n')}` : ''
  return `${who} is waiting for an answer to question ${payload.requestId}.${asking}\nAnswer it with answer_subagent (subagent "${title ?? payload.childThreadId}", requestId ${payload.requestId}), or ask the user.`
}

/** One line per inbox row; server-authored, never model-supplied. */
export function formatInboxNotice(row: InboxRecord, context: NoticeContext = {}): string {
  return planWakeNotice([row], context).text
}

/** The wake turn's prompt or steer text for a batch of rows. */
export function formatWakeNotice(rows: readonly InboxRecord[], context: NoticeContext = {}): string {
  return planWakeNotice(rows, context).text
}
