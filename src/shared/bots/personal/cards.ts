/**
 * Small cards on a bot's message (`show_card`, issue #1123): four fixed kinds the app draws from its own components,
 * never HTML, style or script from the bot. Facts (keys and values), a checklist (read-only), progress (a snapshot) and a
 * gallery of pictures from the bot's own files folder. Each card is text and numbers only, and reads as plain text too
 * (`plainCard`) for older apps, notifications, other devices, the journal and Forget. Browser-safe.
 */

export type BotChecklistState = 'done' | 'doing' | 'todo' | 'skipped'

export interface BotFactsCard {
  type: 'facts'
  title?: string
  rows: Array<{ label: string; value: string }>
}

export interface BotChecklistCard {
  type: 'checklist'
  title?: string
  items: Array<{ text: string; state: BotChecklistState }>
}

export interface BotProgressCard {
  type: 'progress'
  label: string
  done: number
  total: number
  note?: string
}

/** Pictures from the bot's files folder: each `path` is a full path inside it, checked when shown and again when read. */
export interface BotGalleryCard {
  type: 'gallery'
  title?: string
  files: Array<{ path: string; caption?: string }>
}

/** A card as the bot made it and `bots.db` keeps it (`bot_messages.cards_json`). */
export type BotCard = BotFactsCard | BotChecklistCard | BotProgressCard | BotGalleryCard

/** A gallery as the app gets it: each picture with its file's name too. */
export interface BotChatGalleryCard extends Omit<BotGalleryCard, 'files'> {
  files: Array<{ path: string; name: string; caption?: string }>
}

/** A card on a chat message, as the app draws it. */
export type BotChatCard = BotFactsCard | BotChecklistCard | BotProgressCard | BotChatGalleryCard

export const BOT_CARD_TYPES = ['facts', 'checklist', 'progress', 'gallery'] as const
export const BOT_CHECKLIST_STATES: readonly BotChecklistState[] = ['done', 'doing', 'todo', 'skipped']

export const MAX_CARD_TITLE_CHARS = 80
export const MAX_FACT_ROWS = 12
export const MAX_FACT_LABEL_CHARS = 40
export const MAX_FACT_VALUE_CHARS = 300
export const MAX_CHECKLIST_ITEMS = 20
export const MAX_CHECKLIST_TEXT_CHARS = 200
export const MAX_PROGRESS_LABEL_CHARS = 80
export const MAX_PROGRESS_NOTE_CHARS = 200
export const MAX_PROGRESS_TOTAL = 1_000_000
export const MAX_GALLERY_FILES = 8
export const MAX_GALLERY_CAPTION_CHARS = 120
export const MAX_GALLERY_PATH_CHARS = 1024
/** At most this many cards on one message, and this many bytes of them as JSON. */
export const MAX_CARDS_PER_MESSAGE = 3
export const MAX_CARDS_JSON_BYTES = 8 * 1024

/** `show_card`'s answer once the card is kept: it shows under the turn's next message. */
export const CARD_SHOWN_TEXT = 'Shown with your next message. Don\'t repeat what it says in your words.'
/** Over `MAX_CARDS_PER_MESSAGE` or `MAX_CARDS_JSON_BYTES` for one message. */
export const CARDS_FULL_TEXT = `Your next message already has as many cards as it can hold (${MAX_CARDS_PER_MESSAGE}, ${MAX_CARDS_JSON_BYTES / 1024} KB). Say the rest in words.`

const FIELDS: Record<BotCard['type'], readonly string[]> = {
  facts: ['type', 'title', 'rows'],
  checklist: ['type', 'title', 'items'],
  progress: ['type', 'label', 'done', 'total', 'note'],
  gallery: ['type', 'title', 'files']
}

/** Text that is one line: whitespace runs as one space, trimmed. */
const oneLine = (value: string) => value.replace(/\s+/g, ' ').trim()

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined

/** The keys of `value` that are not in `allowed`, for a refusal that names them. */
function unknownKeys(value: Record<string, unknown>, allowed: readonly string[]): string[] {
  return Object.keys(value).filter((key) => !allowed.includes(key))
}

/** A one-line text field of at most `max` characters, or why not. `optional`: absent or empty is fine. */
function line(value: unknown, name: string, max: number, optional: boolean): string | { problem: string } | undefined {
  if (value === undefined && optional) return undefined
  if (typeof value !== 'string') return { problem: `${name} is text.` }
  const text = oneLine(value)
  if (!text) return optional ? undefined : { problem: `${name} can't be empty.` }
  if (text.length > max) return { problem: `Keep ${name} to ${max} characters.` }
  return text
}

const isProblem = (value: unknown): value is { problem: string } => Boolean(record(value) && typeof (value as { problem?: unknown }).problem === 'string')

/**
 * A card from the bot's arguments, or why not, in words it can act on (`cardProblem`'s work). Strict: one of the four
 * types, only its own fields, each within its limits; text is one line. A gallery's paths are only checked for shape
 * here; the service checks each is a picture inside the bot's files folder.
 */
export function cardOf(value: unknown): BotCard | { problem: string } {
  const given = record(value)
  if (!given) return { problem: 'A card is an object with a type: facts, checklist, progress or gallery.' }
  const type = given.type
  if (typeof type !== 'string' || !(BOT_CARD_TYPES as readonly string[]).includes(type)) return { problem: 'A card\'s type is facts, checklist, progress or gallery.' }
  const extra = unknownKeys(given, FIELDS[type as BotCard['type']])
  if (extra.length) return { problem: `A ${type} card has no ${extra.map((key) => `"${key}"`).join(', ')}. It takes ${FIELDS[type as BotCard['type']].join(', ')}.` }
  const title = type === 'progress' ? undefined : line(given.title, 'the title', MAX_CARD_TITLE_CHARS, true)
  if (isProblem(title)) return title
  const titled = title ? { title } : {}
  if (type === 'facts') {
    if (!Array.isArray(given.rows) || given.rows.length < 1 || given.rows.length > MAX_FACT_ROWS) return { problem: `A facts card has 1 to ${MAX_FACT_ROWS} rows.` }
    const rows: BotFactsCard['rows'] = []
    for (const entry of given.rows) {
      const row = record(entry)
      if (!row || unknownKeys(row, ['label', 'value']).length) return { problem: 'Each row is { label, value }.' }
      const label = line(row.label, 'a row\'s label', MAX_FACT_LABEL_CHARS, false)
      if (isProblem(label)) return label
      const shown = line(typeof row.value === 'number' ? String(row.value) : row.value, 'a row\'s value', MAX_FACT_VALUE_CHARS, false)
      if (isProblem(shown)) return shown
      rows.push({ label: label!, value: shown! })
    }
    return { type, ...titled, rows }
  }
  if (type === 'checklist') {
    if (!Array.isArray(given.items) || given.items.length < 1 || given.items.length > MAX_CHECKLIST_ITEMS) return { problem: `A checklist has 1 to ${MAX_CHECKLIST_ITEMS} items.` }
    const items: BotChecklistCard['items'] = []
    for (const entry of given.items) {
      const item = record(entry)
      if (!item || unknownKeys(item, ['text', 'state']).length) return { problem: 'Each item is { text, state }.' }
      const text = line(item.text, 'an item', MAX_CHECKLIST_TEXT_CHARS, false)
      if (isProblem(text)) return text
      if (typeof item.state !== 'string' || !(BOT_CHECKLIST_STATES as readonly string[]).includes(item.state)) return { problem: 'An item\'s state is done, doing, todo or skipped.' }
      items.push({ text: text!, state: item.state as BotChecklistState })
    }
    return { type, ...titled, items }
  }
  if (type === 'progress') {
    const label = line(given.label, 'the label', MAX_PROGRESS_LABEL_CHARS, false)
    if (isProblem(label)) return label
    const whole = (value: unknown) => typeof value === 'number' && Number.isInteger(value)
    if (!whole(given.total) || (given.total as number) < 1 || (given.total as number) > MAX_PROGRESS_TOTAL) return { problem: `total is a whole number from 1 to ${MAX_PROGRESS_TOTAL}.` }
    if (!whole(given.done) || (given.done as number) < 0 || (given.done as number) > (given.total as number)) return { problem: 'done is a whole number from 0 to total.' }
    const note = line(given.note, 'the note', MAX_PROGRESS_NOTE_CHARS, true)
    if (isProblem(note)) return note
    return { type, label: label!, done: given.done as number, total: given.total as number, ...(note ? { note } : {}) }
  }
  if (!Array.isArray(given.files) || given.files.length < 1 || given.files.length > MAX_GALLERY_FILES) return { problem: `A gallery has 1 to ${MAX_GALLERY_FILES} pictures.` }
  const files: BotGalleryCard['files'] = []
  for (const entry of given.files) {
    const file = record(entry)
    if (!file || unknownKeys(file, ['path', 'caption']).length) return { problem: 'Each picture is { path, caption? }.' }
    if (typeof file.path !== 'string' || !file.path.trim() || file.path.length > MAX_GALLERY_PATH_CHARS) return { problem: 'Each picture\'s path is a file in your files folder.' }
    // Never a link to load: only files of this computer, in the bot's own folder.
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(file.path.trim()) && !/^file:\/\//i.test(file.path.trim())) return { problem: 'A gallery shows pictures from your files folder, never web addresses.' }
    const caption = line(file.caption, 'a caption', MAX_GALLERY_CAPTION_CHARS, true)
    if (isProblem(caption)) return caption
    files.push({ path: file.path.trim(), ...(caption ? { caption } : {}) })
  }
  return { type: 'gallery', ...titled, files }
}

/** Why `cards` can't go on one message (too many, or too large), or undefined when they can. */
export function cardsProblem(cards: readonly BotCard[]): string | undefined {
  if (cards.length > MAX_CARDS_PER_MESSAGE) return CARDS_FULL_TEXT
  if (new TextEncoder().encode(JSON.stringify(cards)).length > MAX_CARDS_JSON_BYTES) return CARDS_FULL_TEXT
  return undefined
}

/** A file's name from its path, either separator. */
export function cardFileName(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path
}

const CHECK_MARKS: Record<BotChecklistState, string> = { done: '[x]', doing: '[~]', todo: '[ ]', skipped: '[-]' }

/**
 * A card as plain text: facts as "Label: value" lines, a checklist as "[x] …" lines, progress as "3 of 5 · label", a
 * gallery as its files' names. Each under its title when it has one.
 */
export function plainCard(card: BotCard | BotChatCard): string {
  const head = 'title' in card && card.title ? [card.title] : []
  if (card.type === 'facts') return [...head, ...card.rows.map((row) => `${row.label}: ${row.value}`)].join('\n')
  if (card.type === 'checklist') return [...head, ...card.items.map((item) => `${CHECK_MARKS[item.state]} ${item.text}`)].join('\n')
  if (card.type === 'progress') return `${card.done} of ${card.total} · ${card.label}${card.note ? `\n${card.note}` : ''}`
  return [...head, ...card.files.map((file) => `${cardFileName(file.path)}${file.caption ? ` (${file.caption})` : ''}`)].join('\n')
}

/** A message's cards as plain text, each a paragraph. */
export function plainCards(cards: readonly (BotCard | BotChatCard)[] | undefined): string {
  return (cards ?? []).map(plainCard).join('\n\n')
}
