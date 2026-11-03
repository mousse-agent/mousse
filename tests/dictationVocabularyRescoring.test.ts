import { describe, expect, it } from 'vitest'
import { normalizeVocabulary, parseSoundsLike } from '../src/shared/dictationVocabulary'
import {
  decodedWords,
  findCandidates,
  soundKey,
  tdtSequenceScore,
  tokenizeTerm,
  type DecodedWord
} from '../src/renderer/dictation/vocabularyRescoring'

/** Words as the greedy decode would split them, one piece each. */
const wordsOf = (text: string): DecodedWord[] =>
  text.split(' ').map((word, index) => ({ text: word, start: index, end: index + 1, punctuation: 0 }))
const terms = (...names: Array<string | { term: string; soundsLike: string[] }>) => normalizeVocabulary(names)
const spans = (text: string, list: ReturnType<typeof terms>) => {
  const words = wordsOf(text)
  return findCandidates(words, list).map((candidate) => ({
    heard: words.slice(candidate.startWord, candidate.endWord).map((word) => word.text).join(' '),
    term: candidate.term.term,
    spellingOnly: candidate.spellingOnly
  }))
}

describe('the vocabulary list', () => {
  it('drops blanks, merges terms that differ in case and keeps spellings unique', () => {
    expect(normalizeVocabulary(['  ', 'Grok', { term: 'grok', soundsLike: ['grock', 'Grock', 'GROK'] }, { term: 'Vite', soundsLike: 'x' }])).toEqual([
      { term: 'Grok', soundsLike: ['grock'] },
      { term: 'Vite', soundsLike: [] }
    ])
  })

  it('reads comma-separated spellings', () => {
    expect(parseSoundsLike(' open code, ,opencode ')).toEqual(['open code', 'opencode'])
  })
})

describe('finding words that may be a vocabulary term', () => {
  it('finds a misheard name, spread over one or more words', () => {
    expect(spans('Switch to clawed code now', terms('Claude Code'))).toContainEqual({ heard: 'clawed code', term: 'Claude Code', spellingOnly: false })
    expect(spans('written with Zustend.', terms('Zustand'))).toEqual([{ heard: 'Zustend.', term: 'Zustand', spellingOnly: false }])
    expect(spans('Adit Yaw will review', terms('Aditya'))).toContainEqual({ heard: 'Adit Yaw', term: 'Aditya', spellingOnly: false })
  })

  it('never takes a neighbouring word along with a term already heard', () => {
    expect(spans('Ask Codex to fix it', terms('Codex'))).toEqual([])
    expect(spans('the review in Haiku for', terms('Haiku'))).toEqual([])
  })

  it('writes a term whose spelling alone differs without asking the audio', () => {
    expect(spans('Send the logs to posthog', terms('PostHog'))).toEqual([{ heard: 'posthog', term: 'PostHog', spellingOnly: true }])
    expect(spans('Run it in open code', terms('OpenCode'))).toContainEqual({ heard: 'open code', term: 'OpenCode', spellingOnly: true })
  })

  it('leaves a word that differs from a term only by its first capital', () => {
    expect(spans('the parakeet model', terms('Parakeet'))).toEqual([])
    expect(spans('a side effect', terms('Effect'))).toEqual([])
  })

  it('leaves inflections, addresses and paths as heard', () => {
    expect(spans('two Cappuccinos please', terms('Cappuccino'))).toEqual([])
    expect(spans('open opencode.ai now', terms('OpenCode'))).toEqual([])
  })

  it('matches a short term by sound only, or by its sounds-like spellings', () => {
    expect(spans('Grock answered', terms('Grok'))).toEqual([{ heard: 'Grock', term: 'Grok', spellingOnly: false }])
    expect(spans('Vit rebuilds', terms('Vite'))).toEqual([{ heard: 'Vit', term: 'Vite', spellingOnly: false }])
    expect(spans('the grape answered', terms('Grok'))).toEqual([])
    expect(spans('Dacks said so', terms('Dax'))).toEqual([])
    expect(spans('Dacks said so', terms({ term: 'Dax', soundsLike: ['dacks'] }))).toEqual([{ heard: 'Dacks', term: 'Dax', spellingOnly: false }])
  })

  it('does not reach across the end of a sentence', () => {
    expect(spans('it was open. Code is next', terms('OpenCode'))).toEqual([])
  })

  it('hears "capuchin" and "Cappuccino" as the same sounds', () => {
    expect(soundKey('capuchin')).toBe(soundKey('Cappuccino'))
  })
})

describe('splitting the decode into words', () => {
  it('starts a word at each ▁ piece and counts trailing punctuation pieces', () => {
    const vocabulary = ['▁Open', 'Code', '▁rocks', '.', ',', '<blk>']
    expect(decodedWords(vocabulary, [0, 1, 2, 3])).toEqual([
      { text: 'OpenCode', start: 0, end: 2, punctuation: 0 },
      { text: 'rocks.', start: 2, end: 4, punctuation: 1 }
    ])
  })
})

describe('writing a term as model pieces', () => {
  const vocabulary = ['▁', '▁Open', 'Code', 'C', 'o', 'd', 'e', '▁Cl', 'aude', '▁Co', 'de']
  const pieces = new Map(vocabulary.map((piece, id) => [piece, id] as const))
  it('takes the longest piece first and starts each word with ▁', () => {
    expect(tokenizeTerm('OpenCode', pieces, 5)).toEqual([1, 2])
    expect(tokenizeTerm('Claude Code', pieces, 5)).toEqual([7, 8, 9, 10])
  })
  it('gives up on a character the model has no piece for', () => {
    expect(tokenizeTerm('Zed', pieces, 5)).toBeNull()
  })
})

describe('scoring a token sequence on the TDT lattice', () => {
  // Token 0, blank 1, durations 0 and 1: every choice has probability one half.
  const even = () => new Float32Array(4)

  it('sums every alignment', () => {
    // Over one frame, token 0 is written with duration 1 (1/4), or with duration 0 and then a
    // blank of duration 1 (1/16).
    expect(Math.exp(tdtSequenceScore(1, [0], 1, even))).toBeCloseTo(5 / 16, 6)
  })

  it('scores higher the sequence the joiner prefers', () => {
    // Three tokens and a blank (id 3); the joiner always favours token 2.
    const favoursTwo = () => Float32Array.from([0, 0, 4, 0, 0, 0])
    expect(tdtSequenceScore(2, [2], 3, favoursTwo)).toBeGreaterThan(tdtSequenceScore(2, [1], 3, favoursTwo))
  })

  it('cannot write a sequence over no frames', () => {
    expect(tdtSequenceScore(0, [0], 1, even)).toBe(Number.NEGATIVE_INFINITY)
  })
})
