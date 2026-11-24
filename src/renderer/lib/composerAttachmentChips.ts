import { truncateFileName } from '../utils/messageAttachments'
import type { SentChipKind } from '../../shared/inlineAttachments'

/**
 * Attachment chips in the composer (#1823): a file or image pasted, dropped or picked among text, and a reference
 * picked with `@` or dropped there, shows as its chip at that place, as well as in the attachments row. The text box
 * holds a stand-in token for it, bracketed by two invisible isolate marks: a blank slot for the chip's icon, then the
 * short name. The input backdrop paints those same glyphs as the chip, so the caret never drifts (the thread chips'
 * way, `composerThreadChips.ts`). The attachment it stands for lives in a registry keyed by the token: the same
 * attachment placed twice is the same token, so removing the attachment finds all its chips.
 *
 * The registry is kept in memory only, as attachments are: a token whose attachment is gone reads as its plain name.
 */

const OPEN = '\u2068'
const CLOSE = '\u2069'
const NBSP = '\u00a0'
/** Joins its neighbours on one line and has no width; repeated at the end, it tells same-looking tokens apart. */
const JOIN = '\u2060'
/** An em space: the blank slot, one character wide, where the chip's icon is drawn. */
const SLOT = '\u2003'
const NAME_CHARS = 28

/** The opening mark, the icon slot and the join after it, which start every token: where the chip's icon goes. */
export const ATTACHMENT_CHIP_HEAD = `${OPEN}${SLOT}${JOIN}`

/** What a token stands for: `file:<attachment id>` or `ref:<reference id>`, its name, and how the sent text names it. */
export interface AttachmentChipEntry {
  key: string
  name: string
  kind: SentChipKind
}

export type AttachmentChipRegistry = Map<string, AttachmentChipEntry>

export interface AttachmentChipSpan extends AttachmentChipEntry {
  index: number
  length: number
  token: string
}

export const attachmentChipKey = (attachmentId: string): string => `file:${attachmentId}`
export const referenceChipKey = (referenceId: string): string => `ref:${referenceId}`

function shown(name: string): string {
  const flat = name.replace(/[\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, '').replace(/\s+/g, ' ').trim()
  // Kept on one line: spaces and hyphens that would let the chip wrap are their unbreaking forms.
  return truncateFileName(flat, NAME_CHARS).replace(/ /g, NBSP).replace(/-/g, '\u2011')
}

/** The token for `entry`: the same attachment gives the same token; another that reads the same gets a mark. */
export function attachmentChipTokenFor(entry: AttachmentChipEntry, registry: AttachmentChipRegistry): string {
  const body = `${ATTACHMENT_CHIP_HEAD}${NBSP}${shown(entry.name) || 'File'}`
  for (let n = 0; ; n += 1) {
    const token = `${body}${JOIN.repeat(n)}${CLOSE}`
    const held = registry.get(token)
    if (held === undefined || held.key === entry.key) return token
  }
}

/** The token's head (mark and icon slot) and the rest (the name and the closing mark), for drawing. */
export function attachmentChipParts(token: string): { head: string; rest: string } {
  return { head: token.slice(0, 2), rest: token.slice(2) }
}

/** Every registered attachment chip in `input`, in order. A token whose text was edited is no longer one. */
export function findAttachmentChips(input: string, registry: AttachmentChipRegistry): AttachmentChipSpan[] {
  const spans: AttachmentChipSpan[] = []
  if (!input.includes(OPEN) || registry.size === 0) return spans
  const pattern = new RegExp(`${OPEN}[^${OPEN}${CLOSE}]*${CLOSE}`, 'g')
  for (const match of input.matchAll(pattern)) {
    const entry = registry.get(match[0])
    if (entry) spans.push({ ...entry, index: match.index, length: match[0].length, token: match[0] })
  }
  return spans
}

/**
 * `input` with each chip replaced by what `label` says for it; a token no longer registered (its attachment was
 * removed, or the app restarted) reads as its plain name.
 */
export function expandAttachmentChips(input: string, registry: AttachmentChipRegistry, label: (entry: AttachmentChipEntry) => string): string {
  if (!input.includes(OPEN)) return input
  // A thread chip's token starts the same way but holds a second slot (its status dot): it is never read here.
  const pattern = new RegExp(`${ATTACHMENT_CHIP_HEAD}${NBSP}([^${OPEN}${CLOSE}${SLOT}]*)${CLOSE}`, 'g')
  return input.replace(pattern, (token: string, name: string) => {
    const entry = registry.get(token)
    if (entry) return label(entry)
    return plainName(name)
  })
}

/** `input` with each token no longer registered (a draft kept across a restart) as its plain name; chips stay. */
export function plainOrphanChips(input: string, registry: AttachmentChipRegistry): string {
  if (!input.includes(OPEN)) return input
  const pattern = new RegExp(`${ATTACHMENT_CHIP_HEAD}${NBSP}([^${OPEN}${CLOSE}${SLOT}]*)${CLOSE}`, 'g')
  return input.replace(pattern, (token: string, name: string) => (registry.has(token) ? token : plainName(name)))
}

const plainName = (name: string): string => name.replace(new RegExp(JOIN, 'g'), '').replace(/\u00a0/g, ' ').replace(/\u2011/g, '-')

/**
 * The text that puts `tokens` over `start`..`end` of `input`: one space between chips, and a space on either side where
 * a chip would touch other words. `caret` is where the caret goes after it, from `start`.
 */
export function chipInsertion(input: string, start: number, end: number, tokens: readonly string[]): { text: string; caret: number } {
  const before = input.slice(0, start)
  const after = input.slice(end)
  const lead = before && !/\s$/.test(before) ? ' ' : ''
  const trail = after && !/^\s/.test(after) ? ' ' : ''
  const text = `${lead}${tokens.join(' ')}${trail}`
  return { text, caret: text.length }
}

/** `offset`, moved to the nearer edge of the word it falls inside, so a chip dropped there doesn't split the word. */
export function wordEdge(input: string, offset: number): number {
  const word = /[^\s\u2068\u2069]/
  if (!word.test(input[offset - 1] ?? ' ') || !word.test(input[offset] ?? ' ')) return offset
  let start = offset
  while (start > 0 && word.test(input[start - 1]!)) start -= 1
  let end = offset
  while (end < input.length && word.test(input[end]!)) end += 1
  return offset - start <= end - offset ? start : end
}

/** True when the text holds words of its own besides `start`..`end`: a chip goes in only among text. */
export function hasTextAround(input: string, start: number, end: number): boolean {
  return (input.slice(0, start) + input.slice(end)).trim().length > 0
}

let shared: AttachmentChipRegistry | null = null

/** The app's one registry. */
export function attachmentChipRegistry(): AttachmentChipRegistry {
  shared ??= new Map()
  return shared
}

/** Registers `entry` and returns its token. */
export function registerAttachmentChip(entry: AttachmentChipEntry): string {
  const registry = attachmentChipRegistry()
  const token = attachmentChipTokenFor(entry, registry)
  registry.set(token, entry)
  return token
}

/** Forgets every token of `key`: its chips left in a text (an undo after the removal) read as plain names. */
export function unregisterAttachmentChips(key: string): void {
  const registry = attachmentChipRegistry()
  for (const [token, entry] of registry) if (entry.key === key) registry.delete(token)
}

/** `expandAttachmentChips` with the app's registry. */
export function expandComposerAttachmentChips(input: string, label: (entry: AttachmentChipEntry) => string): string {
  return expandAttachmentChips(input, attachmentChipRegistry(), label)
}
