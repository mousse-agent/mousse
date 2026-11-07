import { BOT_CHAT_PACK_BUDGET, estimateTokens } from '../../../shared/bots/personal/memory'
import type { BotJournalRow } from './BotMemoryStore'
import { guardPackText } from './guard'
import { cut, dayLabel } from './render'

/**
 * The chat summary (docs/plans/bot-context.md §5.1): a deterministic fold of the chat rows the
 * verbatim window dropped, newest first, older lines falling off at its budget. Each line keeps the
 * seq of the row it came from, so a forget can rebuild the summary without the redacted rows.
 */

export interface ChatSummaryState {
  text: string
  /** Newest first. */
  lines: string[]
  /** The seq of the journal row each line came from, aligned with `lines` (absent before forget tracked it). */
  sources?: number[]
  throughSeq: number
  at: string
}

export const SUMMARY_HEADER = 'Chat summary (older chat, newest first; memory_search finds the full rows):'

type Who = 'Owner' | 'Me' | 'My run report'

export function speaker(row: BotJournalRow): Who {
  return row.kind === 'owner_msg' ? 'Owner' : row.kind === 'run_report' ? 'My run report' : 'Me'
}

/** A journal row's text as it may enter a pack: held back when the guard refuses it. */
export function packText(row: BotJournalRow): string {
  if (row.redactedAt) return row.text
  const guard = guardPackText(row.text, row.who)
  return guard.ok ? row.text : `(held back: ${guard.message.toLowerCase().replace(/\.$/, '')}. memory_read j${row.seq} shows it.)`
}

export function firstLine(text: string): string {
  return text.trim().split(/\n+/)[0] ?? ''
}

function firstSentence(text: string): string {
  const line = firstLine(text)
  const match = /^(.+?[.!?])(\s|$)/u.exec(line)
  return match ? match[1]! : line
}

/** Joins lines into at most `budget` tokens, in order; lines that do not fit are left out. */
export function withinBudget(lines: readonly string[], budget: number): string[] {
  const kept: string[] = []
  let used = 0
  for (const line of lines) {
    const tokens = estimateTokens(line) + 1
    if (used + tokens > budget) break
    kept.push(line)
    used += tokens
  }
  return kept
}

/** The summary line a dropped row folds into, or undefined (a redacted row, a Mousse-made prompt, an empty row). */
function summaryLine(row: BotJournalRow, zone: string | undefined): string | undefined {
  if (row.redactedAt) return undefined
  const text = packText(row)
  if (!text.trim() || (row.kind === 'owner_msg' && text.startsWith('[Mousse '))) return undefined
  const body = row.kind === 'owner_msg' ? cut(text, 300) : row.kind === 'run_report' ? cut(firstLine(text), 300) : cut(firstSentence(text), 300)
  return `- ${dayLabel(row.at, zone)} · ${speaker(row)}: ${body}`
}

/**
 * Folds `dropped` (oldest first) ahead of the previous summary's lines: newest first, each line
 * once, within the summary budget. With no previous summary, `dropped` is everything folded so far.
 */
export function foldChatSummary(
  dropped: readonly BotJournalRow[],
  previous: Pick<ChatSummaryState, 'lines' | 'sources'> | undefined,
  zone: string | undefined,
  at: string
): ChatSummaryState {
  const fresh: Array<{ line: string; seq: number }> = []
  for (const row of [...dropped].reverse()) {
    const line = summaryLine(row, zone)
    if (line) fresh.push({ line, seq: row.seq })
  }
  // A summary from before sources were kept: its lines count as the oldest folded row's.
  const old = (previous?.lines ?? []).map((line, index) => ({ line, seq: previous?.sources?.[index] ?? 0 }))
  const seen = new Set<string>()
  const unique = [...fresh, ...old].filter((entry) => !seen.has(entry.line) && Boolean(seen.add(entry.line)))
  const lines = withinBudget(unique.map((entry) => entry.line), BOT_CHAT_PACK_BUDGET.summary - estimateTokens(SUMMARY_HEADER) - 1)
  return {
    text: [SUMMARY_HEADER, ...lines].join('\n'),
    lines,
    sources: unique.slice(0, lines.length).map((entry) => entry.seq),
    throughSeq: dropped.length ? dropped[dropped.length - 1]!.seq : 0,
    at
  }
}
