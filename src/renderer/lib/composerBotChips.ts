import { BOT_TAG, botTag } from '../../shared/botLink'
import type { BotLook } from '../../shared/bots/personal/look'
import type { ChippedText } from './composerThreadChips'

/**
 * Bot chips in a bot's composer: another of the owner's bots, picked from the `@` list (or its tag typed, pasted or
 * brought back by Up), shows as that bot's face and name at its place in the text. The text box holds a stand-in token
 * for it, bracketed by two invisible isolate marks: a blank slot for the face, a mark only bot chips carry, then the
 * name. The input backdrop paints those same glyphs as the chip, so the caret never drifts (the thread chips' way,
 * `composerThreadChips.ts`). The bot lives in a registry keyed by the token: the sent text, a copied selection and every
 * other reader get the bot's tag back (`expandBotChips`), `[@Name](mousse://bot/<id>)` (`shared/botLink.ts`), which
 * tells the bot the message goes to exactly which bot is meant.
 */

const OPEN = '\u2068'
const CLOSE = '\u2069'
const NBSP = '\u00a0'
/** Joins its neighbours on one line and has no width; repeated at the end, it tells same-looking tokens apart. */
const JOIN = '\u2060'
/** An em space: the blank slot, one character wide, where the chip's face is drawn. */
const SLOT = '\u2003'
/** Invisible, after the face's slot: only a bot chip has it, so it never reads as an attachment chip of the same name. */
const BOT_MARK = '\u2061'
const NAME_CHARS = 30
const STORAGE_KEY = 'mousse.composerBotChips'
const MAX_KEPT = 200

/** What starts every bot token: the opening mark, the face's slot, the join after it and the bot mark. */
export const BOT_CHIP_HEAD = `${OPEN}${SLOT}${JOIN}${BOT_MARK}`

/** A bot the `@` list offers: one of the owner's other bots, with its face. */
export interface TaggableBot {
  id: string
  name: string
  description?: string
  look: BotLook
}

/** What a token stands for: the bot, and the name it was tagged by. */
export interface BotChipEntry {
  botId: string
  name: string
}

export type BotChipRegistry = Map<string, BotChipEntry>

export interface BotChipSpan extends BotChipEntry {
  index: number
  length: number
  token: string
}

function shown(name: string): string {
  const flat = name.replace(/[\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, '').replace(/\s+/g, ' ').trim()
  const short = flat.length > NAME_CHARS ? `${flat.slice(0, NAME_CHARS - 1).trimEnd()}…` : flat
  // Kept on one line: spaces and hyphens that would let the chip wrap are their unbreaking forms.
  return short.replace(/ /g, NBSP).replace(/-/g, '\u2011')
}

/** The token for `entry`: the same bot gives the same token; another bot that reads the same gets a mark. */
export function botChipTokenFor(entry: BotChipEntry, registry: BotChipRegistry): string {
  const body = `${BOT_CHIP_HEAD}${NBSP}${shown(entry.name) || 'Bot'}`
  for (let n = 0; ; n += 1) {
    const token = `${body}${JOIN.repeat(n)}${CLOSE}`
    const held = registry.get(token)
    if (held === undefined || held.botId === entry.botId) return token
  }
}

/** The token's head (marks and the face's slot) and the rest (the name and the closing mark), for drawing. */
export function botChipParts(token: string): { head: string; rest: string } {
  return { head: token.slice(0, BOT_CHIP_HEAD.length), rest: token.slice(BOT_CHIP_HEAD.length) }
}

/** Every registered bot chip in `input`, in order. A token whose text was edited is no longer one. */
export function findBotChips(input: string, registry: BotChipRegistry): BotChipSpan[] {
  const spans: BotChipSpan[] = []
  if (!input.includes(BOT_CHIP_HEAD) || registry.size === 0) return spans
  const pattern = new RegExp(`${OPEN}[^${OPEN}${CLOSE}]*${CLOSE}`, 'g')
  for (const match of input.matchAll(pattern)) {
    const entry = match[0].startsWith(BOT_CHIP_HEAD) ? registry.get(match[0]) : undefined
    if (entry) spans.push({ ...entry, index: match.index, length: match[0].length, token: match[0] })
  }
  return spans
}

/** `input` with each bot chip back as the bot's tag: what is sent, copied and saved elsewhere. */
export function expandBotChips(input: string, registry: BotChipRegistry): string {
  const spans = findBotChips(input, registry)
  if (!spans.length) return input
  let out = ''
  let from = 0
  for (const span of spans) {
    out += input.slice(from, span.index) + botTag(span.botId, span.name)
    from = span.index + span.length
  }
  return out + input.slice(from)
}

/** Inline code on one line: a tag in it stays text, as the sent message keeps it. */
const INLINE_CODE = /`[^`\n]*`/g

/**
 * `text` with each bot tag that `named` knows as its chip (`register` gives the token), by the bot's name now. A tag of
 * a bot `named` does not know (one that is gone, or this chat's own bot) stays text, as does a tag in inline code.
 * `within` limits it to tags that touch that range.
 */
export function chipBotTags(
  text: string,
  named: (botId: string) => string | null,
  register: (entry: BotChipEntry) => string,
  within?: { start: number; end: number }
): ChippedText {
  const swaps: Array<{ start: number; end: number; token: string }> = []
  if (text.toLowerCase().includes('mousse://bot/')) {
    const code = [...text.matchAll(INLINE_CODE)].map((match) => ({ start: match.index, end: match.index + match[0].length }))
    for (const match of text.matchAll(BOT_TAG)) {
      const start = match.index
      const end = start + match[0].length
      if (within && (end < within.start || start > within.end)) continue
      if (code.some((span) => start >= span.start && end <= span.end)) continue
      const botId = match[2]!
      const name = named(botId)
      if (name !== null) swaps.push({ start, end, token: register({ botId, name }) })
    }
  }
  if (!swaps.length) return { value: text, map: (offset) => offset }
  let value = ''
  let from = 0
  for (const swap of swaps) {
    value += text.slice(from, swap.start) + swap.token
    from = swap.end
  }
  value += text.slice(from)
  const map = (offset: number): number => {
    let shift = 0
    for (const swap of swaps) {
      if (offset <= swap.start) break
      if (offset < swap.end) return swap.start + shift + swap.token.length
      shift += swap.token.length - (swap.end - swap.start)
    }
    return offset + shift
  }
  return { value, map }
}

/** The `@` list's rows for `query`: bots whose name starts with it first, then those whose name holds it. */
export function matchTaggableBots(bots: readonly TaggableBot[], query: string, limit = 8): TaggableBot[] {
  const wanted = query.trim().toLowerCase()
  if (!wanted) return bots.slice(0, limit)
  const starts = bots.filter((bot) => bot.name.toLowerCase().startsWith(wanted))
  const holds = bots.filter((bot) => !bot.name.toLowerCase().startsWith(wanted) && bot.name.toLowerCase().includes(wanted))
  return [...starts, ...holds].slice(0, limit)
}

let shared: BotChipRegistry | null = null

/** The app's one registry, read from local storage on first use: a draft kept across a restart keeps its chips. */
export function botChipRegistry(): BotChipRegistry {
  if (shared) return shared
  shared = new Map()
  try {
    const saved = JSON.parse(globalThis.localStorage?.getItem(STORAGE_KEY) ?? '[]') as unknown
    if (Array.isArray(saved)) {
      for (const entry of saved) {
        if (!Array.isArray(entry) || typeof entry[0] !== 'string') continue
        const value = entry[1] as Partial<BotChipEntry> | undefined
        if (typeof value?.botId === 'string' && typeof value.name === 'string') shared.set(entry[0], { botId: value.botId, name: value.name })
      }
    }
  } catch {
    // A broken saved list starts empty: chips in old drafts then read as their plain text.
  }
  return shared
}

/** Registers `entry` and returns its token. The newest chips are kept; the oldest go past the limit. */
export function registerBotChip(entry: BotChipEntry): string {
  const registry = botChipRegistry()
  const token = botChipTokenFor(entry, registry)
  const held = registry.get(token)
  if (held?.botId === entry.botId && held.name === entry.name) return token
  registry.set(token, { botId: entry.botId, name: entry.name })
  while (registry.size > MAX_KEPT) registry.delete(registry.keys().next().value as string)
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify([...registry]))
  } catch {
    // Storage full or unavailable: the chip still works until the app closes.
  }
  return token
}

/** `expandBotChips` with the app's registry. */
export function expandComposerBotChips(input: string): string {
  return expandBotChips(input, botChipRegistry())
}
