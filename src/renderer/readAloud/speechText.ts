export const CODE_BLOCK_PLACEHOLDER = 'Code block omitted.'

const FENCE = /^\s{0,3}(`{3,}|~{3,})/
const HORIZONTAL_RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/
const TABLE_DIVIDER = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

function endWithPunctuation(line: string): string {
  return /[.!?:;,]["')\]]*$/.test(line) ? line : `${line}.`
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

/** Splits text into pieces of at most `maxChars`, preferring paragraph, then sentence, then word boundaries. */
export function splitSpeechChunks(text: string, maxChars: number): string[] {
  const limit = Math.max(1, Math.floor(maxChars))
  const pieces: string[] = []
  for (const paragraph of text.split(/\n{2,}/)) {
    const trimmed = paragraph.trim()
    if (!trimmed) continue
    const sentences = trimmed.match(/[^.!?]+(?:[.!?]+["')\]]*|$)\s*/g) ?? [trimmed]
    for (const sentence of sentences) pieces.push(...splitLongPiece(sentence.trim(), limit))
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
