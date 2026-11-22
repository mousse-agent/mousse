import type { UIMessage } from 'ai'
import { readSettleNotice, type SettleNoticeItem } from '../../../shared/settleNotice'

/**
 * The settle notices a message delivers (`ChatMessage.settleNotice`, carried on the UI message's metadata): what Mousse
 * told this thread's agent about work it asked to hear about. The message text is what the model reads and is never
 * parsed here.
 */
export function readSettleNoticeMeta(message: Pick<UIMessage, 'metadata'> | undefined): SettleNoticeItem[] | null {
  return readSettleNotice((message?.metadata as { settleNotice?: unknown } | undefined)?.settleNotice) ?? null
}

export type SettleNoticeTone = 'done' | 'failed' | 'stopped' | 'waiting'

/** How a notice item reads: what happened there, and a tone for its dot. */
export function settleNoticeOutcome(item: Pick<SettleNoticeItem, 'event' | 'status'>): { verb: string; tone: SettleNoticeTone } {
  if (item.event === 'needs_input') return { verb: 'is waiting for a person', tone: 'waiting' }
  if (item.event === 'expired') return { verb: 'is still working; no longer watched', tone: 'waiting' }
  switch (item.status) {
    case 'completed':
      return { verb: 'finished', tone: 'done' }
    case 'failed':
    case 'uncertain':
      return { verb: 'failed', tone: 'failed' }
    case 'interrupted':
      return { verb: 'was stopped', tone: 'stopped' }
    case 'cancelled':
      return { verb: 'was cancelled', tone: 'stopped' }
    case 'removed':
      return { verb: 'never ran your message', tone: 'stopped' }
    case 'deleted':
      return { verb: 'was deleted', tone: 'stopped' }
    case 'unreachable':
      return { verb: 'can no longer be followed from here', tone: 'stopped' }
    default:
      return { verb: `ended (${item.status ?? 'unknown'})`, tone: 'stopped' }
  }
}

/** The name a notice gives the thread it is about. */
export function settleNoticeName(item: Pick<SettleNoticeItem, 'title'>): string {
  return item.title?.replace(/\s+/g, ' ').trim() || 'Untitled thread'
}
