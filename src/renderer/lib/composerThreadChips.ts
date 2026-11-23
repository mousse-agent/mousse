import { parseThreadLink } from '../../shared/threadLink'
import { parseQualifiedId } from '../../shared/threadRef'
import { UNKNOWN_COMPUTER_NAME, useComputersStore } from './computers'
import { useAppStore } from '../stores/appStore'

/**
 * Thread chips in the composer: a thread's link (`mousse://thread/<id>`, from Copy reference) typed or pasted into the
 * composer shows as the thread's chip at its place in the text. The text box holds a stand-in token for it, bracketed by
 * two invisible isolate marks: a blank slot for the chip's icon, the thread's title (and "· <computer>" for a thread of
 * another computer), and a blank slot for its status dot. The input backdrop paints those same glyphs as the chip, so
 * the caret never drifts. The link lives in a registry keyed by the token; the sent text, a copied selection and every
 * other reader get the link back (`expandThreadChips`).
 */

const OPEN = '\u2068'
const CLOSE = '\u2069'
const NBSP = '\u00a0'
/** Joins its neighbours on one line, has no width, and marks where the chip's parts meet. */
const JOIN = '\u2060'
/** An em space: the blank slot, one character wide, where the chip's icon or status dot is drawn. */
const SLOT = '\u2003'
const TITLE_CHARS = 30
const COMPUTER_CHARS = 20
const STORAGE_KEY = 'mousse.composerThreadChips'
const MAX_KEPT = 200

/** The opening mark, the icon slot and the join after it, which start every token: where the chip's icon goes. */
export const THREAD_CHIP_HEAD = `${OPEN}${SLOT}${JOIN}`

/** A thread link in text; `parseThreadLink` checks its id. */
const THREAD_LINK = /mousse:\/\/thread\/[\w-]+(?::[\w-]+)?\/?/gi
/** Inline code on one line: a link in it stays text, as the sent message keeps it. */
const INLINE_CODE = /`[^`\n]*`/g

/** Token → the exact link it stands for. Kept across thread switches and restarts, as drafts are. */
export type ThreadChipRegistry = Map<string, string>

/** What a chip says of its thread: the title, and the computer's name for a thread of another computer. */
export interface ThreadChipLabel {
  title: string
  computer?: string
}

export interface ThreadChipSpan {
  index: number
  length: number
  token: string
  link: string
  threadId: string
}

/** The parts of a token as the backdrop draws them; joined they are the token again. */
export interface ThreadChipParts {
  /** The opening mark and the icon slot. */
  head: string
  title: string
  /** " · <computer>", or empty. */
  computer: string
  /** The space before the dot slot. */
  gap: string
  /** The status dot's slot. */
  dot: string
  /** What tells same-looking tokens apart, and the closing mark. */
  tail: string
}

function shown(text: string, max: number): string {
  const flat = text.replace(/[\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, '').replace(/\s+/g, ' ').trim()
  const short = flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat
  // Kept on one line: spaces and hyphens that would let the chip wrap are their unbreaking forms.
  return short.replace(/ /g, NBSP).replace(/-/g, '\u2011')
}

/** The token for `link` with `label`: the same link gives the same token; another link that reads the same gets a mark. */
export function threadChipTokenFor(link: string, label: ThreadChipLabel, registry: ThreadChipRegistry): string {
  const computer = label.computer ? `${JOIN}${NBSP}·${NBSP}${shown(label.computer, COMPUTER_CHARS)}` : ''
  const body = `${THREAD_CHIP_HEAD}${NBSP}${shown(label.title, TITLE_CHARS) || 'Thread'}${computer}${NBSP}${SLOT}`
  for (let n = 0; ; n += 1) {
    const token = `${body}${JOIN.repeat(n)}${CLOSE}`
    const held = registry.get(token)
    if (held === undefined || held === link) return token
  }
}

/** A token's parts, for drawing. */
export function threadChipParts(token: string): ThreadChipParts {
  const head = THREAD_CHIP_HEAD
  const dotAt = token.lastIndexOf(SLOT)
  const middle = token.slice(head.length, dotAt - 1)
  const split = middle.indexOf(JOIN)
  return {
    head,
    title: split >= 0 ? middle.slice(0, split) : middle,
    computer: split >= 0 ? middle.slice(split) : '',
    gap: token.slice(dotAt - 1, dotAt),
    dot: SLOT,
    tail: token.slice(dotAt + 1)
  }
}

/** Every registered thread chip in `input`, in order. A token whose text was edited is no longer one. */
export function findThreadChips(input: string, registry: ThreadChipRegistry): ThreadChipSpan[] {
  const spans: ThreadChipSpan[] = []
  if (!input.includes(OPEN)) return spans
  const pattern = new RegExp(`${OPEN}[^${OPEN}${CLOSE}]*${CLOSE}`, 'g')
  for (const match of input.matchAll(pattern)) {
    const link = registry.get(match[0])
    const threadId = link ? parseThreadLink(link) : null
    if (link && threadId) spans.push({ index: match.index, length: match[0].length, token: match[0], link, threadId })
  }
  return spans
}

/** `input` with each chip back as its link: what is sent, copied and saved elsewhere. */
export function expandThreadChips(input: string, registry: ThreadChipRegistry): string {
  const spans = findThreadChips(input, registry)
  if (!spans.length) return input
  let out = ''
  let from = 0
  for (const span of spans) {
    out += input.slice(from, span.index) + span.link
    from = span.index + span.length
  }
  return out + input.slice(from)
}

export interface ChippedText {
  value: string
  /** Where an offset in the original text lands in `value`: inside a replaced link, after its chip. */
  map: (offset: number) => number
}

/**
 * `text` with each thread link that `label` names as its chip (`register` gives the token). A link `label` gives no
 * label for (a thread this computer can't find, or one this chat may not point at) stays text, as does a link in inline
 * code or a Markdown link's target. `within` limits it to links that touch that range.
 */
export function chipThreadLinks(
  text: string,
  label: (threadId: string) => ThreadChipLabel | null,
  register: (link: string, label: ThreadChipLabel) => string,
  within?: { start: number; end: number }
): ChippedText {
  const swaps: Array<{ start: number; end: number; token: string }> = []
  if (text.toLowerCase().includes('mousse://thread/')) {
    const code = [...text.matchAll(INLINE_CODE)].map((match) => ({ start: match.index, end: match.index + match[0].length }))
    for (const match of text.matchAll(THREAD_LINK)) {
      const start = match.index
      const end = start + match[0].length
      if (within && (end < within.start || start > within.end)) continue
      if (code.some((span) => start >= span.start && end <= span.end)) continue
      if (text.startsWith('](', start - 2)) continue
      const threadId = parseThreadLink(match[0])
      const named = threadId ? label(threadId) : null
      if (named) swaps.push({ start, end, token: register(match[0], named) })
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

/** The chip a collapsed caret sits strictly inside, so the caret can be moved off it. */
export function threadChipAround(spans: readonly ThreadChipSpan[], caret: number): ThreadChipSpan | undefined {
  return spans.find((span) => caret > span.index && caret < span.index + span.length)
}

/** The chip Backspace right after, or Delete right before, removes whole. */
export function threadChipAtEdge(spans: readonly ThreadChipSpan[], caret: number, key: 'Backspace' | 'Delete'): ThreadChipSpan | undefined {
  return spans.find((span) => (key === 'Backspace' ? span.index + span.length === caret : span.index === caret))
}

/** `start`..`end` grown to hold whole every chip it cuts into, so an edit never leaves half a chip. */
export function rangeOverChips(spans: readonly ThreadChipSpan[], start: number, end: number): { start: number; end: number } {
  let from = start
  let to = end
  for (const span of spans) {
    const spanEnd = span.index + span.length
    if (from > span.index && from < spanEnd) from = span.index
    if (to > span.index && to < spanEnd) to = spanEnd
  }
  return { start: from, end: to }
}

let shared: ThreadChipRegistry | null = null

/** The app's one registry, read from local storage on first use. */
export function threadChipRegistry(): ThreadChipRegistry {
  if (shared) return shared
  shared = new Map()
  try {
    const saved = JSON.parse(globalThis.localStorage?.getItem(STORAGE_KEY) ?? '[]') as unknown
    if (Array.isArray(saved)) {
      for (const entry of saved) if (Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'string') shared.set(entry[0], entry[1])
    }
  } catch {
    // A broken saved list starts empty: chips in old drafts then read as their plain text.
  }
  return shared
}

/** Registers `link` and returns its token. The newest chips are kept; the oldest go past the limit. */
export function registerThreadChip(link: string, label: ThreadChipLabel): string {
  const registry = threadChipRegistry()
  const token = threadChipTokenFor(link, label, registry)
  if (registry.get(token) === link) return token
  registry.set(token, link)
  while (registry.size > MAX_KEPT) registry.delete(registry.keys().next().value as string)
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify([...registry]))
  } catch {
    // Storage full or unavailable: the chip still works until the app closes.
  }
  return token
}

/** What the chip for `threadId` says, from this window's thread list; null for a thread it does not list. */
export function threadChipLabel(threadId: string): ThreadChipLabel | null {
  const thread = useAppStore.getState().threads.find((entry) => entry.id === threadId)
  if (!thread) return null
  const title = thread.name.trim() || 'Untitled thread'
  const node = thread.node ?? parseQualifiedId(threadId)?.node
  if (!node) return { title }
  return { title, computer: useComputersStore.getState().byNode[node]?.name ?? UNKNOWN_COMPUTER_NAME }
}

/** `expandThreadChips` with the app's registry. */
export function expandComposerThreadChips(input: string): string {
  return expandThreadChips(input, threadChipRegistry())
}
