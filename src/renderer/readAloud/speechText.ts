export const CODE_BLOCK_PLACEHOLDER = 'Code block omitted.'

const FENCE = /^\s{0,3}(`{3,}|~{3,})/
const HORIZONTAL_RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/
const TABLE_DIVIDER = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

function endWithPunctuation(line: string): string {
  return /[.!?:;,—]["')\]]*$/.test(line) ? line : `${line}.`
}

function stripInline(text: string): string {
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/!\[[^\]]*\]\[[^\]]*\]/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1')
    .replace(/<(https?:\/\/[^>\s]+)>/g, 'link')
    .replace(/<\/?(?:br|p|div|li|ul|ol|tr|td|th|h[1-6]|blockquote|pre|table)\b[^>]*>/gi, ' ')
    .replace(/<\/?[a-zA-Z][^>]*>/g, '')
    .replace(/https?:\/\/[^\s)]+/g, 'link')
    .replace(/(`+)([^`]+?)\1/g, '$2')
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '$2')
    .replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?=[^\w*]|$)/g, '$1$2')
    .replace(/(^|[^\w])_(?=\S)([^_\n]*?\S)_(?=[^\w]|$)/g, '$1$2')
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '$1')
    .replace(/&(#\d+|#x[\da-f]+|[a-z]+);/gi, (match, name: string) => {
      if (name[0] === '#') {
        const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10)
        return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : ''
      }
      return ENTITIES[name.toLowerCase()] ?? match
    })
    .replace(/\\([\\`*_{}[\]()#+\-.!|>~])/g, '$1')
}

/** Turns chat markdown into plain text that reads naturally aloud. Returns '' when nothing is speakable. */
export function markdownToSpeechText(markdown: string): string {
  const paragraphs: string[] = []
  let current: string[] = []
  const flush = (): void => {
    if (current.length === 0) return
    const text = current.join(' ').replace(/\s+/g, ' ').trim()
    if (text) paragraphs.push(text)
    current = []
  }

  let fence: { marker: string; length: number } | null = null
  for (const rawLine of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    const fenceMatch = FENCE.exec(rawLine)
    if (fence) {
      if (fenceMatch && fenceMatch[1][0] === fence.marker && fenceMatch[1].length >= fence.length && rawLine.trim() === fenceMatch[1]) {
        fence = null
      }
      continue
    }
    if (fenceMatch) {
      flush()
      fence = { marker: fenceMatch[1][0], length: fenceMatch[1].length }
      paragraphs.push(CODE_BLOCK_PLACEHOLDER)
      continue
    }
    if (!rawLine.trim()) {
      flush()
      continue
    }
    if (HORIZONTAL_RULE.test(rawLine) || (rawLine.includes('-') && TABLE_DIVIDER.test(rawLine) && rawLine.includes('|'))) {
      flush()
      continue
    }

    let line = rawLine
    let standalone = false
    line = line.replace(/^\s{0,3}(>\s?)+/, '')
    const heading = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line)
    if (heading) {
      line = heading[1]
      standalone = true
    } else {
      const item = /^\s*(?:[-*+]|\d{1,9}[.)])\s+(?:\[[ xX]\]\s+)?(.*)$/.exec(line)
      if (item) {
        line = item[1]
        standalone = true
      }
    }
    if (!standalone && line.includes('|') && /^\s*\|.*\|\s*$/.test(line)) {
      line = line.trim().slice(1, -1).split('|').map((cell) => cell.trim()).filter(Boolean).join(', ')
      standalone = true
    }
    line = stripInline(line).trim()
    if (!line) continue
    if (standalone) {
      flush()
      paragraphs.push(endWithPunctuation(line))
    } else {
      current.push(line)
    }
  }
  flush()
  return paragraphs.join('\n\n')
}

// ---------------------------------------------------------------------------------------------
// Sentences and cuts
// ---------------------------------------------------------------------------------------------

/** Words (lowercase, without their final period) whose period never ends a sentence. */
const ABBREVIATIONS = new Set(['e.g', 'i.e', 'vs', 'cf', 'approx'])
/** Titles whose period never ends a sentence when they are capitalized; `30 ms.` still does. */
const TITLES = new Set(['Mr', 'Mrs', 'Ms', 'Dr', 'Prof'])
/** A sentence mark with its closing quotes or brackets, before a space or the end of the text. */
const SENTENCE_MARK = /[.!?…]+["'’”)\]]*(?=\s|$)/g

/**
 * True when the mark at `at` ends a sentence. A single period after a known abbreviation ("e.g.",
 * "Dr.") never does. After "etc." or a word with dots in it ("a.m.", "notes.md"), it does only
 * before a capital letter or the end of the text.
 */
export function endsSentence(text: string, at: number, mark: string): boolean {
  if (!mark.startsWith('.') || mark.startsWith('..')) return true
  const word = /([A-Za-z0-9]+(?:\.[A-Za-z0-9]+)*)$/.exec(text.slice(0, at))?.[1]
  if (!word) return true
  const lower = word.toLowerCase()
  if (ABBREVIATIONS.has(lower) || TITLES.has(word)) return false
  if (lower !== 'etc' && !word.includes('.')) return true
  const next = text.slice(at + mark.length).trimStart()
  return next === '' || /^["'“‘(]?[A-Z]/.test(next)
}

/** The sentences of one paragraph. Decimals, file names and versions keep their dots. */
export function splitSentences(paragraph: string): string[] {
  const sentences: string[] = []
  let start = 0
  for (const match of paragraph.matchAll(SENTENCE_MARK)) {
    if (!endsSentence(paragraph, match.index, match[0])) continue
    const end = match.index + match[0].length
    const sentence = paragraph.slice(start, end).trim()
    if (sentence) sentences.push(sentence)
    start = end
  }
  const rest = paragraph.slice(start).trim()
  if (rest) sentences.push(rest)
  return sentences
}

/** A cut at a comma or similar leaves at least this much of the sentence on each side. */
const MIN_CLAUSE_CHARS = 20
/** Places after a comma, semicolon, colon or dash. */
const CLAUSE_MARKS = /[,;:](?=\s)|\s[-–]\s|—\s?/g
/** Places before a word that starts a clause. */
const CONJUNCTIONS = /\s(?=(?:and|but|or|so|because|which|while|when|where|whereas|although|though|unless|until|since|then|if)\s)/gi

/** Of the places in `ats`, the one whose first part is nearest `target`, the longer on a tie. */
function nearest(sentence: string, ats: number[], target: number): number | null {
  let best: number | null = null
  let bestDistance = Infinity
  for (const at of ats) {
    const distance = Math.abs(sentence.slice(0, at).trim().length - target)
    if (distance <= bestDistance) {
      best = at
      bestDistance = distance
    }
  }
  return best
}

/**
 * Where to cut `sentence` so that its first part is at most `max` characters: after a comma,
 * semicolon, colon or dash, else before a conjunction such as "and" or "because", each leaving at
 * least 20 characters on both sides. Among several places, the first part nearest `target` wins.
 * Null when there is no such place.
 */
function clauseCut(sentence: string, max: number, target: number): number | null {
  const fits = (at: number): boolean => {
    const head = sentence.slice(0, at).trim().length
    return head <= max && head >= MIN_CLAUSE_CHARS && sentence.slice(at).trim().length >= MIN_CLAUSE_CHARS
  }
  for (const pattern of [CLAUSE_MARKS, CONJUNCTIONS]) {
    const ats = [...sentence.matchAll(pattern)].map((match) => match.index + match[0].length).filter(fits)
    if (ats.length > 0) return nearest(sentence, ats, target)
  }
  return null
}

/** Places before a word that usually starts a phrase. */
const PHRASE_STARTS =
  /\s(?=(?:the|a|an|to|of|in|on|at|for|with|from|by|into|about|after|before|during|without|that|this|these|those|its|their|his|her|our|your|my|who|what|how|why)\s)/gi

/** A cut before a phrase word is taken only this close to the target length. */
const PHRASE_SLACK = 15

/**
 * A cut at a clause when there is one, else before a word that starts a phrase ("the", "of") within
 * `PHRASE_SLACK` of `target`, else between the words nearest `target`, else at `max`.
 */
function cutAt(sentence: string, max: number, target: number): number {
  const clause = clauseCut(sentence, max, target)
  if (clause !== null) return clause
  const spaces = (pattern: RegExp): number[] =>
    [...sentence.matchAll(pattern)].map((match) => match.index).filter((at) => at > 0 && sentence.slice(0, at).trim().length <= max)
  const phrases = spaces(PHRASE_STARTS).filter((at) => {
    const head = sentence.slice(0, at).trim().length
    return head >= MIN_CLAUSE_CHARS && Math.abs(head - target) <= PHRASE_SLACK
  })
  return nearest(sentence, phrases.length > 0 ? phrases : spaces(/\s+/g), target) ?? max
}

// ---------------------------------------------------------------------------------------------
// Provider chunks
// ---------------------------------------------------------------------------------------------

/**
 * Splits text into pieces of at most `maxChars`, preferring paragraph, then sentence, then clause,
 * then word boundaries. Paragraph breaks inside a piece are kept.
 */
export function splitSpeechChunks(text: string, maxChars: number): string[] {
  const limit = Math.max(1, Math.floor(maxChars))
  const pieces: string[] = []
  for (const paragraph of text.split(/\n{2,}/)) {
    const sentences = splitSentences(paragraph.trim())
    if (sentences.length === 0) continue
    for (let sentence of sentences) {
      while (sentence.length > limit) {
        const at = cutAt(sentence, limit, limit)
        pieces.push(sentence.slice(0, at).trim())
        sentence = sentence.slice(at).trim()
      }
      if (sentence) pieces.push(sentence)
    }
    pieces.push('\n\n')
  }
  pieces.pop()

  const chunks: string[] = []
  let current = ''
  for (const piece of pieces) {
    if (piece === '\n\n') {
      if (current) current += '\n\n'
      continue
    }
    const joined = current ? (current.endsWith('\n\n') ? current + piece : `${current} ${piece}`) : piece
    if (joined.length <= limit) {
      current = joined
      continue
    }
    if (current.trim()) chunks.push(current.trim())
    current = piece
  }
  if (current.trim()) chunks.push(current.trim())
  return chunks
}

// ---------------------------------------------------------------------------------------------
// Local segments
// ---------------------------------------------------------------------------------------------

/** Where a segment sits in its sentences: it may start or end partway through one. */
export interface SentenceCut {
  /** The segment continues a sentence the previous segment started. */
  startsMidSentence: boolean
  /** The sentence goes on in the next segment. */
  endsMidSentence: boolean
}

export interface SpeechSegment extends SentenceCut {
  text: string
}

/** The first local segment packs whole sentences up to this, so audio starts within about two seconds. */
export const FIRST_SEGMENT_CHARS = 40
/**
 * A first sentence longer than `FIRST_SEGMENT_CHARS` is cut at a clause near that length, or
 * kept whole when it has no clause break and fits in this.
 */
export const FIRST_SENTENCE_CHARS = 66
/** A shorter first segment still sizes the next ones as if it were this long. */
const MIN_FIRST_SEGMENT_CHARS = 30
/** Later segments grow from this size to the largest one. */
const SEGMENT_CHARS = 100
export const MAX_SEGMENT_CHARS = 220
const SEGMENT_GROWTH = 1.25
const RAMP_GROWTH = 1.5

interface Sentence {
  text: string
  startsMidSentence: boolean
}

/** Ends a cut-off part with a comma unless it has punctuation, so the voice keeps the sentence going. */
const keepGoing = (text: string): string => (/[.!?…,;:—–-]["'’”)\]]*$/.test(text) ? text : `${text},`)

/**
 * Cuts text into the segments a local model voices one at a time, each spoken in one pass. A
 * paragraph's last sentence ends with punctuation, so paragraph breaks become sentence ends.
 *
 * Whole sentences stay together whenever they fit. The first segment takes whole sentences up to
 * `FIRST_SEGMENT_CHARS`; a longer first sentence, or a short opener such as "Sure." followed by a
 * long one, is cut at the clause nearest that length within `FIRST_SENTENCE_CHARS`, else kept
 * whole when it fits there, else cut between words near that length. Each later segment k may be `min(MAX_SEGMENT_CHARS, 100 × 1.25^k,
 * L0 × 1.5^k)` long, where L0 is the first segment's length (at least 30): growing by 1.5× at most
 * keeps synthesis ahead of playback from the first clip on. Only a sentence longer than its
 * segment is cut, at a clause when it has one, else between words; a cut part ends with a comma,
 * never a period, and says so in `endsMidSentence`.
 */
export function splitSpeechSegments(text: string): SpeechSegment[] {
  const sentences: Sentence[] = []
  for (const paragraph of text.split(/\n{2,}/)) {
    const inParagraph = splitSentences(paragraph.replace(/\s+/g, ' ').trim())
    inParagraph.forEach((sentence, index) =>
      sentences.push({ text: index === inParagraph.length - 1 ? endWithPunctuation(sentence) : sentence, startsMidSentence: false })
    )
  }

  const segments: SpeechSegment[] = []
  let first = MIN_FIRST_SEGMENT_CHARS
  const limit = (index: number): number =>
    Math.floor(Math.min(MAX_SEGMENT_CHARS, SEGMENT_CHARS * SEGMENT_GROWTH ** index, first * RAMP_GROWTH ** index))
  let next = 0
  while (next < sentences.length) {
    const index = segments.length
    const pack = index === 0 ? FIRST_SEGMENT_CHARS : limit(index)
    const startsMidSentence = sentences[next].startsMidSentence
    let body = ''
    const joined = (part: string): string => (body ? `${body} ${part}` : part)
    while (next < sentences.length && joined(sentences[next].text).length <= pack) body = joined(sentences[next++].text)

    let endsMidSentence = false
    const sentence = sentences[next]
    // Takes the part of the sentence before `at`; the rest starts the next segment.
    // A dash at the cut is dropped; the comma that ends the part takes its place.
    const take = (at: number): void => {
      body = joined(keepGoing(sentence.text.slice(0, at).trim().replace(/\s*[-–—]$/, '')))
      sentences[next] = { text: sentence.text.slice(at).trim(), startsMidSentence: true }
      endsMidSentence = true
    }
    if (sentence && index === 0 && body.length < FIRST_SEGMENT_CHARS / 2) {
      // An opener alone would make a tiny first clip that the next one cannot keep up with, so it
      // takes the next sentence along, or the start of it.
      const offset = body ? body.length + 1 : 0
      const room = FIRST_SENTENCE_CHARS - offset - 1
      const clause = clauseCut(sentence.text, room, FIRST_SEGMENT_CHARS - offset)
      if (clause !== null) take(clause)
      else if (offset + sentence.text.length <= FIRST_SENTENCE_CHARS) body = joined(sentences[next++].text)
      else take(cutAt(sentence.text, room, FIRST_SEGMENT_CHARS - offset))
    } else if (sentence && !body) {
      // One character is kept free for the comma that ends the cut part.
      take(cutAt(sentence.text, pack - 1, pack - 1))
    }
    segments.push({ text: body, startsMidSentence, endsMidSentence })
    if (index === 0) first = Math.max(body.length, MIN_FIRST_SEGMENT_CHARS)
  }
  return segments
}
