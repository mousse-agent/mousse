import type * as Ort from 'onnxruntime-web'

/**
 * Supertonic 3 inference, following the upstream web example (supertone-oss-archive/supertonic,
 * `web/helper.js`, MIT). The text is cleaned and wrapped in a language tag, turned into ids with
 * the model's Unicode indexer, and four ONNX graphs run in turn: the duration predictor sets how
 * long the speech is, the text encoder embeds the text, the vector estimator denoises a random
 * latent over several flow-matching steps, and the vocoder turns the latent into a waveform.
 */

/** Denoising steps; upstream's default, and a quality/speed trade-off the model was tuned around. */
export const SUPERTONIC_STEPS = 8
/** The speed upstream applies when none is asked for; Mousse's speed 1 maps to it. */
export const SUPERTONIC_BASE_SPEED = 1.05
/** Language tag that lets the model handle text in any of its languages without being told which. */
export const SUPERTONIC_ANY_LANGUAGE = 'na'

export interface SupertonicConfig {
  sampleRate: number
  baseChunkSize: number
  chunkCompress: number
  latentDim: number
}

export function parseSupertonicConfig(json: string): SupertonicConfig {
  const raw = JSON.parse(json) as {
    ae?: { sample_rate?: number; base_chunk_size?: number }
    ttl?: { chunk_compress_factor?: number; latent_dim?: number }
  }
  const sampleRate = raw.ae?.sample_rate
  const baseChunkSize = raw.ae?.base_chunk_size
  const chunkCompress = raw.ttl?.chunk_compress_factor
  const latentDim = raw.ttl?.latent_dim
  if (!sampleRate || !baseChunkSize || !chunkCompress || !latentDim) throw new Error('Supertonic config is incomplete')
  return { sampleRate, baseChunkSize, chunkCompress, latentDim }
}

const EMOJI = /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F77F}\u{1F780}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F1E6}-\u{1F1FF}]+/gu

const SYMBOL_REPLACEMENTS: ReadonlyArray<readonly [string, string]> = [
  ['–', '-'], ['‑', '-'], ['—', '-'], ['_', ' '], ['“', '"'], ['”', '"'], ['‘', "'"], ['’', "'"],
  ['´', "'"], ['`', "'"], ['[', ' '], [']', ' '], ['|', ' '], ['/', ' '], ['#', ' '], ['→', ' '], ['←', ' ']
]

/** Upstream's text cleaning, ending with the language tag the model expects around the text. */
export function supertonicText(input: string, language = SUPERTONIC_ANY_LANGUAGE): string {
  let text = input.normalize('NFKD').replace(EMOJI, '')
  for (const [from, to] of SYMBOL_REPLACEMENTS) text = text.replaceAll(from, to)
  text = text.replace(/[♥☆♡©\\]/g, '')
  text = text.replaceAll('@', ' at ').replaceAll('e.g.,', 'for example, ').replaceAll('i.e.,', 'that is, ')
  text = text.replace(/ ,/g, ',').replace(/ \./g, '.').replace(/ !/g, '!').replace(/ \?/g, '?').replace(/ ;/g, ';').replace(/ :/g, ':').replace(/ '/g, "'")
  text = text.replace(/"{2,}/g, '"').replace(/'{2,}/g, "'").replace(/`{2,}/g, '`')
  text = text.replace(/\s+/g, ' ').trim()
  if (!/[.!?;:,'")\]}…。」』】〉》›»]$/.test(text)) text += '.'
  return `<${language}>${text}</${language}>`
}

/** Ids for cleaned text, one per code point; a character the indexer does not know gets -1, as upstream does. */
export function supertonicTokens(text: string, indexer: ArrayLike<number>): number[] {
  return Array.from(text, (character) => {
    const codePoint = character.codePointAt(0) ?? 0
    return codePoint < indexer.length ? indexer[codePoint] : -1
  })
}

export interface VoiceStyleTensor {
  data: Float32Array
  dims: number[]
}

export interface SupertonicVoice {
  /** Conditions the text encoder and the vector estimator. */
  ttl: VoiceStyleTensor
  /** Conditions the duration predictor. */
  dp: VoiceStyleTensor
}

function styleTensor(value: unknown, name: string): VoiceStyleTensor {
  const entry = value as { data?: unknown; dims?: unknown } | undefined
  if (!entry || !Array.isArray(entry.data) || !Array.isArray(entry.dims)) throw new Error(`Voice style has no ${name}`)
  const dims = entry.dims.map(Number)
  const data = Float32Array.from((entry.data as unknown[]).flat(Infinity) as number[])
  if (data.length !== dims.reduce((total, size) => total * size, 1)) throw new Error(`Voice style ${name} does not match its shape`)
  return { data, dims }
}

/** Parses a `voice_styles/*.json` file. */
export function parseSupertonicVoice(json: string): SupertonicVoice {
  const raw = JSON.parse(json) as { style_ttl?: unknown; style_dp?: unknown }
  return { ttl: styleTensor(raw.style_ttl, 'style_ttl'), dp: styleTensor(raw.style_dp, 'style_dp') }
}

/**
 * The random starting latent, `[latentDim * compress, frames]`, covering `seconds` of speech, and
 * its mask (all ones for a single text; upstream masks the padding of a batch). `random` is
 * Math.random unless a test wants a fixed sequence.
 */
export function sampleNoisyLatent(
  seconds: number,
  config: SupertonicConfig,
  random: () => number = Math.random
): { latent: Float32Array; mask: Float32Array; rows: number; frames: number } {
  const chunkSize = config.baseChunkSize * config.chunkCompress
  const samples = Math.floor(seconds * config.sampleRate)
  const frames = Math.max(1, Math.floor((samples + chunkSize - 1) / chunkSize))
  const rows = config.latentDim * config.chunkCompress
  const latent = new Float32Array(rows * frames)
  for (let index = 0; index < latent.length; index += 1) {
    // Box-Muller transform
    const u1 = Math.max(0.0001, random())
    const u2 = random()
    latent[index] = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
  }
  return { latent, mask: new Float32Array(frames).fill(1), rows, frames }
}

export type SupertonicGraph = 'durationPredictor' | 'textEncoder' | 'vectorEstimator' | 'vocoder'

export interface SupertonicFiles {
  /** The bytes of one ONNX graph. They are read one at a time so only one is held in memory at once. */
  readGraph: (graph: SupertonicGraph) => Promise<Uint8Array>
  /** `onnx/tts.json` as text. */
  config: string
  /** `onnx/unicode_indexer.json` as text. */
  indexer: string
}

export interface SupertonicSynthesizer {
  /** Voices one piece of text with a voice from `parseSupertonicVoice`. */
  synthesize: (text: string, voice: SupertonicVoice, speed: number, language?: string) => Promise<Float32Array>
  sampleRate: number
}

/** Loads the four graphs. `ort` is onnxruntime-web in the worker; tests may pass the Node build. */
export async function createSupertonicSynthesizer(
  ort: typeof Ort,
  files: SupertonicFiles,
  options: { executionProviders?: string[]; steps?: number; random?: () => number } = {}
): Promise<SupertonicSynthesizer> {
  const config = parseSupertonicConfig(files.config)
  const indexer = JSON.parse(files.indexer) as number[]
  const steps = options.steps ?? SUPERTONIC_STEPS
  const sessionOptions = { executionProviders: options.executionProviders ?? ['wasm'] }
  const load = async (graph: SupertonicGraph): Promise<Ort.InferenceSession> =>
    ort.InferenceSession.create(await files.readGraph(graph), sessionOptions)
  const duration = await load('durationPredictor')
  const textEncoder = await load('textEncoder')
  const vectorEstimator = await load('vectorEstimator')
  const vocoder = await load('vocoder')
  const tensor = (voice: VoiceStyleTensor): Ort.Tensor => new ort.Tensor('float32', voice.data, voice.dims)

  return {
    sampleRate: config.sampleRate,
    synthesize: async (text, voice, speed, language = SUPERTONIC_ANY_LANGUAGE) => {
      const ids = supertonicTokens(supertonicText(text, language), indexer)
      const textIds = new ort.Tensor('int64', BigInt64Array.from(ids, BigInt), [1, ids.length])
      const textMask = new ort.Tensor('float32', new Float32Array(ids.length).fill(1), [1, 1, ids.length])
      const styleTtl = tensor(voice.ttl)

      const predicted = await duration.run({ text_ids: textIds, style_dp: tensor(voice.dp), text_mask: textMask })
      const seconds = (predicted.duration.data as Float32Array)[0] / speed

      const textEmbedding = (await textEncoder.run({ text_ids: textIds, style_ttl: styleTtl, text_mask: textMask })).text_emb

      const { latent, mask, rows, frames } = sampleNoisyLatent(seconds, config, options.random)
      const latentMask = new ort.Tensor('float32', mask, [1, 1, frames])
      const totalStep = new ort.Tensor('float32', Float32Array.of(steps), [1])
      let current = latent
      for (let step = 0; step < steps; step += 1) {
        const output = await vectorEstimator.run({
          noisy_latent: new ort.Tensor('float32', current, [1, rows, frames]),
          text_emb: textEmbedding,
          style_ttl: styleTtl,
          latent_mask: latentMask,
          text_mask: textMask,
          current_step: new ort.Tensor('float32', Float32Array.of(step), [1]),
          total_step: totalStep
        })
        current = output.denoised_latent.data as Float32Array
      }

      const wav = (await vocoder.run({ latent: new ort.Tensor('float32', current, [1, rows, frames]) })).wav_tts.data as Float32Array
      return wav.slice(0, Math.floor(seconds * config.sampleRate))
    }
  }
}
