import type { ChildResultPayload, InboxRecord } from '../types'

/** Characters of a child's result shown in a wake notice (SPEC §14.3). */
export const NOTICE_HEAD_CHARS = 200

function head(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > NOTICE_HEAD_CHARS ? `${flat.slice(0, NOTICE_HEAD_CHARS)}…` : flat
}

/** One line per inbox row; server-authored, never model-supplied. */
export function formatInboxNotice(row: InboxRecord): string {
  if (row.kind === 'child_result') {
    const payload = row.payload as ChildResultPayload
    const result = payload.result
    if (result.runStatus === 'completed')
      return `Delegated task ${payload.delegationId} finished: ${head(result.text ?? '') || '(no text)'}. Use task_status for the full result.`
    return `Delegated task ${payload.delegationId} finished (${result.runStatus}): ${head(result.error ?? result.text ?? '') || 'no detail'}. Use task_status for the full result.`
  }
  const text = (row.payload as { text?: unknown } | null)?.text
  return typeof text === 'string' && text.trim() ? text.trim() : `Mousse notice ${row.inboxId}.`
}

/** The wake turn's prompt or steer text for a batch of rows. */
export function formatWakeNotice(rows: readonly InboxRecord[]): string {
  return rows.map(formatInboxNotice).join('\n')
}
