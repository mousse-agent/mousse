import type { SubagentNoticeItem } from '../../../shared/subagents'
import type { ChildResultPayload, InboxRecord } from '../types'

/** Characters of one subagent's result a notice shows (issue #142: the result is inlined once). */
export const NOTICE_TASK_CHARS = 4_000

/** Characters of results one notice shows in all. */
export const NOTICE_WAKE_CHARS = 16_000

/** What a notice may name besides the rows: a subagent's current title. */
export interface NoticeContext {
  titleOf?(threadId: string): string | undefined
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
    if (row.kind !== 'child_result') return noticeText(row)
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

/** A row that is not a child's result: its own text. */
function noticeText(row: InboxRecord): string {
  const text = (row.payload as { text?: unknown } | null)?.text
  return typeof text === 'string' && text.trim() ? text.trim() : `Mousse notice ${row.inboxId}.`
}

/** One line per inbox row; server-authored, never model-supplied. */
export function formatInboxNotice(row: InboxRecord, context: NoticeContext = {}): string {
  return planWakeNotice([row], context).text
}

/** The wake turn's prompt or steer text for a batch of rows. */
export function formatWakeNotice(rows: readonly InboxRecord[], context: NoticeContext = {}): string {
  return planWakeNotice(rows, context).text
}
