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

/**
 * Splits text into pieces of at most `maxChars`, preferring paragraph, then sentence, then word
 * boundaries. `maxChars` may be a function of the piece's index, so pieces can grow. Sentences
 * longer than `splitAt` are cut at words first; by default that is the smaller of the first two
 * limits.
 */
export function splitSpeechChunks(text: string, maxChars: number | ((index: number) => number), splitAt?: number): string[] {
  const limitAt = (index: number): number => Math.max(1, Math.floor(typeof maxChars === 'number' ? maxChars : maxChars(index)))
  const smallest = splitAt ?? (typeof maxChars === 'number' ? limitAt(0) : Math.min(limitAt(0), limitAt(1)))
  const pieces: string[] = []
  for (const paragraph of text.split(/\n{2,}/)) {
    const trimmed = paragraph.trim()
    if (!trimmed) continue
    const sentences = trimmed.match(/[^.!?]+(?:[.!?]+["')\]]*|$)\s*/g) ?? [trimmed]
    for (const sentence of sentences) pieces.push(...splitLongPiece(sentence.trim(), smallest))
    pieces.push('\n\n')
  }
  pieces.pop()

  const chunks: string[] = []
  let current = ''
  for (const piece of pieces) {
    if (!piece.trim()) {
      if (current) current += '\n\n'
      continue
    }
    const joined = current ? (current.endsWith('\n\n') ? current + piece : `${current} ${piece}`) : piece
    if (joined.length <= limitAt(chunks.length)) {
      current = joined
      continue
    }
    if (current.trim()) chunks.push(current.trim())
    current = piece
  }
  if (current.trim()) chunks.push(current.trim())
  return chunks
}

/** The first local segment is short so audio starts within about two seconds. */
export const FIRST_SEGMENT_CHARS = 40
/** A shorter first segment still sizes the next ones as if it were this long. */
const MIN_FIRST_SEGMENT_CHARS = 30
/** Later segments grow from this size to the largest one; it is also where sentences are cut at words. */
const SEGMENT_CHARS = 100
export const MAX_SEGMENT_CHARS = 220
const SEGMENT_GROWTH = 1.25
const RAMP_GROWTH = 1.5
/** A cut at a comma or similar leaves at least this much of the sentence on each side. */
const MIN_CLAUSE_CHARS = 20

/** Offsets in `text` where a sentence or a paragraph ends. */
function sentenceEnds(text: string): number[] {
  const ends: number[] = []
  for (const match of text.matchAll(/[.!?]+["')\]]*(?=\s|$)|\n{2,}/g)) {
    ends.push(match[0].startsWith('\n') ? match.index : match.index + match[0].length)
  }
  if (ends.at(-1) !== text.length) ends.push(text.length)
  return ends
}

/**
 * Splits off the start of `text`, at most `max` characters, and returns it with the rest. Whole
 * sentences are taken while they fit (a paragraph break ends a sentence). When the next one does
 * not fit and what was taken is shorter than `max / 2`, such as a "Sure." opener, that sentence is
 * taken too and cut: at the last comma, semicolon, colon or dash that leaves at least 20 characters
 * on each side, else at the last space before `max`. The rest of that sentence starts the rest.
 */
export function takeLeading(text: string, max: number): [head: string, rest: string] {
  const trimmed = text.trim()
  if (trimmed.length <= max) return [trimmed, '']
  const split = (at: number): [string, string] => [trimmed.slice(0, at).trim(), trimmed.slice(at).trim()]
  let fit = 0
  let next = trimmed.length
  for (const end of sentenceEnds(trimmed)) {
    if (trimmed.slice(0, end).trimEnd().length > max) {
      next = end
      break
    }
    fit = end
  }
  if (fit > 0 && trimmed.slice(0, fit).trim().length >= max / 2) return split(fit)

  let clause = -1
  // One character past `max`, so a comma that ends exactly at `max` still sees the space after it.
  for (const match of trimmed.slice(fit, max + 1).matchAll(/[,;:](?=\s)|—/g)) {
    const at = fit + match.index + match[0].length
    if (at > max || trimmed.slice(0, at).trim().length < MIN_CLAUSE_CHARS) continue
    if (trimmed.slice(at, next).trim().length < MIN_CLAUSE_CHARS) continue
    clause = at
  }
  if (clause > 0) return split(clause)
  // A cut between words ends with a comma, so the voice keeps the sentence going instead of
  // closing it; one character is kept free for it.
  for (let at = max - 1; at > fit; at--) {
    if (/\s/.test(trimmed[at])) {
      const [head, rest] = split(at)
      return [/[.!?:;,—]["')\]]*$/.test(head) ? head : `${head},`, rest]
    }
  }
  return split(fit > 0 ? fit : max - 1)
}

/**
 * Cuts text into the segments a local model voices one at a time. Each segment is spoken in one
 * pass, so paragraph breaks inside it become sentence ends instead of newlines.
 *
 * The first segment is at most `FIRST_SEGMENT_CHARS`, so the first audio is ready soon. Each later
 * segment k may be `min(MAX_SEGMENT_CHARS, 100 × 1.25^k, L0 × 1.5^k)` long, where L0 is the first
 * segment's length (at least 30): growing by 1.5× at most keeps synthesis ahead of playback from the
 * first clip on. Segments whose limit is under 100 are cut with `takeLeading` too; from the first
 * limit of 100 on, the rest is split as before, cutting sentences over 100 characters at words.
 */
export function splitSpeechSegments(text: string): string[] {
  const segments: string[] = []
  let [head, rest] = takeLeading(text, FIRST_SEGMENT_CHARS)
  if (head) segments.push(head)
  const first = Math.max(head.length, MIN_FIRST_SEGMENT_CHARS)
  const limit = (index: number): number =>
    Math.min(MAX_SEGMENT_CHARS, SEGMENT_CHARS * SEGMENT_GROWTH ** index, first * RAMP_GROWTH ** index)
  let index = 1
  while (rest && limit(index) < SEGMENT_CHARS) {
    ;[head, rest] = takeLeading(rest, Math.floor(limit(index)))
    segments.push(head)
    index++
  }
  const start = index
  if (rest) segments.push(...splitSpeechChunks(rest, (offset) => limit(start + offset), SEGMENT_CHARS))
  return segments.map((segment) =>
    segment
      .split(/\n{2,}/)
      .map((paragraph) => endWithPunctuation(paragraph.trim()))
      .join(' ')
  )
}

function splitLongPiece(piece: string, limit: number): string[] {
  if (piece.length <= limit) return piece ? [piece] : []
  const out: string[] = []
  let rest = piece
  while (rest.length > limit) {
    let cut = rest.lastIndexOf(' ', limit)
    if (cut <= 0) cut = limit
    out.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut).trim()
  }
  if (rest) out.push(rest)
  return out.filter(Boolean)
}
