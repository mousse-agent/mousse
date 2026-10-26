import type * as Ort from 'onnxruntime-web'
import { phonemizeKeepingPunctuation, type PhonemizeText } from './espeakPhonemes'
import { CLIP_GAP_SECONDS, trimSilence } from './localPlayback'
import { parseNpz, type NpyArray } from './npz'
import { spokenEnglish } from './spokenEnglish'

/**
 * KittenTTS 0.8 inference, following KittenML/KittenTTS (`kittentts/onnx_model.py`, tag 0.8.1):
 * the text is split into sentences, each is phonemized with espeak (`en-us`, stress marks,
 * punctuation kept), mapped to token ids by symbol position, and run through the ONNX graph with
 * a style row picked by the sentence's length. Numbers and symbols are first written as words
 * (`spokenEnglish`), as upstream's `clean_text` option does, because espeak mis-reads a number
 * once its punctuation is split off (`3.5`, `1,200`).
 */

export const KITTEN_SAMPLE_RATE = 24000
/** Longest sentence sent to the model in one pass, in characters. */
const MAX_CHUNK_CHARS = 400
/** The model's output ends with this much trailing noise, which upstream cuts off. */
const TRAILING_SAMPLES = 5000
/** Token ids of the model's symbol table are positions in `pad + punctuation + letters + IPA`. */
const PAD = '$'
const PUNCTUATION = ';:,.!?¡¿—…"«»""' + ' '
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
const LETTERS_IPA =
  'ɑɐɒæɓʙβɔɕçɗɖðʤəɘɚɛɜɝɞɟʄɡɠɢʛɦɧħɥʜɨɪʝɭɬɫɮʟɱɯɰŋɳɲɴøɵɸθœɶʘɹɺɾɻʀʁɽʂʃʈʧʉʊʋⱱʌɣɤʍχʎʏʑʐʒʔʡʕʢǀǁǂǃˈˌːˑʼʴʰʱʲʷˠˤ˞↓↑→↗↘\'̩\'ᵻ'

/** Symbol to id. A symbol listed twice (the quote mark) keeps its last position, as upstream's dict does. */
const SYMBOL_IDS = new Map<string, number>(Array.from(PAD + PUNCTUATION + LETTERS + LETTERS_IPA).map((symbol, index) => [symbol, index]))
/** Id of the `…` that closes every sequence. */
const END_ID = 10

export interface KittenConfig {
  /** Friendly voice name to the voice's name in `voices.npz`, e.g. `Bella` to `expr-voice-2-f`. */
  voiceAliases: Record<string, string>
  /** Speed multiplier applied to a voice (by its `voices.npz` name). */
  speedPriors: Record<string, number>
}

function numberRecord(value: unknown): Record<string, number> {
  const out: Record<string, number> = {}
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) if (typeof item === 'number' && Number.isFinite(item) && item > 0) out[key] = item
  }
  return out
}

export function parseKittenConfig(json: string): KittenConfig {
  const raw = JSON.parse(json) as { voice_aliases?: unknown; speed_priors?: unknown }
  const voiceAliases: Record<string, string> = {}
  if (raw.voice_aliases && typeof raw.voice_aliases === 'object') {
    for (const [name, key] of Object.entries(raw.voice_aliases)) if (typeof key === 'string') voiceAliases[name] = key
  }
  return { voiceAliases, speedPriors: numberRecord(raw.speed_priors) }
}

function withPunctuation(text: string): string {
  const trimmed = text.trim()
  return trimmed && !'.!?,;:'.includes(trimmed[trimmed.length - 1]) ? `${trimmed},` : trimmed
}

/**
 * Splits text into sentences of at most 400 characters, dropping `.`, `!` and `?` and giving each
 * piece a closing comma unless it ends in punctuation (upstream's `chunk_text`). Upstream splits at
 * every `.`, which cuts `4.99` in two; here a mark ends a sentence only before a space or the end
 * of the text.
 */
export function kittenChunks(text: string): string[] {
  const chunks: string[] = []
  for (const part of text.split(/[.!?]+(?=\s|$)/)) {
    const sentence = part.trim()
    if (!sentence) continue
    if (sentence.length <= MAX_CHUNK_CHARS) {
      chunks.push(withPunctuation(sentence))
      continue
    }
    let current = ''
    for (const word of sentence.split(/\s+/)) {
      if (current.length + word.length + 1 <= MAX_CHUNK_CHARS) {
        current = current ? `${current} ${word}` : word
      } else {
        if (current) chunks.push(withPunctuation(current))
        current = word
      }
    }
    if (current) chunks.push(withPunctuation(current))
  }
  return chunks
}

/**
 * Token ids for a phoneme string: words and single punctuation marks are split apart and rejoined
 * with spaces (upstream tokenizes with `\w+|[^\w\s]`), symbols outside the table are dropped, and
 * the sequence is framed by a pad id in front and `…` plus a pad id behind.
 */
export function kittenTokens(phonemes: string): number[] {
  const pieces = phonemes.match(/[\p{L}\p{N}_]+|[^\p{L}\p{N}_\s]/gu) ?? []
  const ids = [0]
  for (const symbol of pieces.join(' ')) {
    const id = SYMBOL_IDS.get(symbol)
    if (id !== undefined) ids.push(id)
  }
  ids.push(END_ID, 0)
  return ids
}

/** The 256 values of the style matrix row for a sentence of `length` characters (the last row at most). */
export function kittenStyle(matrix: NpyArray, length: number): Float32Array {
  const [rows, width] = matrix.shape
  const row = Math.min(length, rows - 1)
  return matrix.data.slice(row * width, (row + 1) * width)
}

export interface KittenSynthesizer {
  /** Voices one piece of text; the audio is mono at `KITTEN_SAMPLE_RATE`. */
  synthesize: (text: string, voice: string, speed: number) => Promise<Float32Array>
}

export interface KittenFiles {
  /** The ONNX graph. */
  model: Uint8Array
  /** `config.json` as text. */
  config: string
  /** `voices.npz`. */
  voices: Uint8Array
}

function concatenate(parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((total, part) => total + part.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

/** Loads the graph and voices. `ort` is onnxruntime-web in the worker; tests may pass the Node build. */
export async function createKittenSynthesizer(
  ort: typeof Ort,
  files: KittenFiles,
  options: { phonemize?: PhonemizeText; executionProviders?: string[] } = {}
): Promise<KittenSynthesizer> {
  const config = parseKittenConfig(files.config)
  const voices = parseNpz(files.voices)
  const session = await ort.InferenceSession.create(files.model, { executionProviders: options.executionProviders ?? ['wasm'] })

  const synthesizeChunk = async (chunk: string, voiceKey: string, speed: number): Promise<Float32Array> => {
    const phonemes = await phonemizeKeepingPunctuation(chunk, 'en-us', options.phonemize)
    const ids = kittenTokens(phonemes)
    const output = await session.run({
      input_ids: new ort.Tensor('int64', BigInt64Array.from(ids, BigInt), [1, ids.length]),
      style: new ort.Tensor('float32', kittenStyle(voices[voiceKey], chunk.length), [1, 256]),
      speed: new ort.Tensor('float32', Float32Array.of(speed * (config.speedPriors[voiceKey] ?? 1)), [1])
    })
    const audio = output[session.outputNames[0]].data as Float32Array
    return audio.slice(0, Math.max(0, audio.length - TRAILING_SAMPLES))
  }

  return {
    synthesize: async (text, voice, speed) => {
      const voiceKey = config.voiceAliases[voice] ?? voice
      if (!voices[voiceKey]) throw new Error(`Kitten TTS has no voice named ${voice}`)
      // Each sentence comes with about 0.4 s of silence before it and 0.3 s after it, which would
      // make 0.7 s pauses inside a segment; sentences are trimmed and joined with a short gap.
      const gap = new Float32Array(Math.round(CLIP_GAP_SECONDS * KITTEN_SAMPLE_RATE))
      const parts: Float32Array[] = []
      for (const chunk of kittenChunks(spokenEnglish(text))) {
        if (parts.length > 0) parts.push(gap)
        parts.push(trimSilence(await synthesizeChunk(chunk, voiceKey, speed), KITTEN_SAMPLE_RATE))
      }
      return concatenate(parts)
    }
  }
}
