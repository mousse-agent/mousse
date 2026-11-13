/**
 * Quotes in the composer (#364): text selected in a conversation is replied to with a "Reply" pill that sits in
 * the composer's text where it was inserted. The text box holds a short token for it, bracketed by two invisible
 * isolate marks, which the input backdrop paints as a pill; the quoted words live in a registry keyed by the token.
 * On send each token becomes the quoted words in double quotes, with one blank line above and below.
 */

const OPEN = '\u2068'
const CLOSE = '\u2069'
const NBSP = '\u00a0'
const PREVIEW_CHARS = 32
const STORAGE_KEY = 'mousse.composerQuotes'
const MAX_KEPT = 200

/** Token → quoted words. Kept across thread switches and restarts, as drafts are. */
/** The opening mark and "Reply" that start every token: the pill's tag. */
export const QUOTE_TAG_LENGTH = OPEN.length + 'Reply'.length

export type QuoteRegistry = Map<string, string>

export interface QuoteTokenSpan {
  index: number
  length: number
  token: string
  text: string
}

function previewOf(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  const short = flat.length > PREVIEW_CHARS ? `${flat.slice(0, PREVIEW_CHARS - 1).trimEnd()}…` : flat
  return short.replace(/ /g, NBSP)
}

/** The token for `text`: the same words give the same token; other words with the same opening get a number. */
export function quoteTokenFor(text: string, registry: QuoteRegistry): string {
  const preview = previewOf(text)
  for (let n = 1; ; n += 1) {
    const token = `${OPEN}Reply${NBSP}“${preview}”${n > 1 ? `${NBSP}${n}` : ''}${CLOSE}`
    const held = registry.get(token)
    if (held === undefined || held === text) return token
  }
}

/** Every registered quote token in `input`, in order. A token whose text was edited is no longer one. */
export function findQuoteTokens(input: string, registry: QuoteRegistry): QuoteTokenSpan[] {
  const spans: QuoteTokenSpan[] = []
  if (!input.includes(OPEN)) return spans
  const pattern = new RegExp(`${OPEN}[^${OPEN}${CLOSE}]*${CLOSE}`, 'g')
  for (const match of input.matchAll(pattern)) {
    const text = registry.get(match[0])
    if (text !== undefined) spans.push({ index: match.index, length: match[0].length, token: match[0], text })
  }
  return spans
}

/** The message text an agent gets: each quote in double quotes, alone in its paragraph. */
export function expandQuoteTokens(input: string, registry: QuoteRegistry): string {
  const spans = findQuoteTokens(input, registry)
  if (!spans.length) return input
  let out = ''
  let from = 0
  for (const span of spans) {
    const before = (out + input.slice(from, span.index)).replace(/\s+$/, '')
    out = `${before}${before ? '\n\n' : ''}"${span.text}"\n\n`
    from = span.index + span.length
  }
  const rest = input.slice(from).replace(/^\s+/, '')
  return rest ? out + rest : out.replace(/\s+$/, '')
}

/**
 * Inserts the pill for `text` over `start`..`end` of `input`, with a space on either side where it touches other
 * words. Returns the new value and the caret after the pill.
 */
export function insertQuoteToken(input: string, start: number, end: number, token: string): { value: string; caret: number } {
  const before = input.slice(0, start)
  const after = input.slice(end)
  const lead = before && !/\s$/.test(before) ? ' ' : ''
  const trail = after.startsWith(' ') ? '' : ' '
  const head = `${before}${lead}${token}${trail}`
  return { value: head + after, caret: head.length }
}

/** The span a collapsed caret sits strictly inside, so the caret can be moved off the pill. */
export function quoteTokenAround(spans: QuoteTokenSpan[], caret: number): QuoteTokenSpan | undefined {
  return spans.find((span) => caret > span.index && caret < span.index + span.length)
}

/** Backspace right after a pill, or Delete right before one, removes the whole pill. */
export function deleteQuoteTokenAt(
  input: string,
  spans: QuoteTokenSpan[],
  caret: number,
  key: 'Backspace' | 'Delete'
): { value: string; caret: number } | null {
  const span = spans.find((item) => (key === 'Backspace' ? item.index + item.length === caret : item.index === caret))
  if (!span) return null
  return { value: input.slice(0, span.index) + input.slice(span.index + span.length), caret: span.index }
}

let shared: QuoteRegistry | null = null

/** The app's one registry, read from local storage on first use. */
export function quoteRegistry(): QuoteRegistry {
  if (shared) return shared
  shared = new Map()
  try {
    const saved = JSON.parse(globalThis.localStorage?.getItem(STORAGE_KEY) ?? '[]') as unknown
    if (Array.isArray(saved)) {
      for (const entry of saved) if (Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'string') shared.set(entry[0], entry[1])
    }
  } catch {
    // A broken saved list starts empty: pills in old drafts then read as their plain text.
  }
  return shared
}

/** Registers `text` and returns its token. The newest quotes are kept; the oldest go past the limit. */
export function registerQuote(text: string): string {
  const registry = quoteRegistry()
  const token = quoteTokenFor(text, registry)
  registry.delete(token)
  registry.set(token, text)
  while (registry.size > MAX_KEPT) registry.delete(registry.keys().next().value as string)
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify([...registry]))
  } catch {
    // Storage full or unavailable: the quote still works until the app closes.
  }
  return token
}

/** `expandQuoteTokens` with the app's registry. */
export function expandComposerQuotes(input: string): string {
  return expandQuoteTokens(input, quoteRegistry())
}

/** Asks the composer of the conversation `source` is in to take a quote. */
export const COMPOSER_QUOTE_EVENT = 'mousse:composer-quote'

export interface ComposerQuoteDetail {
  target: HTMLTextAreaElement
  text: string
}
