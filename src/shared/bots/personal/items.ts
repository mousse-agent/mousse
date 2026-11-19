import { parseThreadLink } from '../../threadLink'
import { jobLine, jobStateWords, type BotJob } from './jobs'
import { estimateTokens } from './memory'

/**
 * A bot's open items (docs/bot-memory.md, "Open items"): what its owner asked for and what the bot promised, kept until
 * it is delivered or dropped. The chat summary keeps rules and decisions but lets pending things go, so the items are a
 * list of their own that every chat turn carries: one short line each, with how it stands, the chat row it came from
 * (`j123`, which `memory_read` shows in full) and the threads, pull requests or pages that belong to it. The bot keeps
 * the list with `item_save`; Mousse adds what it can see by itself (a thread the bot handed an owner's request to) and
 * what a chat digest finds still open and unlisted. Browser-safe.
 */

/** The item tools: always on, never grantable, as the memory tools are. */
export const BOT_ITEM_TOOLS = ['item_save', 'item_list'] as const
export type BotItemTool = (typeof BOT_ITEM_TOOLS)[number]

/**
 * How an item stands: not started (`todo`), being done (`doing`), waiting on the owner (`waiting`: a question, an
 * approval, a "say go"), delivered as asked (`done`), or no longer wanted (`dropped`). The stage in between ("built,
 * in the dev app, not shipped") is the item's note.
 */
export const BOT_ITEM_STATES = ['todo', 'doing', 'waiting', 'done', 'dropped'] as const
export type BotItemState = (typeof BOT_ITEM_STATES)[number]

/** The states an item is closed in: it leaves the open list, and stays readable with `item_list`. */
export const BOT_ITEM_CLOSED: ReadonlySet<BotItemState> = new Set(['done', 'dropped'])

/**
 * Who wrote the item last: the bot in a chat turn its owner started (`chat`), the bot in work or a turn it started
 * itself (`run`), Mousse from a hand-off (`mousse`), or a chat digest that found it open and unlisted (`digest`).
 */
export type BotItemBy = 'chat' | 'run' | 'mousse' | 'digest'

export interface BotItem {
  /** How the bot names it: `i12`. Never reused. */
  id: string
  /** What was asked or promised, one line. */
  text: string
  state: BotItemState
  /** Where it is now, one line: "built, in the dev app, not shipped". */
  note?: string
  /** The chat row it came from (`bot_journal.seq`): the owner's message, or the bot's promise. */
  source?: number
  /** What belongs to it: thread links, pull requests, pages, files. */
  links: string[]
  by: BotItemBy
  createdAt: string
  updatedAt: string
  closedAt?: string
  /** Its place in the order of changes: the newest change of any item has the highest. */
  rev: number
  /** The chat turn that wrote it last, when its conversation holds that write as a tool result. */
  activationId?: string
}

/** The memory state key of one item (`item:<n>`), of the next id, and of the change counter. */
export const BOT_ITEM_KEY = 'item:'
export const BOT_ITEM_NEXT_KEY = 'items_next'
export const BOT_ITEM_REV_KEY = 'items_rev'

/** One line each: the words are in the chat row the item points to. */
export const MAX_BOT_ITEM_TEXT_CHARS = 200
export const MAX_BOT_ITEM_NOTE_CHARS = 200
export const MAX_BOT_ITEM_LINKS = 12
export const MAX_BOT_ITEM_LINK_CHARS = 300
/** A sanity cap on everything a bot ever listed, open and closed: far above any real list. */
export const MAX_BOT_ITEMS = 20_000

/** The open list in a chat pack, in estimated tokens: past it the least recently touched items show as short lines. */
export const BOT_ITEMS_PACK_TOKENS = 1_500
/** Closed items stay in the pack this long, as short lines, at most `BOT_ITEMS_CLOSED_SHOWN`; then only `item_list` shows them. */
export const BOT_ITEMS_CLOSED_SHOWN_MS = 3 * 24 * 60 * 60_000
export const BOT_ITEMS_CLOSED_SHOWN = 8
/** `item_list`: items by default and at most. */
export const BOT_ITEM_LIST_LIMIT = 50
export const MAX_BOT_ITEM_LIST_LIMIT = 200
/** Most items one chat digest may add. */
export const BOT_ITEMS_FROM_DIGEST = 12

export const ITEMS_HEADING = "Open items: what your owner asked for and what you promised, not yet delivered or dropped (latest change first; memory_read on an item's j ref shows the words it came from):"
export const ITEMS_EMPTY = 'Open items: none.'
export const ITEMS_CHANGES_HEADING = 'Open items that changed outside this conversation:'

/** Reads `i12` back; undefined when it is not an item ref. */
export function parseItemRef(ref: string): string | undefined {
  const match = /^i(\d{1,9})$/.exec(ref.trim())
  return match ? `i${Number(match[1])}` : undefined
}

/** The seq a journal ref names (`j123`, or `123`); undefined when it is not one. */
export function parseJournalRef(ref: string | number): number | undefined {
  if (typeof ref === 'number') return Number.isSafeInteger(ref) && ref > 0 ? ref : undefined
  const match = /^j?(\d{1,15})$/.exec(ref.trim())
  return match ? Number(match[1]) : undefined
}

/** The item tool a call names, bare or as Mousse's MCP tool (`mcp__mousse__item_save`); undefined for any other. */
export function itemToolOf(tool: string): BotItemTool | undefined {
  const name = /(?:^|__)(item_[a-z]+)$/.exec(tool)?.[1]
  return name && (BOT_ITEM_TOOLS as readonly string[]).includes(name) ? name as BotItemTool : undefined
}

/** The threads an item links, by id. */
export function itemThreads(item: Pick<BotItem, 'links'>): string[] {
  return item.links.map((link) => parseThreadLink(link)).filter((id): id is string => Boolean(id))
}

const BY_WORDS: Partial<Record<BotItemBy, string>> = {
  run: 'added in your unattended work',
  mousse: 'added by Mousse when you handed this to a thread: reword or drop it as needed',
  digest: 'found open in a chat summary: confirm or drop it'
}

export interface ItemLineInput {
  /** A date in the owner's time zone: "16 Nov 2026". */
  day: (iso: string) => string
  /** The job the bot handed a thread, by thread id: its state and result line are shown beside the link. */
  jobOn?: (threadId: string) => Pick<BotJob, 'state' | 'line'> | undefined
}

/**
 * One item as the chat pack lists it: its ref, how it stands, what it is, where it is now, the chat row it came from
 * and what belongs to it. A linked thread the bot handed work to shows how that job stands, so the bot can answer
 * without opening it. The words are the bot's own and the owner's: framed as data by the pack around them.
 */
export function itemLine(item: BotItem, input: ItemLineInput): string {
  const parts = [`- ${item.id}`, item.state, `${item.text}${item.note ? ` (${item.note})` : ''}`]
  parts.push(item.source !== undefined ? `j${item.source}, ${input.day(item.createdAt)}` : `since ${input.day(item.createdAt)}`)
  for (const link of item.links) {
    const threadId = parseThreadLink(link)
    const job = threadId ? input.jobOn?.(threadId) : undefined
    parts.push(job ? `${link} (thread ${jobStateWords(job.state)}${job.line ? ` → ${jobLine(job.line, 100)}` : ''})` : link)
  }
  if (item.closedAt) parts.push(`closed ${input.day(item.closedAt)}`)
  const by = BY_WORDS[item.by]
  if (by && !item.closedAt) parts.push(by)
  return parts.join(' · ')
}

/** An item in a few words, for the tail of a long list and for closed items: `memory_read` or `item_list` shows the rest. */
export function shortItemLine(item: BotItem, input: Pick<ItemLineInput, 'day'>): string {
  const when = item.closedAt ? ` ${input.day(item.closedAt)}` : ''
  return `- ${item.id} · ${item.state}${when} · ${jobLine(item.text, 80)}${item.source !== undefined ? ` · j${item.source}` : ''}`
}

/** Open items first by their latest change. */
export function openItems(items: readonly BotItem[]): BotItem[] {
  return items.filter((item) => !BOT_ITEM_CLOSED.has(item.state)).sort((a, b) => b.rev - a.rev)
}

/**
 * The open list for a chat pack, within `budget` tokens. The latest changed show in full; when they do not all fit, the
 * least recently touched show as short lines, so every open item is still named; a list too long even for that says how
 * many more `item_list` holds. After them, the items closed in the last days as short lines, and a count of the earlier ones.
 */
export function itemsBlock(items: readonly BotItem[], input: ItemLineInput & { now: number; budget?: number }): string {
  const budget = input.budget ?? BOT_ITEMS_PACK_TOKENS
  const open = openItems(items)
  const closed = items.filter((item) => item.closedAt).sort((a, b) => b.closedAt!.localeCompare(a.closedAt!))
  const recent = closed.filter((item) => input.now - Date.parse(item.closedAt!) <= BOT_ITEMS_CLOSED_SHOWN_MS).slice(0, BOT_ITEMS_CLOSED_SHOWN)
  const blocks: string[] = []
  if (!open.length) blocks.push(ITEMS_EMPTY)
  else {
    const full = open.map((item) => itemLine(item, input))
    const short = open.map((item) => shortItemLine(item, input))
    const size = (line: string) => estimateTokens(line) + 1
    // How many of the latest changed fit in full when the rest are short lines.
    const shortAfter: number[] = new Array(open.length + 1).fill(0)
    for (let index = open.length - 1; index >= 0; index--) shortAfter[index] = shortAfter[index + 1]! + size(short[index]!)
    let used = 0
    let whole = 0
    if (shortAfter[0]! <= budget) while (whole < open.length && used + size(full[whole]!) + shortAfter[whole + 1]! <= budget) used += size(full[whole++]!)
    // A list too long to name every item even in short lines: the latest changed still show in full, in half the room.
    else while (whole < open.length && used + size(full[whole]!) <= budget / 2) used += size(full[whole++]!)
    const lines = full.slice(0, whole)
    let listed = whole
    for (; listed < open.length && used + size(short[listed]!) <= budget; listed++) {
      lines.push(short[listed]!)
      used += size(short[listed]!)
    }
    // A list no budget holds still names its latest item, and says how many it left out.
    if (!lines.length) {
      lines.push(short[0]!)
      listed = 1
    }
    if (listed < open.length) lines.push(`- and ${open.length - listed} more open, not touched for longest: item_list shows them.`)
    blocks.push(`${ITEMS_HEADING}\n${lines.join('\n')}`)
  }
  if (recent.length) blocks.push(`Closed lately:\n${recent.map((item) => shortItemLine(item, input)).join('\n')}`)
  const earlier = closed.length - recent.length
  if (earlier > 0) blocks.push(`${earlier} closed earlier: item_list with state closed shows them.`)
  return blocks.join('\n')
}

/** One line for a run's brief: that the list exists and how long it is. */
export function itemsCountLine(items: readonly BotItem[]): string {
  const open = openItems(items)
  if (!open.length) return ''
  const waiting = open.filter((item) => item.state === 'waiting').length
  return `Open items your owner asked for or you promised: ${open.length}${waiting ? `, ${waiting} waiting on your owner` : ''}. item_list shows them; item_save updates one this work moves.`
}
