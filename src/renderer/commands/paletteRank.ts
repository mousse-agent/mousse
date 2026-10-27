/**
 * Ranks palette rows (commands, threads, projects) against what was typed. Pure: no store, no DOM.
 *
 * Case and accents are folded. A title is split into words at spaces and punctuation, at camelCase
 * humps and where letters meet digits. Tiers, best first:
 *
 *   1.5  the whole title starts with the query ("new th" -> "New thread")
 *   1    every query word starts a different title word
 *   0.9  the same, counting the row's extra `terms` words (Stop run <- "interrupt")
 *   0.6  the query without spaces starts the title's words run together from some word on
 *        ("newth" -> "New thread", "v2" -> "Release v2 notes")
 *   0.45 every query word starts a word or is one typo away from a word's start; only words of 4 or
 *        more letters may be typos, and never one with a digit
 *   0.3  one query of 4 or more characters sits inside a word
 *
 * Rows that miss every tier are dropped; equal scores keep the order they came in.
 */

export interface RankableItem {
  title: string
  /** Extra words that find the row but are not shown. Matched at word starts only. */
  terms?: readonly string[]
}

const SCORE_WHOLE_NAME = 1.5
const SCORE_WORD_STARTS = 1
const SCORE_TERM_WORD_STARTS = 0.9
const SCORE_JOINED_WORDS = 0.6
const SCORE_ONE_TYPO = 0.45
const SCORE_MID_WORD = 0.3
const MIN_TYPO_LENGTH = 4
const MIN_MID_WORD_LENGTH = 4

/** Lower case with accents removed: `Résumé` and `resume` compare equal. */
export function foldText(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
}

const WORD_PATTERN = /\p{Lu}+(?=\p{Lu}\p{Ll})|\p{Lu}?\p{Ll}+|\p{Lu}+|\p{N}+|\p{L}+/gu

/** The words of a title, folded. camelCase and digit runs start new words. */
export function splitWords(text: string): string[] {
  const unaccented = text.normalize('NFD').replace(/\p{M}/gu, '')
  return (unaccented.match(WORD_PATTERN) ?? []).map((word) => word.toLowerCase())
}

/** The words of a query: whatever is not a letter or digit separates them. */
function queryTokens(query: string): string[] {
  return foldText(query).split(/[^\p{L}\p{N}]+/u).filter(Boolean)
}

/** True when `a` and `b` differ by at most one insertion, deletion, substitution or swap of neighbours. */
function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true
  if (Math.abs(a.length - b.length) > 1) return false
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  const restA = a.slice(start)
  const restB = b.slice(start)
  if (restA.length === restB.length) {
    if (restA.slice(1) === restB.slice(1)) return true
    return restA.length >= 2 && restA[0] === restB[1] && restA[1] === restB[0] && restA.slice(2) === restB.slice(2)
  }
  return restA.length > restB.length ? restA.slice(1) === restB : restB.slice(1) === restA
}

/** The token is one typo away from the start of the word. */
function isTypoPrefix(token: string, word: string): boolean {
  if ([...token].length < MIN_TYPO_LENGTH || /\p{N}/u.test(token)) return false
  for (const length of [token.length - 1, token.length, token.length + 1]) {
    if (length > 0 && withinOneEdit(token, word.slice(0, length))) return true
  }
  return false
}

/** Each token takes a different word it starts. */
function everyTokenStartsAWord(tokens: readonly string[], words: readonly string[]): boolean {
  const free = [...words]
  for (const token of tokens) {
    const at = free.findIndex((word) => word.startsWith(token))
    if (at === -1) return false
    free.splice(at, 1)
  }
  return true
}

function everyTokenStartsOrNearlyStartsAWord(tokens: readonly string[], words: readonly string[]): boolean {
  const free = [...words]
  for (const token of tokens) {
    let at = free.findIndex((word) => word.startsWith(token))
    if (at === -1) at = free.findIndex((word) => isTypoPrefix(token, word))
    if (at === -1) return false
    free.splice(at, 1)
  }
  return true
}

/** How well a row answers the query: 0 for no match, otherwise one of the tier scores. */
export function scoreItem(query: string, item: RankableItem): number {
  const tokens = queryTokens(query)
  if (tokens.length === 0) return 0
  const title = foldText(item.title)
  const titleWords = splitWords(item.title)
  const folded = foldText(query).trim()

  if (title.startsWith(folded)) return SCORE_WHOLE_NAME
  if (everyTokenStartsAWord(tokens, titleWords)) return SCORE_WORD_STARTS
  const termWords = (item.terms ?? []).flatMap(splitWords)
  if (termWords.length > 0 && everyTokenStartsAWord(tokens, [...titleWords, ...termWords])) return SCORE_TERM_WORD_STARTS
  const joined = tokens.join('')
  if (titleWords.some((_, from) => titleWords.slice(from).join('').startsWith(joined))) return SCORE_JOINED_WORDS
  if (everyTokenStartsOrNearlyStartsAWord(tokens, [...titleWords, ...termWords])) return SCORE_ONE_TYPO
  if ([...joined].length >= MIN_MID_WORD_LENGTH && titleWords.some((word) => word.includes(joined))) return SCORE_MID_WORD
  return 0
}

/**
 * The rows that match, best first. An empty query matches everything in the order given.
 */
export function rankItems<T extends RankableItem>(query: string, items: readonly T[]): T[] {
  if (queryTokens(query).length === 0) return [...items]
  return items
    .map((item, order) => ({ item, order, score: scoreItem(query, item) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .map((entry) => entry.item)
}
