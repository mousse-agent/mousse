/**
 * Cleans up dictated text after the speech model has produced it. Speech models write what they
 * hear: product names become look-alike words, "dot dot slash" stays spelled out, and a recording
 * cut into segments gets a full stop at every cut. The steps here are plain text rules; each is a
 * pure function so the pieces can be tested and switched off on their own.
 */

/** A word or phrase the model keeps mishearing, and what it should become. */
export interface DictationVocabularyEntry {
  /** What the model writes. All-capitals entries match only that spelling; others ignore case. */
  spoken: string
  /** What the text should say instead. */
  written: string
}

export interface DictationPolishOptions {
  vocabulary: readonly DictationVocabularyEntry[]
  /** "dot dot slash mousse hyphen plus" becomes "../mousse-plus" and "five point five" becomes 5.5. */
  expandSymbols: boolean
  /** "Point number one ... point number two ..." becomes a numbered list. */
  detectLists: boolean
}

/** Names Mousse and the models it talks to are usually transcribed as. */
export const DEFAULT_DICTATION_VOCABULARY: readonly DictationVocabularyEntry[] = [
  { spoken: 'MOVES', written: 'mousse' },
  { spoken: 'MOOS', written: 'mousse' },
  { spoken: 'MOS', written: 'mousse' },
  { spoken: 'moose', written: 'mousse' },
  { spoken: 'MOSID', written: 'mousse ID' },
  { spoken: 'moose ID', written: 'mousse ID' },
  { spoken: 'con x', written: 'Codex' },
  { spoken: 'codecs', written: 'Codex' },
  { spoken: 'grog', written: 'Grok' },
  { spoken: 'cloud code', written: 'Claude Code' },
  { spoken: 'clawed code', written: 'Claude Code' },
  { spoken: 'sonic', written: 'Sonnet' },
  { spoken: 'hi coo', written: 'Haiku' }
]

const NUMBER_WORDS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20
}
const NUMBER_WORD = `(?:${Object.keys(NUMBER_WORDS).join('|')}|\\d{1,3})`

function numberOf(word: string): number {
  const lower = word.toLowerCase()
  return lower in NUMBER_WORDS ? NUMBER_WORDS[lower] : Number.parseInt(lower, 10)
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/**
 * Joins the texts of a recording's segments. A model ends every segment like a sentence, so a cut
 * in the middle of one leaves "toggled. to other computers": the full stop goes when the next
 * segment carries on in lower case, and a capital that follows an unfinished segment goes too.
 */
export function joinTranscriptSegments(parts: readonly string[]): string {
  let text = ''
  for (const part of parts) {
    const next = part.trim()
    if (!next) continue
    if (!text) {
      text = next
      continue
    }
    if (/[.!?]$/.test(text) && /^[a-z]/.test(next)) text = text.replace(/[.!?]+$/, '')
    else if (/[\p{L}\p{N},;:]$/u.test(text) && /^[A-Z][a-z]/.test(next) && !/^I\b/.test(next)) {
      text = `${text} ${next.charAt(0).toLowerCase()}${next.slice(1)}`
      continue
    }
    text = `${text} ${next}`
  }
  return text
}

/** Replaces each misheard phrase with its spelling; longer phrases win over shorter ones. */
export function applyVocabulary(text: string, entries: readonly DictationVocabularyEntry[]): string {
  const usable = entries.filter((entry) => entry.spoken.trim() && entry.written.trim())
  const ordered = [...usable].sort((a, b) => b.spoken.trim().length - a.spoken.trim().length)
  let result = text
  for (const entry of ordered) {
    const spoken = entry.spoken.trim()
    const pattern = escapeRegExp(spoken).replace(/\s+/g, '\\s+')
    const caseSensitive = spoken === spoken.toUpperCase() && /[A-Z]/.test(spoken)
    const regex = new RegExp(`(?<![\\p{L}\\p{N}])${pattern}(?![\\p{L}\\p{N}])`, caseSensitive ? 'gu' : 'giu')
    result = result.replace(regex, entry.written.trim())
  }
  return result
}

const FILE_EXTENSIONS = 'json|jsonc|ts|tsx|js|jsx|mjs|cjs|md|txt|py|yml|yaml|toml|html|css|scss|sh|env|lock|xml|svg|png|jpg'

/** Turns the spoken names of path and number symbols into the symbols. */
export function expandSpokenSymbols(text: string): string {
  return (
    text
      // "dot dot slash" and "dot slash" start a path and attach to the next word.
      .replace(/\b(?:dot\s+dot\s+slash)\s*/giu, '../')
      .replace(/\b(?:dot\s+slash)\s*/giu, './')
      // Words either side of "hyphen", "underscore" or "slash" join up.
      .replace(/([\p{L}\p{N}])\s+hyphen\s+([\p{L}\p{N}])/giu, '$1-$2')
      .replace(/([\p{L}\p{N}])\s+underscore\s+([\p{L}\p{N}])/giu, '$1_$2')
      .replace(/([\p{L}\p{N}])\s+slash\s+([\p{L}\p{N}])/giu, '$1/$2')
      // "config dot json" is a file name.
      .replace(new RegExp(`([\\p{L}\\p{N}_-])\\s+dot\\s+(${FILE_EXTENSIONS})\\b`, 'giu'), '$1.$2')
      // "five point five" is a number.
      .replace(new RegExp(`\\b(${NUMBER_WORD})\\s+point\\s+(${NUMBER_WORD})\\b`, 'giu'), (_, whole: string, fraction: string) => `${numberOf(whole)}.${numberOf(fraction)}`)
  )
}

/** Words that only introduce a point and carry no meaning of their own. */
const GLUE = '(?:so|okay|ok|and|now|then|next|yeah|also|moving\\s+on\\s+to)'
const ENUMERATOR = new RegExp(
  `(?:(?:\\b${GLUE}\\b[,.:]?\\s*)*)` +
    `\\b(?:point\\s+(?:number\\s+)?(${NUMBER_WORD})(?:\\s+(?:point\\s+)?(?:number\\s+)?\\1)?(?:\\s+is)?|number\\s+(${NUMBER_WORD})\\s+is)\\b[,.:]?` +
    `(?:\\s*\\b${GLUE}\\b[,.:]?)*\\s*`,
  'giu'
)
const TRAILING_GLUE = new RegExp(`(?:\\s*\\b${GLUE}\\b[,.:]?)+\\s*$`, 'iu')

/**
 * Finds "point number one ... point number two ..." and writes the points as a numbered list,
 * each on its own paragraph. Needs at least two points counting upwards; otherwise the text is
 * left as it is.
 */
export function structureTranscript(text: string): string {
  const matches = [...text.matchAll(ENUMERATOR)]
    .map((match) => ({ index: match.index ?? 0, length: match[0].length, number: numberOf(match[1] ?? match[2] ?? '') }))
    .filter((match) => Number.isFinite(match.number))
  const points: typeof matches = []
  for (const match of matches) {
    if (points.length === 0 || match.number > points[points.length - 1].number) points.push(match)
  }
  if (points.length < 2) return text
  const blocks: string[] = []
  const intro = text.slice(0, points[0].index).replace(TRAILING_GLUE, '').trim()
  if (intro) blocks.push(intro)
  points.forEach((point, i) => {
    const end = i + 1 < points.length ? points[i + 1].index : text.length
    const body = text.slice(point.index + point.length, end).replace(TRAILING_GLUE, '').trim()
    if (body) blocks.push(`${point.number}. ${capitalize(body)}`)
  })
  return blocks.join('\n\n')
}

/**
 * Straightens spacing and sentence ends. A full stop followed by a lower-case word is a cut the
 * model made mid-sentence (models capitalize after their own full stops), so it goes; a question
 * or exclamation mark followed by lower case gets the capital instead.
 */
export function tidyPunctuation(text: string): string {
  return text
    .replace(/[ \t]+/g, ' ')
    .replace(/(?<![./])\.\.(?![./])/g, '.')
    .replace(/ +([,.;:!?])(?!\.)/g, '$1')
    .replace(/(?<=[\p{L}\p{N}]{2})\. +(?=\p{Ll})/gu, ' ')
    .replace(/([!?]) +(\p{Ll})/gu, (_, stop: string, letter: string) => `${stop} ${letter.toUpperCase()}`)
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .trim()
}

/** Runs every cleanup the user has switched on, in the order that lets each help the next. */
export function polishTranscript(text: string, options: DictationPolishOptions): string {
  let result = text
  if (options.expandSymbols) result = expandSpokenSymbols(result)
  result = applyVocabulary(result, options.vocabulary)
  if (options.detectLists) result = structureTranscript(result)
  return tidyPunctuation(result)
}

/** Reads "spoken = written" lines, as typed in Settings; blank and malformed lines are skipped. */
export function parseVocabularyText(text: string): DictationVocabularyEntry[] {
  const entries: DictationVocabularyEntry[] = []
  for (const line of text.split('\n')) {
    const separator = line.indexOf('=')
    if (separator < 0) continue
    const spoken = line.slice(0, separator).trim()
    const written = line.slice(separator + 1).trim()
    if (spoken && written) entries.push({ spoken, written })
  }
  return entries
}

export function formatVocabularyText(entries: readonly DictationVocabularyEntry[]): string {
  return entries.map((entry) => `${entry.spoken} = ${entry.written}`).join('\n')
}
