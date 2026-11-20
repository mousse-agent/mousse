import { NOT_SPELLED, SAID_AS, SPELLED_INITIALISMS } from './shortFormTable'

/**
 * Rewrites short forms the voices mispronounce, for English text: speech models read "IDK" or
 * "CLI" as one made-up word. Two rules, with the word lists in `shortFormTable.ts`:
 *
 * - Short forms with an entry in `SAID_AS` are replaced by their words ("IDK" is "I don't know").
 * - Capital-letter initialisms of 2 to 5 letters without a vowel (A, E, I, O, U or Y) are spelled
 *   letter by letter ("PR" is "P R", "PRs" is "P R s"), as are the ones listed with a vowel ("UI").
 *   Others, such as "JSON" or "TODO", are left as they are.
 */

const VOWEL = /[AEIOUY]/
const SPELLED = new Set(SPELLED_INITIALISMS)
const KEEP = new Set(NOT_SPELLED)
const LONGEST_SPELLED = Math.max(5, ...SPELLED_INITIALISMS.map((word) => word.length))

/** A capital word with an optional plural or possessive s, not part of a longer word. */
const CAPITAL_WORD = new RegExp(String.raw`(?<![\p{L}\p{N}_])([A-Z]{2,${LONGEST_SPELLED}})(s|['’]s)?(?![\p{L}\p{N}_])`, 'gu')

const entries = new Map(Object.entries(SAID_AS).map(([key, value]) => [key.toLowerCase(), { key, value }]))
const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
/** Every `SAID_AS` key, longest first so "w/o" wins over "w/", as a whole word. */
const SAID_AS_WORD = new RegExp(
  String.raw`(?<![\p{L}\p{N}_])(?:${[...entries.values()]
    .map(({ key }) => key)
    .sort((a, b) => b.length - a.length)
    .map(escape)
    .join('|')})(?![\p{L}\p{N}_])`,
  'giu'
)

export interface ShortFormOptions {
  /**
   * The voice reads through espeak (Kokoro, Kitten), which says a lone capital A as the article
   * ("uh"). The letter A is then written "eh", which espeak says as the letter.
   */
  espeak?: boolean
}

export function spokenShortForms(text: string, { espeak = false }: ShortFormOptions = {}): string {
  const spell = (letters: string): string => Array.from(letters, (letter) => (espeak && letter === 'A' ? 'eh' : letter)).join(' ')
  return text
    .replace(SAID_AS_WORD, (match: string, offset: number, whole: string) => {
      const entry = entries.get(match.toLowerCase())
      if (!entry) return match
      const { key, value } = entry
      if (typeof value !== 'string' && match !== key) return match
      const words = typeof value === 'string' ? value : value.say
      // "etc." often ends a sentence, and then keeps its period.
      if (key !== 'etc.') return words
      const after = whole.slice(offset + match.length).trimStart()
      return after === '' || /^["'“‘(]?[A-Z]/.test(after) ? `${words}.` : words
    })
    .replace(CAPITAL_WORD, (match: string, letters: string, suffix: string | undefined) => {
      const spelled = SPELLED.has(letters) || (letters.length <= 5 && !VOWEL.test(letters) && !KEEP.has(letters))
      if (!spelled) return match
      if (!suffix) return spell(letters)
      return suffix === 's' ? `${spell(letters)} s` : `${spell(letters)}${suffix}`
    })
}
