import type { DictationVocabularyTerm } from '../../shared/dictationVocabulary'

/**
 * Vocabulary for Parakeet, decided by the audio. After the greedy decode, spans of up to four words
 * that look or sound like a vocabulary term become candidates. Each candidate is scored twice on the
 * same encoder frames, from the same prediction state: once as the words heard, once as the term.
 * The term replaces the words only when its score plus `boost` per term piece reaches theirs.
 * Ordinary words that merely look like a term stay, because the audio scores them far higher.
 * Everything here is pure; `nemoRecognizer.ts` runs the models.
 */

/** Spans longer than this many words are not compared with a term. */
export const MAX_SPAN_WORDS = 4
/** Most candidates scored per decode. */
export const MAX_CANDIDATES = 16
/** Natural-log bonus per term piece (Hex's "Normal" strength). */
export const DEFAULT_BOOST = 2.5
/** Terms shorter than this many letters need a "sounds like" spelling to be candidates. */
const MIN_LOOSE_LETTERS = 5

/** One word of the greedy transcript: its pieces `[start, end)` in the token list. */
export interface DecodedWord {
  /** The word as written, punctuation included. */
  text: string
  start: number
  end: number
  /** Pieces at the end of the word that are only punctuation ("," "."). */
  punctuation: number
}

/** A span of words `[startWord, endWord)` that may be `term`. */
export interface VocabularyCandidate {
  startWord: number
  endWord: number
  term: DictationVocabularyTerm
  /**
   * The span has the term's letters and differs only in spacing or in capitals inside the term
   * ("open code", "posthog" for OpenCode and PostHog). The audio cannot tell spellings apart, so
   * the term is written without rescoring.
   */
  spellingOnly: boolean
}

/** Letters and digits only, lower case: "Open Code," and "opencode" compare equal. */
export function letters(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
}

const PUNCTUATION_PIECE = /^[^\p{L}\p{N}▁]+$/u

/** Splits greedy tokens into words; a piece starting with `▁` starts a word. */
export function decodedWords(vocabulary: readonly string[], tokens: readonly number[]): DecodedWord[] {
  const words: DecodedWord[] = []
  for (let index = 0; index < tokens.length; index += 1) {
    const piece = vocabulary[tokens[index]] ?? ''
    const last = words[words.length - 1]
    if (piece.startsWith('▁') || !last) words.push({ text: piece.replace(/^▁/, ''), start: index, end: index + 1, punctuation: 0 })
    else {
      last.text += piece
      last.end = index + 1
    }
  }
  for (const word of words) {
    let count = 0
    while (count < word.end - word.start - 1 && PUNCTUATION_PIECE.test(vocabulary[tokens[word.end - 1 - count]] ?? '')) count += 1
    word.punctuation = count
  }
  return words
}

export function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, index) => index)
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = row[0]
    row[0] = i
    for (let j = 1; j <= b.length; j += 1) {
      const above = row[j]
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1))
      diagonal = above
    }
  }
  return row[b.length]
}

/**
 * A rough sound key for English spellings: consonant sounds only, with letters that sound alike
 * merged, so "capuchin" and "Cappuccino" both read `kpkn`.
 */
export function soundKey(text: string): string {
  const word = letters(text)
    .replace(/ph/g, 'f')
    .replace(/ck/g, 'k')
    // Italian "cc" before e or i (cappuccino) sounds like "ch".
    .replace(/cc(?=[eiy])/g, 'k')
    .replace(/[cs]h/g, 'k')
    .replace(/c(?=[eiy])/g, 's')
    .replace(/x/g, 'ks')
  let key = ''
  for (const char of word) {
    const sound = 'aeiouyhw'.includes(char)
      ? ''
      : ({ c: 'k', q: 'k', g: 'k', z: 's', v: 'f', d: 't', b: 'p' } as Record<string, string>)[char] ?? char
    if (sound && !key.endsWith(sound)) key += sound
  }
  return key
}

/** Whether `heard` (reduced by `letters`) is close enough to `target` to score on the audio. */
function looksLike(heard: string, target: string): boolean {
  if (heard.length < target.length * 0.6 || heard.length > target.length * 1.6) return false
  const heardKey = soundKey(heard)
  const targetKey = soundKey(target)
  // Short terms ("Grok", "Vite") match by sound only: too many words are a letter or two off.
  if (target.length < MIN_LOOSE_LETTERS) return heardKey === targetKey && heardKey.length >= 2
  if (editDistance(heard, target) <= Math.max(1, Math.round(target.length * 0.3))) return true
  if (heardKey === targetKey) return heardKey.length >= 2
  return targetKey.length >= MIN_LOOSE_LETTERS && editDistance(heardKey, targetKey) <= 1
}

const ADDRESS_MARK = /[./@:\\_]/
const TRAILING_PUNCTUATION = /[.,!?;:]+$/u
const NOT_WORD = /[^\p{L}\p{N}\s]/gu
const CAPITAL = /\p{Lu}/u
const WORD_START_CAPITAL = /\s+\p{Lu}/gu

/** Whether `span` may be `term`: null when not, else whether it differs only in spelling. */
function matchTerm(span: readonly DecodedWord[], term: DictationVocabularyTerm): { spellingOnly: boolean } | null {
  const raw = span.map((word) => word.text).join(' ')
  const heard = letters(raw)
  const target = letters(term.term)
  if (!target || !heard) return null
  // Addresses and paths ("opencode.ai") are written on purpose.
  if (ADDRESS_MARK.test(raw.replace(TRAILING_PUNCTUATION, ''))) return null
  // An inflection of the term ("Cappuccinos") is left as heard.
  if (heard === `${target}s` || heard === `${target}es`) return null
  if (heard === target) {
    if (raw.replace(NOT_WORD, '') === term.term) return null
    // Joined words or capitals inside the term ("PostHog") are worth fixing. A first capital alone
    // is not: "effect" stays a word when "Effect" is listed.
    const innerCapital = CAPITAL.test(term.term.slice(1).replace(WORD_START_CAPITAL, ' '))
    return span.length > 1 || innerCapital ? { spellingOnly: true } : null
  }
  // A span whose end word adds nothing to the match is a shorter span plus a neighbour ("Codex
  // to"); it is never the term.
  if (span.length > 1) {
    const distance = editDistance(heard, target)
    for (const shorter of [span.slice(1), span.slice(0, -1)]) {
      if (editDistance(letters(shorter.map((word) => word.text).join('')), target) <= distance) return null
    }
  }
  if (term.soundsLike.some((spelling) => letters(spelling) === heard)) return { spellingOnly: false }
  return looksLike(heard, target) ? { spellingOnly: false } : null
}

/** Spans of up to `MAX_SPAN_WORDS` words that may be a term, at most `MAX_CANDIDATES`, in order. */
export function findCandidates(words: readonly DecodedWord[], terms: readonly DictationVocabularyTerm[]): VocabularyCandidate[] {
  const candidates: VocabularyCandidate[] = []
  for (let start = 0; start < words.length; start += 1) {
    for (let end = start + 1; end <= Math.min(words.length, start + MAX_SPAN_WORDS); end += 1) {
      const span = words.slice(start, end)
      // Punctuation inside a span means a sentence or clause ends in it.
      if (span.slice(0, -1).some((word) => TRAILING_PUNCTUATION.test(word.text))) break
      for (const term of terms) {
        const match = matchTerm(span, term)
        if (!match) continue
        candidates.push({ startWord: start, endWord: end, term, ...match })
        if (candidates.length >= MAX_CANDIDATES) return candidates
      }
    }
  }
  return candidates
}

/**
 * The term as pieces of the model's vocabulary, longest piece first; `▁` marks each word's start.
 * Returns null when a character has no piece, so the model could never write the term.
 */
export function tokenizeTerm(term: string, pieces: ReadonlyMap<string, number>, longestPiece: number): number[] | null {
  const text = `▁${term.trim().replace(/\s+/g, '▁')}`
  const ids: number[] = []
  for (let at = 0; at < text.length; ) {
    let found = 0
    for (let length = Math.min(longestPiece, text.length - at); length > 0; length -= 1) {
      const id = pieces.get(text.slice(at, at + length))
      if (id === undefined) continue
      ids.push(id)
      found = length
      break
    }
    if (!found) return null
    at += found
  }
  return ids
}

function logSoftmax(values: ArrayLike<number>, from: number, to: number, out: Float64Array): void {
  let max = Number.NEGATIVE_INFINITY
  for (let index = from; index < to; index += 1) if (values[index] > max) max = values[index]
  let sum = 0
  for (let index = from; index < to; index += 1) sum += Math.exp(values[index] - max)
  const log = max + Math.log(sum)
  for (let index = from; index < to; index += 1) out[index - from] = values[index] - log
}

function logAdd(a: number, b: number): number {
  if (a === Number.NEGATIVE_INFINITY) return b
  if (b === Number.NEGATIVE_INFINITY) return a
  const max = Math.max(a, b)
  return max + Math.log(Math.exp(a - max) + Math.exp(b - max))
}

/**
 * Log probability that a TDT model writes exactly `tokens` over `frames` encoder frames, summed
 * over every alignment. `logits(frame, u)` are the joiner's raw scores after the first `u` tokens:
 * token scores up to and including `blank`, then one per duration (0, 1, 2 ... frames). A token may
 * stay on its frame (duration 0); a blank always moves on. Landing past the last frame ends there.
 */
export function tdtSequenceScore(
  frames: number,
  tokens: readonly number[],
  blank: number,
  logits: (frame: number, u: number) => ArrayLike<number>
): number {
  const width = tokens.length + 1
  const alpha = new Float64Array((frames + 1) * width).fill(Number.NEGATIVE_INFINITY)
  alpha[0] = 0
  let tokenScores = new Float64Array(0)
  let durationScores = new Float64Array(0)
  for (let frame = 0; frame < frames; frame += 1) {
    for (let u = 0; u < width; u += 1) {
      const here = alpha[frame * width + u]
      if (here === Number.NEGATIVE_INFINITY) continue
      const scores = logits(frame, u)
      const durations = scores.length - blank - 1
      if (tokenScores.length !== blank + 1) tokenScores = new Float64Array(blank + 1)
      if (durationScores.length !== durations) durationScores = new Float64Array(durations)
      logSoftmax(scores, 0, blank + 1, tokenScores)
      logSoftmax(scores, blank + 1, scores.length, durationScores)
      for (let duration = 0; duration < durations; duration += 1) {
        const next = Math.min(frames, frame + duration)
        if (u < tokens.length) {
          const at = next * width + u + 1
          alpha[at] = logAdd(alpha[at], here + tokenScores[tokens[u]] + durationScores[duration])
        }
        if (duration > 0) {
          const at = next * width + u
          alpha[at] = logAdd(alpha[at], here + tokenScores[blank] + durationScores[duration])
        }
      }
    }
  }
  return alpha[frames * width + tokens.length]
}
