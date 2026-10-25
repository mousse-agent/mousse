import type { UIMessage } from 'ai'
import type { SubagentNoticeItem } from '../../../shared/subagents'

/**
 * Subagent results a message delivers, read from the structured payload the daemon attached to it
 * (`ChatMessage.subagentNotice`, carried on the UI message's metadata). The message text is what the
 * model reads and is never parsed here.
 */
export function readSubagentNotice(message: Pick<UIMessage, 'metadata'> | undefined): SubagentNoticeItem[] | null {
  const raw = (message?.metadata as { subagentNotice?: unknown } | undefined)?.subagentNotice
  if (!Array.isArray(raw)) return null
  const items = raw.filter(isNoticeItem)
  return items.length > 0 ? items : null
}

function isNoticeItem(value: unknown): value is SubagentNoticeItem {
  if (!value || typeof value !== 'object') return false
  const item = value as Record<string, unknown>
  return typeof item.delegationId === 'string' && typeof item.childThreadId === 'string' && typeof item.runStatus === 'string'
}

export type SubagentNoticeTone = 'done' | 'failed' | 'stopped'

/** How a notice item reads: its run status as a verb and a tone for the row. */
export function noticeOutcome(item: Pick<SubagentNoticeItem, 'runStatus'>): { verb: string; tone: SubagentNoticeTone } {
  switch (item.runStatus) {
    case 'completed':
      return { verb: 'finished', tone: 'done' }
    case 'failed':
    case 'uncertain':
      return { verb: 'failed', tone: 'failed' }
    case 'cancelled':
      return { verb: 'was stopped', tone: 'stopped' }
    case 'interrupted':
      return { verb: 'was interrupted', tone: 'stopped' }
    default:
      return { verb: `ended (${item.runStatus})`, tone: 'stopped' }
  }
}

/** The name a notice item gives its subagent; a subagent without a title is just "Subagent". */
export function noticeItemName(item: Pick<SubagentNoticeItem, 'title'>): string {
  return item.title?.replace(/\s+/g, ' ').trim() || 'Subagent'
}

/** One line for a notice: "API reviewer finished", or a count when it reports several. */
export function noticeSummary(items: readonly SubagentNoticeItem[]): string {
  if (items.length === 0) return 'Subagent result'
  if (items.length === 1) return `${noticeItemName(items[0]!)} ${noticeOutcome(items[0]!).verb}`
  const verbs = new Set(items.map((item) => noticeOutcome(item).verb))
  return verbs.size === 1 ? `${items.length} subagents ${[...verbs][0]!.replace(/^was /, 'were ')}` : `${items.length} subagent results`
}
