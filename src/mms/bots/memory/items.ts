import type { BotLane } from '../../../shared/bots/personal/definition'
import {
  BOT_ITEM_CLOSED, BOT_ITEM_KEY, BOT_ITEM_LIST_LIMIT, BOT_ITEM_NEXT_KEY, BOT_ITEM_REV_KEY, BOT_ITEM_STATES, BOT_ITEMS_FROM_DIGEST,
  MAX_BOT_ITEM_LINK_CHARS, MAX_BOT_ITEM_LINKS, MAX_BOT_ITEM_LIST_LIMIT, MAX_BOT_ITEM_NOTE_CHARS, MAX_BOT_ITEM_TEXT_CHARS, MAX_BOT_ITEMS,
  itemStages, itemThreads, openItems, parseItemRef, parseJournalRef, type BotItem, type BotItemBy, type BotItemState
} from '../../../shared/bots/personal/items'
import type { BotJob } from '../../../shared/bots/personal/jobs'
import { threadLink } from '../../../shared/threadLink'
import type { BotMemoryStore } from './BotMemoryStore'
import { guardMemoryText } from './guard'

/**
 * Where a bot's open items live (docs/bot-memory.md, "Open items"): one row each in `bot_memory_state` (`item:<n>`), so
 * a wipe or a purge of the bot's memory takes them, and a forget removes the ones that hold what was forgotten
 * (`BotMemoryStore.forget`). No table of their own: an item is small, read whole, and never joined.
 */

/** A chat row an item may point to: something the owner or the bot said in the chat. */
const SOURCE_KINDS = new Set(['owner_msg', 'bot_msg', 'run_report'])

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim()
const sameText = (a: string, b: string) => oneLine(a).toLowerCase() === oneLine(b).toLowerCase()

function itemOf(value: unknown): BotItem | undefined {
  let item: Partial<BotItem> | undefined
  try {
    item = typeof value === 'string' ? JSON.parse(value) as Partial<BotItem> : undefined
  } catch {
    return undefined
  }
  if (!item || typeof item.id !== 'string' || typeof item.text !== 'string' || !(BOT_ITEM_STATES as readonly unknown[]).includes(item.state)) return undefined
  return { ...item, links: Array.isArray(item.links) ? item.links.filter((link): link is string => typeof link === 'string') : [], rev: typeof item.rev === 'number' ? item.rev : 0 } as BotItem
}

/** Every item of a bot, open and closed, by its latest change. */
export function botItems(store: BotMemoryStore, botId: string): BotItem[] {
  // The keys `item:…` and nothing else: `;` is the character after `:`.
  const rows = store.db.statement("SELECT value FROM bot_memory_state WHERE bot_id = ? AND key >= 'item:' AND key < 'item;'").all(botId) as Array<{ value: unknown }>
  return rows.map((row) => itemOf(row.value)).filter((item): item is BotItem => Boolean(item)).sort((a, b) => b.rev - a.rev)
}

export function botItem(store: BotMemoryStore, botId: string, id: string): BotItem | undefined {
  return itemOf(store.db.statement('SELECT value FROM bot_memory_state WHERE bot_id = ? AND key = ?').get(botId, `${BOT_ITEM_KEY}${id.slice(1)}`)?.value)
}

/** The change counter: the newest change of any item has it. */
export function botItemsRev(store: BotMemoryStore, botId: string): number {
  return store.getState<number>(botId, BOT_ITEM_REV_KEY) ?? 0
}

export interface BotItemSave {
  /** The item to change (`i12`); absent: a new one. */
  id?: string
  text?: string
  state?: BotItemState
  /** Where it is now; an empty note clears it. */
  note?: string
  /** Links to add. */
  links?: string[]
  /** The chat row it came from: `j123`. */
  source?: string | number
  /** The rights of the turn that writes it: a chat turn the owner started, or anything else. */
  lane: BotLane
  activationId?: string
  /** The write is a tool result of the chat's own conversation, which so holds it already. */
  inConversation?: boolean
  /** Written by Mousse itself, not by a call of the bot. */
  by?: Extract<BotItemBy, 'mousse' | 'digest'>
}

export type BotItemSaveResult =
  | { item: BotItem; added: boolean; open: number }
  | { error: 'refused' | 'not_found'; reason: string }

const refuse = (reason: string): BotItemSaveResult => ({ error: 'refused', reason })

function checkedText(text: string, max: number, what: string): string | BotItemSaveResult {
  const line = oneLine(text)
  if (line.length > max) return refuse(`Keep ${what} to one line under ${max} characters: the details are in the chat row it points to.`)
  const guard = guardMemoryText(line)
  return guard.ok ? line : refuse(guard.message)
}

/** The chat row an item written now comes from when the call names none: the owner's message that started the turn. */
function defaultSource(store: BotMemoryStore, botId: string, input: BotItemSave): number | undefined {
  if (input.lane !== 'chat' || !input.activationId) return undefined
  const row = store.db.statement("SELECT seq FROM bot_journal WHERE bot_id = ? AND kind = 'owner_msg' AND activation_id = ? AND redacted_at IS NULL ORDER BY seq DESC LIMIT 1").get(botId, input.activationId)
  return typeof row?.seq === 'number' ? row.seq : undefined
}

function put(store: BotMemoryStore, botId: string, item: BotItem): void {
  store.setState(botId, `${BOT_ITEM_KEY}${item.id.slice(1)}`, item)
}

/**
 * `item_save`: adds an item, or changes one. Its text, note and links pass the memory guard (no secrets, nothing
 * instruction-shaped); its source must be a row of the bot's own chat. Adding the words of an item that is still open
 * returns that item. A write outside a chat turn the owner started is marked (`by: 'run'`) until such a turn confirms it.
 */
export function saveBotItem(store: BotMemoryStore, botId: string, input: BotItemSave): BotItemSaveResult {
  const text = input.text === undefined ? undefined : checkedText(input.text, MAX_BOT_ITEM_TEXT_CHARS, 'an item')
  if (typeof text === 'object') return text
  const note = input.note === undefined ? undefined : checkedText(input.note, MAX_BOT_ITEM_NOTE_CHARS, 'a note')
  if (typeof note === 'object') return note
  const links: string[] = []
  for (const value of input.links ?? []) {
    const link = oneLine(value)
    if (!link) continue
    if (link.length > MAX_BOT_ITEM_LINK_CHARS) return refuse(`A link is at most ${MAX_BOT_ITEM_LINK_CHARS} characters.`)
    const guard = guardMemoryText(link)
    if (!guard.ok) return refuse(guard.message)
    if (!links.includes(link)) links.push(link)
  }
  if (input.state !== undefined && !(BOT_ITEM_STATES as readonly unknown[]).includes(input.state)) return refuse(`state is one of ${BOT_ITEM_STATES.join(', ')}.`)
  let source: number | undefined
  if (input.source !== undefined) {
    source = parseJournalRef(input.source)
    const row = source === undefined ? undefined : store.journalRow(botId, source)
    if (!row || row.redactedAt || !SOURCE_KINDS.has(row.kind)) return refuse(`${String(input.source)} is not a row of your chat. memory_search finds the message it came from; its ref looks like j123.`)
  }
  return store.write((): BotItemSaveResult => {
    const all = botItems(store, botId)
    const at = store.now()
    const rev = botItemsRev(store, botId) + 1
    const by: BotItemBy = input.by ?? (input.lane === 'chat' ? 'chat' : 'run')
    const conversation = input.inConversation && input.activationId ? { activationId: input.activationId } : {}
    let item: BotItem
    let added = false
    if (input.id === undefined) {
      if (!text) return refuse('A new item needs its text: what was asked or promised, in one line.')
      const same = all.find((entry) => !BOT_ITEM_CLOSED.has(entry.state) && sameText(entry.text, text))
      if (same) return { item: same, added: false, open: openItems(all).length }
      if (all.length >= MAX_BOT_ITEMS) return refuse('The list is full. Tell your owner.')
      const next = Math.max(store.getState<number>(botId, BOT_ITEM_NEXT_KEY) ?? 0, ...all.map((entry) => Number(entry.id.slice(1)) || 0)) + 1
      const state = input.state ?? 'todo'
      source ??= defaultSource(store, botId, input)
      item = {
        id: `i${next}`, text, state, ...(note ? { note } : {}), ...(source !== undefined ? { source } : {}),
        links: links.slice(0, MAX_BOT_ITEM_LINKS), by, createdAt: at, updatedAt: at,
        ...(BOT_ITEM_CLOSED.has(state) ? { closedAt: at } : {}), rev, ...conversation
      }
      store.setState(botId, BOT_ITEM_NEXT_KEY, next)
      added = true
    } else {
      const id = parseItemRef(input.id)
      const current = id ? all.find((entry) => entry.id === id) : undefined
      if (!current) return { error: 'not_found', reason: `There is no item ${input.id}. item_list shows your items.` }
      if (text === undefined && note === undefined && input.state === undefined && !links.length && source === undefined)
        return refuse('Say what changes: text, state, note, links or source.')
      const merged = [...current.links, ...links.filter((link) => !current.links.includes(link))]
      if (merged.length > MAX_BOT_ITEM_LINKS) return refuse(`An item holds at most ${MAX_BOT_ITEM_LINKS} links.`)
      const state = input.state ?? current.state
      const { note: oldNote, closedAt: oldClosedAt, activationId: _activationId, source: oldSource, ...rest } = current
      const nextNote = note === undefined ? oldNote : note
      const nextSource = source ?? oldSource
      item = {
        ...rest, ...(text ? { text } : {}), state, ...(nextNote ? { note: nextNote } : {}), ...(nextSource !== undefined ? { source: nextSource } : {}),
        links: merged,
        // What Mousse or unattended work added stays marked until a chat turn the owner started takes it up.
        by: input.by ?? (input.lane === 'chat' ? 'chat' : current.by),
        updatedAt: at,
        ...(BOT_ITEM_CLOSED.has(state) ? { closedAt: oldClosedAt ?? at } : {}), rev, ...conversation
      }
    }
    put(store, botId, item)
    store.setState(botId, BOT_ITEM_REV_KEY, rev)
    const open = openItems(all.filter((entry) => entry.id !== item.id).concat(item)).length
    return { item, added, open }
  })
}

export interface BotItemListInput {
  /** `open` (default), `closed`, or `all`. */
  state?: 'open' | 'closed' | 'all' | BotItemState
  /** Words every listed item holds, in its text, note or links. */
  query?: string
  limit?: number
}

/** `item_list`: the items as they stand, latest change first, and how many more match. */
export function listBotItems(store: BotMemoryStore, botId: string, input: BotItemListInput = {}): { items: BotItem[]; more: number; open: number; closed: number; stages: Partial<Record<BotItemState, number>> } {
  const all = botItems(store, botId)
  const state = input.state ?? 'open'
  const words = oneLine(input.query ?? '').toLowerCase().split(' ').filter(Boolean)
  const matching = all.filter((item) => {
    const closed = BOT_ITEM_CLOSED.has(item.state)
    if (state === 'open' ? closed : state === 'closed' ? !closed : state !== 'all' && item.state !== state) return false
    if (!words.length) return true
    const hay = `${item.id} ${item.text} ${item.note ?? ''} ${item.links.join(' ')}`.toLowerCase()
    return words.every((word) => hay.includes(word))
  })
  const limit = Math.max(1, Math.min(MAX_BOT_ITEM_LIST_LIMIT, Math.floor(input.limit ?? BOT_ITEM_LIST_LIMIT)))
  const open = openItems(all).length
  return { items: matching.slice(0, limit), more: Math.max(0, matching.length - limit), open, closed: all.length - open, stages: itemStages(all) }
}

/**
 * After a chat turn: a thread the turn handed an owner's request to belongs to an item. When no item links the thread
 * yet, it joins the one item this turn wrote or that came from the same message; with none, Mousse adds the item itself
 * (the thread's title, the owner's message as its source), so a request is listed even when the bot only handed it off.
 * With several candidates nothing is guessed: the bot links the thread itself.
 */
export function linkHandoffs(store: BotMemoryStore, botId: string, activationId: string, jobs: readonly BotJob[]): void {
  const handed = jobs.filter((job) => job.activationId === activationId && job.askedBy === 'owner' && job.state !== 'gone')
  if (!handed.length) return
  store.write(() => {
    const source = defaultSource(store, botId, { lane: 'chat', activationId })
    // Oldest first, so items follow the order the threads were started in.
    for (const job of [...handed].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
      const all = botItems(store, botId)
      if (all.some((item) => itemThreads(item).includes(job.threadId))) continue
      const link = threadLink(job.threadId)
      const near = all.filter((item) => item.activationId === activationId || (source !== undefined && item.source === source))
      // An item Mousse added for another thread of this turn is that thread's, not this one's.
      const candidates = near.filter((item) => !(item.by === 'mousse' && itemThreads(item).length))
      // Linked by Mousse outside the conversation: who wrote the item stays as it was, and the next turn is told.
      if (candidates.length === 1 && handed.length === 1) saveBotItem(store, botId, { id: candidates[0]!.id, links: [link], lane: 'run' })
      else if (!candidates.length) saveBotItem(store, botId, { text: oneLine(job.title).slice(0, MAX_BOT_ITEM_TEXT_CHARS) || 'Work handed to a thread', state: 'building', links: [link], ...(source !== undefined ? { source } : {}), lane: 'run', by: 'mousse' })
    }
  })
}

/**
 * What a chat digest found still open and not listed (`untrackedAsks`): each becomes an item marked as found by a digest,
 * for the bot to confirm or drop. Only an ask whose ref names a chat row of the digest's range is kept, and only when no
 * item came from that row or says the same; the guard refuses what reads like a secret or an instruction.
 */
export function addUntrackedAsks(store: BotMemoryStore, botId: string, asks: ReadonlyArray<{ text: string; seq: number }>, range: { fromSeq: number; throughSeq: number }): number {
  let added = 0
  store.write(() => {
    for (const ask of asks) {
      if (added >= BOT_ITEMS_FROM_DIGEST) break
      if (ask.seq < range.fromSeq || ask.seq > range.throughSeq) continue
      const all = botItems(store, botId)
      if (all.some((item) => item.source === ask.seq || sameText(item.text, ask.text))) continue
      const result = saveBotItem(store, botId, { text: ask.text.slice(0, MAX_BOT_ITEM_TEXT_CHARS), source: ask.seq, lane: 'run', by: 'digest' })
      if ('item' in result && result.added) added++
    }
  })
  return added
}
