import { ESPEAK_SPELLED, NOT_SPELLED, SAID_AS, SPELLED_INITIALISMS } from './shortFormTable'
import { UNITS } from './spokenEnglish'

/**
 * Rewrites short forms the voices mispronounce, for English text: speech models read "IDK" as one
 * made-up word. The word lists are in `shortFormTable.ts`.
 *
 * - Short forms with an entry in `SAID_AS` are replaced by their words ("IDK" is "I don't know").
 * - Capital-letter initialisms of 2 to 5 letters without a vowel (A, E, I, O, U or Y) are spelled
 *   letter by letter ("PR" is "P R"), as are the ones listed with a vowel ("UI"). Voices that read
 *   through espeak say almost all of them right as written, so for those only `ESPEAK_SPELLED` is
 *   spelled. Others, such as "JSON" or "TODO", are left as they are.
 *
 * Left alone everywhere: plurals and possessives ("PRs", "PR's"), which the voices say better as
 * written; units and AM/PM after a number, which `spokenEnglish` reads; and words inside paths or
 * code names ("tests/e2e/x.ts", "process.stdout").
 */

const VOWEL = /[AEIOUY]/
const SPELLED = new Set(SPELLED_INITIALISMS)
const SPELLED_FOR_ESPEAK = new Set(ESPEAK_SPELLED)
const KEEP = new Set(NOT_SPELLED)
const AFTER_NUMBER = new Set([...Object.keys(UNITS), 'am', 'pm'])
const LONGEST_SPELLED = Math.max(5, ...SPELLED_INITIALISMS.map((word) => word.length))

/** Not inside a word, a path or a dotted name. */
const BEFORE = String.raw`(?<![\p{L}\p{N}_/\\.])`
const AFTER = String.raw`(?![\p{L}\p{N}_/\\]|\.[\p{L}\p{N}])`
/** A capital word, not followed by an apostrophe and a letter ("PR's"). */
const CAPITAL_WORD = new RegExp(String.raw`${BEFORE}[A-Z]{2,${LONGEST_SPELLED}}${AFTER}(?!['’]\p{L})`, 'gu')

const entries = new Map(Object.entries(SAID_AS).map(([key, value]) => [key.toLowerCase(), { key, value }]))
const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
/** Every `SAID_AS` key, longest first so "w/o" wins over "w/", as a whole word. */
const SAID_AS_WORD = new RegExp(
  `${BEFORE}(?:${[...entries.values()]
    .map(({ key }) => key)
    .sort((a, b) => b.length - a.length)
    .map(escape)
    .join('|')})${AFTER}`,
  'giu'
)

export interface ShortFormOptions {
  /**
   * The voice reads through espeak (Kokoro, Kitten). espeak spells most initialisms itself, and it
   * says a lone capital A as the article ("uh"), so the letter A is written "eh".
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
      const after = whole.slice(offset + match.length).replace(/^["'”’)\]]+/, '').trimStart()
      return after === '' || /^["'“‘(]?[A-Z]/.test(after) ? `${words}.` : words
    })
    .replace(CAPITAL_WORD, (letters: string, offset: number, whole: string) => {
      if (AFTER_NUMBER.has(letters.toLowerCase()) && /\d\s*$/.test(whole.slice(Math.max(0, offset - 8), offset))) return letters
      const spelled = espeak
        ? SPELLED_FOR_ESPEAK.has(letters)
        : SPELLED.has(letters) || (letters.length <= 5 && !VOWEL.test(letters) && !KEEP.has(letters))
      return spelled ? spell(letters) : letters
    })
}

/** Common English words, by which `looksEnglish` tells English text apart. Words other languages share ("a", "in") are left out. */
const ENGLISH_WORDS = new Set([
  'the', 'and', 'is', 'are', 'was', 'to', 'of', 'that', 'it', 'for', 'you', 'with', 'this', 'be', 'not', 'have', 'we', 'but',
  'what', 'can', 'will', 'if', 'or', 'there', 'from', 'by', 'my', 'your', "it's", "don't", 'they', 'at'
])

/** True for text that reads as English, or too short to tell. */
export function looksEnglish(text: string): boolean {
  const words = text.toLowerCase().match(/\p{L}+(?:['’]\p{L}+)?/gu) ?? []
  if (words.length < 5) return true
  return words.filter((word) => ENGLISH_WORDS.has(word.replace('’', "'"))).length >= words.length * 0.1
}

/** `spokenShortForms` for a voice that may speak another language (Supertonic, providers): only English text changes. */
export function spokenShortFormsIfEnglish(text: string, options: ShortFormOptions = {}): string {
  return looksEnglish(text) ? spokenShortForms(text, options) : text
}
