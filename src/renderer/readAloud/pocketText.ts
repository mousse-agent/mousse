/**
 * Text handling for Pocket TTS, following kyutai-labs/pocket-tts at commit 3dbee45 (the 3.3.0
 * release, MIT): `Tokenizer` (a SentencePiece unigram model in Hugging Face `tokenizer.json`
 * form), `prepare_text_prompt` and `split_into_best_sentences` in `models/text_chunking.py`.
 */

export interface PocketTextOptions {
  removeSemicolons: boolean
  appendTerminalPunctuation: boolean
  capitalizeFirstLetter: boolean
  padWithSpacesForShortInputs: boolean
  replaceCharacters: Record<string, string>
  /** Most tokens the model reads in one chunk. */
  maxTokensPerChunk: number
}

// ---------------------------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------------------------

const SPACE_MARK = '▁'

interface NormalizerJson {
  type?: string
  prepend?: string
  normalizers?: NormalizerJson[]
}

interface UnigramJson {
  normalizer?: NormalizerJson
  model: { type: string; unk_id: number; vocab: Array<[string, number]>; byte_fallback?: boolean }
}

/**
 * The unigram tokenizer of `tokenizer.json`: a prepended space mark, spaces turned into marks that
 * start each word, then the best-scoring split of every word into vocabulary pieces. A character
 * the vocabulary lacks becomes its UTF-8 bytes (`<0xNN>` pieces) when the model has byte fallback.
 */
export class UnigramTokenizer {
  private readonly ids = new Map<string, number>()
  private readonly scores = new Map<string, number>()
  private readonly pieces: string[]
  private readonly unk: number
  private readonly byteFallback: boolean
  private readonly unkScore: number
  private readonly longest: number

  constructor(json: string) {
    const raw = JSON.parse(json) as UnigramJson
    if (raw.model?.type !== 'Unigram') throw new Error('Pocket TTS needs a unigram tokenizer')
    // One `Prepend` of the space mark, alone or as the only step of a `Sequence`.
    const steps = raw.normalizer?.type === 'Sequence' ? raw.normalizer.normalizers : raw.normalizer ? [raw.normalizer] : []
    if (steps?.length !== 1 || steps[0].type !== 'Prepend' || steps[0].prepend !== SPACE_MARK) throw new Error('Unsupported tokenizer normalizer')
    this.pieces = raw.model.vocab.map(([piece]) => piece)
    let lowest = Infinity
    let longest = 1
    raw.model.vocab.forEach(([piece, score], id) => {
      this.ids.set(piece, id)
      this.scores.set(piece, score)
      if (id !== raw.model.unk_id) lowest = Math.min(lowest, score)
      longest = Math.max(longest, Array.from(piece).length)
    })
    this.unk = raw.model.unk_id
    this.byteFallback = raw.model.byte_fallback === true
    // Like Hugging Face tokenizers, an unknown character scores well below every real piece.
    this.unkScore = lowest - 10
    this.longest = longest
  }

  /** Token ids for `text`. */
  encode(text: string): number[] {
    const marked = (SPACE_MARK + text).replaceAll(' ', SPACE_MARK)
    const out: number[] = []
    for (const word of marked.split(new RegExp(`(?=${SPACE_MARK})`, 'u'))) {
      if (word) out.push(...this.encodeWord(Array.from(word)))
    }
    return out
  }

  private encodeWord(chars: string[]): number[] {
    const n = chars.length
    const best = new Array<number>(n + 1).fill(-Infinity)
    const from = new Array<number>(n + 1).fill(0)
    best[0] = 0
    for (let end = 1; end <= n; end += 1) {
      for (let start = Math.max(0, end - this.longest); start < end; start += 1) {
        const score = this.scores.get(chars.slice(start, end).join(''))
        if (score !== undefined && best[start] + score > best[end]) {
          best[end] = best[start] + score
          from[end] = start
        }
      }
      if (best[end - 1] + this.unkScore > best[end]) {
        best[end] = best[end - 1] + this.unkScore
        from[end] = end - 1
      }
    }
    const ids: number[] = []
    for (let end = n; end > 0; end = from[end]) {
      const piece = chars.slice(from[end], end).join('')
      const id = this.ids.get(piece)
      if (id !== undefined && !(end - from[end] === 1 && id === this.unk)) {
        ids.push(id)
        continue
      }
      // A piece that is not in the vocabulary is a single unknown character.
      const bytes = this.byteFallback ? Array.from(new TextEncoder().encode(piece), (byte) => this.ids.get(`<0x${byte.toString(16).toUpperCase().padStart(2, '0')}>`)) : []
      if (bytes.length > 0 && bytes.every((byte) => byte !== undefined)) ids.push(...(bytes as number[]).reverse())
      else ids.push(this.unk)
    }
    return ids.reverse()
  }

  /** Text for `ids`, with the leading space mark dropped. */
  decode(ids: readonly number[]): string {
    const bytes: number[] = []
    let text = ''
    const flush = (): void => {
      if (bytes.length > 0) text += new TextDecoder().decode(Uint8Array.from(bytes))
      bytes.length = 0
    }
    for (const id of ids) {
      const piece = this.pieces[id] ?? ''
      const match = /^<0x([0-9A-F]{2})>$/.exec(piece)
      if (match) {
        bytes.push(parseInt(match[1], 16))
      } else {
        flush()
        text += piece
      }
    }
    flush()
    return text.replaceAll(SPACE_MARK, ' ').replace(/^ /, '')
  }
}

// ---------------------------------------------------------------------------------------------
// Prompt preparation and chunking
// ---------------------------------------------------------------------------------------------

const TERMINAL_PUNCTUATION = '.!?…'
const WEAK_PUNCTUATION = ',;:-–—'
const CLOSERS = '"\'”’)]»'

function stripEnd(text: string, characters: string): string {
  let end = text.length
  while (end > 0 && characters.includes(text[end - 1])) end -= 1
  return text.slice(0, end)
}

/** Makes the prompt end with sentence punctuation, which the model needs to finish the last word cleanly. */
function ensureTerminalPunctuation(text: string): string {
  const core = stripEnd(text, `${CLOSERS} `)
  const closers = text.slice(core.length).trim()
  if (!core || TERMINAL_PUNCTUATION.includes(core[core.length - 1])) return text
  if (WEAK_PUNCTUATION.includes(core[core.length - 1])) return `${stripEnd(core, `${WEAK_PUNCTUATION} `)}.${closers}`
  return `${text}.`
}

const isUpper = (character: string): boolean => character !== character.toLowerCase() && character === character.toUpperCase()

/** The text as the model should read it, and how many frames to keep generating after it signals the end. */
export function preparePocketText(input: string, options: PocketTextOptions): { text: string; framesAfterEos: number } {
  let text = input.trim()
  const replacements = Object.entries(options.replaceCharacters)
  if (replacements.length > 0) {
    for (const [from, to] of replacements) text = text.replaceAll(from, to)
    text = text.split(/\s+/).filter(Boolean).join(' ')
    text = text.replace(/([.!?…])\s*[,;:]/g, '$1')
  }
  if (text === '') throw new Error('Text prompt cannot be empty')
  text = text.replaceAll('\n', ' ').replaceAll('\r', ' ').replaceAll('  ', ' ')
  if (options.removeSemicolons) text = text.replaceAll(';', ',')
  const words = text.split(/\s+/).filter(Boolean).length
  const framesAfterEos = words <= 4 ? 3 : 1
  if (options.capitalizeFirstLetter && !isUpper(text[0])) text = text[0].toUpperCase() + text.slice(1)
  if (options.appendTerminalPunctuation) text = ensureTerminalPunctuation(text)
  if (options.padWithSpacesForShortInputs && words < 5) text = ' '.repeat(8) + text
  return { text, framesAfterEos }
}

/** Segment boundaries: indices where a run of boundary tokens ends and a new segment starts. */
function boundaryIndices(
  tokens: readonly number[],
  boundaries: ReadonlySet<number>,
  skipDecimalPeriods: (index: number) => boolean = () => false
): number[] {
  const indices = [0]
  let previousWasBoundary = false
  tokens.forEach((token, index) => {
    if (boundaries.has(token)) {
      previousWasBoundary = true
      return
    }
    if (previousWasBoundary && !skipDecimalPeriods(index)) indices.push(index)
    previousWasBoundary = false
  })
  indices.push(tokens.length)
  return indices
}

function segmentsFrom(tokens: readonly number[], indices: readonly number[], tokenizer: UnigramTokenizer): Array<{ tokens: number; text: string }> {
  const segments: Array<{ tokens: number; text: string }> = []
  for (let i = 0; i + 1 < indices.length; i += 1) {
    segments.push({ tokens: indices[i + 1] - indices[i], text: tokenizer.decode(tokens.slice(indices[i], indices[i + 1])) })
  }
  return segments
}

/**
 * Splits text into chunks of at most `maxTokensPerChunk` tokens at sentence ends, then at commas,
 * semicolons and colons inside sentences that are too long, and regroups short sentences.
 */
export function splitPocketChunks(input: string, tokenizer: UnigramTokenizer, options: PocketTextOptions): Array<{ text: string; framesAfterEos: number }> {
  const prepared = preparePocketText(input, options).text.trim()
  const tokens = tokenizer.encode(prepared)
  const [, ...sentenceEnds] = tokenizer.encode('.!...?')
  const isDecimalPeriod = (index: number): boolean => {
    const prefix = tokenizer.decode(tokens.slice(0, index))
    const suffix = tokenizer.decode(tokens.slice(index))
    return prefix.length >= 2 && prefix.endsWith('.') && /\d/.test(prefix[prefix.length - 2]) && suffix.length > 0 && /\d/.test(suffix[0])
  }
  const sentences = segmentsFrom(tokens, boundaryIndices(tokens, new Set(sentenceEnds), isDecimalPeriod), tokenizer)

  const [, ...weakEnds] = tokenizer.encode(',;:')
  const refined: Array<{ tokens: number; text: string }> = []
  for (const sentence of sentences) {
    if (sentence.tokens <= options.maxTokensPerChunk) {
      refined.push(sentence)
      continue
    }
    const subTokens = tokenizer.encode(sentence.text.trim())
    const parts = segmentsFrom(subTokens, boundaryIndices(subTokens, new Set(weakEnds)), tokenizer)
    if (parts.length > 1) refined.push(...parts)
    else refined.push(sentence)
  }

  const chunks: string[] = []
  let current = ''
  let currentTokens = 0
  for (const { tokens: count, text } of refined) {
    if (current === '') {
      current = text
      currentTokens = count
    } else if (currentTokens + count > options.maxTokensPerChunk) {
      chunks.push(current.trim())
      current = text
      currentTokens = count
    } else {
      current += ` ${text}`
      currentTokens += count
    }
  }
  if (current !== '') chunks.push(current.trim())

  // Each chunk is prepared again, as the model's own loop does, and waits two frames longer after the end signal.
  return chunks.map((chunk) => {
    const { text, framesAfterEos } = preparePocketText(chunk, options)
    return { text, framesAfterEos: framesAfterEos + 2 }
  })
}
