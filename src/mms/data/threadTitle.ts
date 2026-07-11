const DEFAULT_THREAD_NAMES = new Set(['New Thread', 'New Chat'])
const MAX_TITLE_LENGTH = 56

const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'for',
  'from',
  'has',
  'have',
  'i',
  'in',
  'is',
  'it',
  'me',
  'my',
  'of',
  'on',
  'or',
  'our',
  'please',
  'that',
  'the',
  'this',
  'to',
  'with',
  'you',
  'your'
])

export function isDefaultThreadName(name: string): boolean {
  return DEFAULT_THREAD_NAMES.has(name.trim())
}

export function summarizeThreadTitle(content: string): string | null {
  const candidates = getCandidateSentences(content)
  if (candidates.length === 0) return null

  const frequencies = new Map<string, number>()
  for (const sentence of candidates) {
    for (const token of tokenize(sentence)) {
      frequencies.set(token, (frequencies.get(token) ?? 0) + 1)
    }
  }

  const best = candidates
    .map((sentence, index) => ({
      sentence,
      score: scoreSentence(sentence, frequencies) - index * 0.05
    }))
    .sort((a, b) => b.score - a.score)[0]?.sentence

  if (!best) return null

  return toReadableTitle(best)
}

function getCandidateSentences(content: string): string[] {
  return content
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\[[^\]]*(?:attached files|voice message)[^\]]*\]/gi, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .split(/(?<=[.!?])\s+|\n+/)
    .map(cleanSentence)
    .filter((sentence) => tokenize(sentence).length > 0)
    .slice(0, 5)
}

function cleanSentence(sentence: string): string {
  return sentence
    .replace(/^[-*>\s]+/, '')
    .replace(/^(?:can you|could you|would you|please|pls|i want to|i need to|let'?s|we need to)\s+/i, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function tokenize(sentence: string): string[] {
  const matches = sentence.toLowerCase().match(/[a-z0-9][a-z0-9'-]*/g) ?? []
  return matches.filter((token) => token.length > 2 && !STOP_WORDS.has(token))
}

function scoreSentence(sentence: string, frequencies: Map<string, number>): number {
  const tokens = tokenize(sentence)
  if (tokens.length === 0) return 0

  const score = tokens.reduce((sum, token) => sum + (frequencies.get(token) ?? 0), 0)
  return score / Math.sqrt(tokens.length)
}

function toReadableTitle(sentence: string): string {
  const compact = truncateAtWord(sentence.replace(/[.!?]+$/g, ''), MAX_TITLE_LENGTH)
  return compact.charAt(0).toUpperCase() + compact.slice(1)
}

function truncateAtWord(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value

  const truncated = value.slice(0, maxLength).trim()
  const lastSpace = truncated.lastIndexOf(' ')
  if (lastSpace < 24) return truncated
  return truncated.slice(0, lastSpace)
}
