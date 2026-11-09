import { phonemize } from 'phonemizer'
import type { KokoroTtsModel } from '../../shared/readAloud'

/**
 * Kokoro's text front end: a segment of text to the token ids and style vector the model takes,
 * which the native voice engine then voices. Ported from kokoro-js 1.2.1 (Apache-2.0, by hexgrad
 * and Xenova): its text normalisation, espeak-ng phonemes through `phonemizer` with the
 * punctuation kept, and its fixes to those phonemes. The tokenizer reads the model's
 * `tokenizer.json` the way transformers.js does for this model. The results equal kokoro-js's
 * (tests/readAloudKokoroText.test.ts).
 */

/** The model's input for one segment. */
export interface KokoroInputs {
  inputIds: number[]
  /** The voice's style for this many tokens, 256 values. */
  style: Float32Array
}

export type PhonemizeText = (text: string, language: string) => Promise<string[]>

export const STYLE_LENGTH = 256
/** Rows in a voice file: one style per token count. */
const VOICE_ROWS = 510

/** Times, years, and decimals as kokoro-js reads them. */
function splitNumber(match: string): string {
  if (match.includes('.')) return match
  if (match.includes(':')) {
    const [hours, minutes] = match.split(':').map(Number)
    if (minutes === 0) return `${hours} o'clock`
    return minutes < 10 ? `${hours} oh ${minutes}` : `${hours} ${minutes}`
  }
  const year = parseInt(match.slice(0, 4), 10)
  if (year < 1100 || year % 1000 < 10) return match
  const left = match.slice(0, 2)
  const right = parseInt(match.slice(2, 4), 10)
  const suffix = match.endsWith('s') ? 's' : ''
  if (year % 1000 >= 100 && year % 1000 <= 999) {
    if (right === 0) return `${left} hundred${suffix}`
    if (right < 10) return `${left} oh ${right}${suffix}`
  }
  return `${left} ${right}${suffix}`
}

function flipMoney(match: string): string {
  const bill = match[0] === '$' ? 'dollar' : 'pound'
  if (isNaN(Number(match.slice(1)))) return `${match.slice(1)} ${bill}s`
  if (!match.includes('.')) {
    const plural = match.slice(1) === '1' ? '' : 's'
    return `${match.slice(1)} ${bill}${plural}`
  }
  const [whole, fraction] = match.slice(1).split('.')
  const cents = parseInt(fraction.padEnd(2, '0'), 10)
  const coins = match[0] === '$' ? (cents === 1 ? 'cent' : 'cents') : cents === 1 ? 'penny' : 'pence'
  return `${whole} ${bill}${whole === '1' ? '' : 's'} and ${cents} ${coins}`
}

function pointNumber(match: string): string {
  const [whole, fraction] = match.split('.')
  return `${whole} point ${fraction.split('').join(' ')}`
}

/** kokoro-js's text normalisation, before phonemes. */
export function normalizeKokoroText(text: string): string {
  return (
    text
      .replace(/[‘’]/g, "'")
      .replace(/«/g, '“')
      .replace(/»/g, '”')
      .replace(/[“”]/g, '"')
      .replace(/\(/g, '«')
      .replace(/\)/g, '»')
      .replace(/、/g, ', ')
      .replace(/。/g, '. ')
      .replace(/！/g, '! ')
      .replace(/，/g, ', ')
      .replace(/：/g, ': ')
      .replace(/；/g, '; ')
      .replace(/？/g, '? ')
      .replace(/[^\S \n]/g, ' ')
      // Only the first run, as in kokoro-js.
      .replace(/  +/, ' ')
      .replace(/(?<=\n) +(?=\n)/g, '')
      .replace(/\bD[Rr]\.(?= [A-Z])/g, 'Doctor')
      .replace(/\b(?:Mr\.|MR\.(?= [A-Z]))/g, 'Mister')
      .replace(/\b(?:Ms\.|MS\.(?= [A-Z]))/g, 'Miss')
      .replace(/\b(?:Mrs\.|MRS\.(?= [A-Z]))/g, 'Mrs')
      .replace(/\betc\.(?! [A-Z])/gi, 'etc')
      .replace(/\b(y)eah?\b/gi, "$1e'a")
      .replace(/\d*\.\d+|\b\d{4}s?\b|(?<!:)\b(?:[1-9]|1[0-2]):[0-5]\d\b(?!:)/g, splitNumber)
      .replace(/(?<=\d),(?=\d)/g, '')
      .replace(/[$£]\d+(?:\.\d+)?(?: hundred| thousand| (?:[bm]|tr)illion)*\b|[$£]\d+\.\d\d?\b/gi, flipMoney)
      .replace(/\d*\.\d+/g, pointNumber)
      .replace(/(?<=\d)-(?=\d)/g, ' to ')
      .replace(/(?<=\d)S/g, ' S')
      .replace(/(?<=[BCDFGHJ-NP-TV-Z])'?s\b/g, "'S")
      .replace(/(?<=X')S\b/g, 's')
      .replace(/(?:[A-Za-z]\.){2,} [a-z]/g, (match) => match.replace(/\./g, '-'))
      .replace(/(?<=[A-Z])\.(?=[A-Z])/gi, '-')
      .trim()
  )
}

const PUNCTUATION = ';:,.!?¡¿—…"«»“”(){}[]'
const PUNCTUATION_RUN = new RegExp(`(\\s*[${PUNCTUATION.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}]+\\s*)+`, 'g')

/**
 * Phonemes for `text` in Kokoro's spelling. `language` is the first letter of the voice: `a`
 * American English, `b` British English.
 */
export async function kokoroPhonemes(text: string, language: string, speak: PhonemizeText = phonemize): Promise<string> {
  const normalized = normalizeKokoroText(text)
  // Punctuation is kept as it is; only the text between it is phonemized.
  const parts: Array<{ punctuation: boolean; text: string }> = []
  let from = 0
  for (const match of normalized.matchAll(PUNCTUATION_RUN)) {
    if (from < match.index) parts.push({ punctuation: false, text: normalized.slice(from, match.index) })
    if (match[0].length > 0) parts.push({ punctuation: true, text: match[0] })
    from = match.index + match[0].length
  }
  if (from < normalized.length) parts.push({ punctuation: false, text: normalized.slice(from) })
  const voice = language === 'a' ? 'en-us' : 'en'
  const spoken = await Promise.all(parts.map(async (part) => (part.punctuation ? part.text : (await speak(part.text, voice)).join(' '))))
  let phonemes = spoken
    .join('')
    .replace(/kəkˈoːɹoʊ/g, 'kˈoʊkəɹoʊ')
    .replace(/kəkˈɔːɹəʊ/g, 'kˈəʊkəɹəʊ')
    .replace(/ʲ/g, 'j')
    .replace(/r/g, 'ɹ')
    .replace(/x/g, 'k')
    .replace(/ɬ/g, 'l')
    .replace(/(?<=[a-zɹː])(?=hˈʌndɹɪd)/g, ' ')
    .replace(/ z(?=[;:,.!?¡¿—…"«»“” ]|$)/g, 'z')
  if (language === 'a') phonemes = phonemes.replace(/(?<=nˈaɪn)ti(?!ː)/g, 'di')
  return phonemes.trim()
}

interface TokenizerJson {
  normalizer?: { type?: string; pattern?: { Regex?: string }; content?: string }
  pre_tokenizer?: { type?: string; pattern?: { Regex?: string }; behavior?: string; invert?: boolean }
  post_processor?: { type?: string; special_tokens?: Record<string, { ids?: number[] }> }
  model?: { vocab?: Record<string, number> }
}

/** Longest input, the two boundary tokens included (`model_max_length` in `tokenizer_config.json`). */
export const MAX_TOKENS = 512

/**
 * Kokoro's tokenizer: characters the vocabulary does not have are dropped, every remaining
 * character is a token, and the boundary token `$` goes at both ends. Like kokoro-js, a longer
 * input is cut to `MAX_TOKENS`, dropping the closing `$`.
 */
export class KokoroTokenizer {
  private constructor(
    private readonly vocab: ReadonlyMap<string, number>,
    private readonly unsupported: RegExp,
    private readonly boundary: number
  ) {}

  /** Throws when the file is not shaped like Kokoro's. */
  static fromJson(json: unknown): KokoroTokenizer {
    const config = json as TokenizerJson
    const vocab = config.model?.vocab
    const pattern = config.normalizer?.pattern?.Regex
    const boundary = config.post_processor?.special_tokens?.$?.ids?.[0]
    const splitsCharacters =
      config.pre_tokenizer?.type === 'Split' && config.pre_tokenizer.pattern?.Regex === '' && config.pre_tokenizer.invert === false
    if (
      !vocab ||
      typeof vocab !== 'object' ||
      config.normalizer?.type !== 'Replace' ||
      typeof pattern !== 'string' ||
      config.normalizer.content !== '' ||
      !splitsCharacters ||
      config.post_processor?.type !== 'TemplateProcessing' ||
      typeof boundary !== 'number'
    ) {
      throw new Error('The voice model has a tokenizer this app does not know')
    }
    return new KokoroTokenizer(new Map(Object.entries(vocab)), new RegExp(pattern, 'gu'), boundary)
  }

  encode(phonemes: string): number[] {
    const ids = [this.boundary]
    for (const character of phonemes.replace(this.unsupported, '')) ids.push(this.vocab.get(character) ?? this.boundary)
    ids.push(this.boundary)
    return ids.slice(0, MAX_TOKENS)
  }
}

/** The style for `tokens` input ids: the voice file's row for that many phonemes. */
export function kokoroStyle(voice: Float32Array, tokens: number): Float32Array {
  const row = Math.min(Math.max(tokens - 2, 0), VOICE_ROWS - 1)
  const style = voice.slice(row * STYLE_LENGTH, (row + 1) * STYLE_LENGTH)
  if (style.length !== STYLE_LENGTH) throw new Error('The voice file is damaged. Download the model again.')
  return style
}

/** A file of the downloaded model; may fetch an optional voice first. */
export type ReadModelFile = (path: string) => Promise<Uint8Array>

/** Voices kept in memory; a read uses one voice, and each is about half a megabyte. */
const CACHED_VOICES = 2

/**
 * Turns segments into model inputs for one downloaded Kokoro model. Its tokenizer and the voices
 * last used are kept in memory.
 */
export class KokoroFrontEnd {
  private tokenizer: Promise<KokoroTokenizer> | null = null
  private readonly voices = new Map<string, Promise<Float32Array>>()

  constructor(
    private readonly model: KokoroTtsModel,
    private readonly readFile: ReadModelFile,
    private readonly speak: PhonemizeText = phonemize
  ) {}

  /** `voice` falls back to the model's default when the model has no voice of that name. */
  async prepare(text: string, voice: string): Promise<KokoroInputs> {
    const known = this.model.voices.some((entry) => entry.id === voice) ? voice : this.model.defaultVoice
    const [tokenizer, voiceData, phonemes] = await Promise.all([
      this.loadTokenizer(),
      this.loadVoice(known),
      kokoroPhonemes(text, known[0], this.speak)
    ])
    const inputIds = tokenizer.encode(phonemes)
    return { inputIds, style: kokoroStyle(voiceData, inputIds.length) }
  }

  private loadTokenizer(): Promise<KokoroTokenizer> {
    if (this.tokenizer) return this.tokenizer
    const loading = this.readFile('tokenizer.json').then((bytes) => KokoroTokenizer.fromJson(JSON.parse(new TextDecoder().decode(bytes))))
    // A failed read is tried again next time.
    loading.catch(() => {
      if (this.tokenizer === loading) this.tokenizer = null
    })
    this.tokenizer = loading
    return loading
  }

  private loadVoice(voice: string): Promise<Float32Array> {
    const cached = this.voices.get(voice)
    if (cached) {
      this.voices.delete(voice)
      this.voices.set(voice, cached)
      return cached
    }
    const loading = this.readFile(`voices/${voice}.bin`).then((bytes) => {
      if (bytes.byteLength % 4 !== 0) throw new Error('The voice file is damaged. Download the model again.')
      return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer)
    })
    loading.catch(() => {
      if (this.voices.get(voice) === loading) this.voices.delete(voice)
    })
    this.voices.set(voice, loading)
    while (this.voices.size > CACHED_VOICES) this.voices.delete(this.voices.keys().next().value!)
    return loading
  }
}
