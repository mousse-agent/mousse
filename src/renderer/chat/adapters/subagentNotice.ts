import type { UIMessage } from 'ai'
import type { SubagentNoticeItem } from '../../../shared/subagents'
import type { MonitorEnd } from '../../../shared/backgroundWork'

/**
 * What a message delivers about subagents (results, a question, a stop), read from the structured payload the daemon attached to it
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

export type SubagentNoticeTone = 'done' | 'failed' | 'stopped' | 'asking'

/** How a notice item reads: what it reports as a verb and a tone for the row. */
export function noticeOutcome(item: Pick<SubagentNoticeItem, 'runStatus' | 'event'>): { verb: string; tone: SubagentNoticeTone } {
  if (item.event === 'question') return { verb: 'asked a question', tone: 'asking' }
  if (item.event === 'stopped') return { verb: 'was stopped', tone: 'stopped' }
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

const MONITOR_KIND_WORDS = { command: 'Monitor', url: 'Monitor', background: 'Command', keep_working: 'Waiting' } as const

const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`

/** How a monitor's end reads for the person: "finished", "exited with code 3", "timed out after 10 min". */
export function monitorEndWords(end: MonitorEnd): { words: string; tone: SubagentNoticeTone } {
  switch (end.reason) {
    case 'exit':
      if (end.signal) return { words: `ended by ${end.signal}`, tone: 'stopped' }
      return end.code === 0 ? { words: 'finished', tone: 'done' } : { words: `exited with code ${end.code ?? 'unknown'}`, tone: 'failed' }
    case 'closed':
      return { words: `connection closed (${end.code}${end.detail ? `, ${end.detail}` : ''})`, tone: end.code === 1000 ? 'done' : 'stopped' }
    case 'failed':
      return { words: 'could not run', tone: 'failed' }
    case 'timeout':
      return { words: `timed out after ${end.minutes} min`, tone: 'stopped' }
    case 'chatty':
      return { words: 'stopped: too much output', tone: 'failed' }
    case 'stopped':
      return { words: 'stopped by you', tone: 'stopped' }
    case 'thread_stopped':
      return { words: 'stopped with the thread', tone: 'stopped' }
    case 'restart':
      return { words: 'ended when Mousse restarted', tone: 'stopped' }
  }
}

/** A monitor notice's row: its name ("Monitor “Build log”") and what it says ("3 new lines", "finished"). */
export function monitorNoticeLine(item: Pick<SubagentNoticeItem, 'title' | 'monitor'>): { name: string; detail: string; tone: SubagentNoticeTone } {
  const monitor = item.monitor
  const kind = monitor ? MONITOR_KIND_WORDS[monitor.kind] : 'Monitor'
  const title = item.title?.replace(/\s+/g, ' ').trim()
  const name = title ? `${kind} “${title}”` : kind
  const count = (monitor?.lines.length ?? 0) + (monitor?.dropped ?? 0)
  const lines = count ? plural(count, 'new line', 'new lines') : ''
  if (!monitor?.end) return { name, detail: lines || 'reported', tone: 'done' }
  const { words, tone } = monitorEndWords(monitor.end)
  return { name, detail: lines ? `${lines} · ${words}` : words, tone }
}

// `person`: the person's correction to an ancestor, relayed down its tree; `relay`: where that correction went.
const NOTE_FROM_WORDS = { parent: 'Parent', ancestor: 'Agent above', subagent: 'Subagent', sibling: 'Sibling subagent', bot: 'Bot', person: 'From you, via', relay: 'Also told subagents' } as const

/** A note's row: who sent it ("Subagent “Reviewer”"). */
export function noteNoticeName(item: Pick<SubagentNoticeItem, 'title' | 'note'>): string {
  const who = item.note ? NOTE_FROM_WORDS[item.note.from] : 'Agent'
  const title = item.title?.replace(/\s+/g, ' ').trim()
  return title ? `${who} “${title}”` : who
}

/**
 * A wake-up's row: "Wake-up" and what happened ("Following up · acme/app#12 merged" reads "acme/app#12 merged"). It
 * opens on what the agent wrote for itself.
 */
export function wakeNoticeLine(item: Pick<SubagentNoticeItem, 'title'>): { name: string; detail: string; tone: SubagentNoticeTone } {
  const what = item.title?.replace(/\s+/g, ' ').trim().replace(/^Following up(?: · )?/, '') ?? ''
  return { name: 'Wake-up', detail: what || 'due', tone: 'done' }
}
