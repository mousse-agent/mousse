import type * as Ort from 'onnxruntime-web'
import { UnigramTokenizer, splitPocketChunks, type PocketTextOptions } from './pocketText'

/**
 * Pocket TTS inference over the INT8 ONNX export `Alias-Alias/pocket-3-3-0-tts-onnx` (bundle schema
 * 3), following the browser loop of KevinAHM/pocket-tts-web (Apache-2.0) and kyutai-labs/pocket-tts
 * at commit 3dbee45 (MIT). Text is embedded by the text conditioner; the flow language model reads
 * the voice, the text, and then its own previous latent frame one step at a time (its attention
 * cache and step counters travel as numbered `state_N` tensors); a one-step flow head turns each
 * step's conditioning and some noise into the next 32-value latent; and the Mimi decoder turns the
 * latent frames into 24 kHz audio, carrying its own convolution state.
 */

export type PocketDtype = 'float32' | 'int64' | 'bool'

export interface StateEntry {
  index: number
  module: string
  key: string
  input_name: string
  output_name: string
  shape: number[]
  dtype: PocketDtype
  fill: 'zeros' | 'ones' | 'nan' | 'empty'
}

export interface PocketBundle {
  sampleRate: number
  samplesPerFrame: number
  latentDim: number
  conditioningDim: number
  temperature: number
  noiseClamp: number | null
  eosThreshold: number
  minFramesBeforeEos: number
  samplerDecodeSteps: number
  /** Frames to keep after the end signal when set, instead of a guess from the text length. */
  framesAfterEos: number | null
  voices: string[]
  flowLmState: StateEntry[]
  mimiState: StateEntry[]
  text: PocketTextOptions
}

export function parsePocketBundle(json: string): PocketBundle {
  const raw = JSON.parse(json) as Record<string, unknown>
  if (raw.schema_version !== 3) throw new Error(`Unsupported Pocket TTS bundle schema ${String(raw.schema_version)}`)
  const num = (key: string): number => {
    const value = raw[key]
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`Pocket TTS bundle has no ${key}`)
    return value
  }
  const entries = (key: string): StateEntry[] => {
    const list = raw[key]
    if (!Array.isArray(list)) throw new Error(`Pocket TTS bundle has no ${key}`)
    return list as StateEntry[]
  }
  return {
    sampleRate: num('sample_rate'),
    samplesPerFrame: num('samples_per_frame'),
    latentDim: num('latent_dim'),
    conditioningDim: num('conditioning_dim'),
    temperature: num('temperature'),
    noiseClamp: typeof raw.noise_clamp === 'number' ? raw.noise_clamp : null,
    eosThreshold: num('eos_threshold'),
    minFramesBeforeEos: num('min_frames_before_eos'),
    samplerDecodeSteps: num('sampler_decode_steps'),
    framesAfterEos: typeof raw.model_recommended_frames_after_eos === 'number' ? raw.model_recommended_frames_after_eos : null,
    voices: Array.isArray(raw.predefined_voices) ? (raw.predefined_voices as string[]) : [],
    flowLmState: entries('flow_lm_state_manifest'),
    mimiState: entries('mimi_state_manifest'),
    text: {
      removeSemicolons: raw.remove_semicolons === true,
      appendTerminalPunctuation: raw.append_terminal_punctuation !== false,
      capitalizeFirstLetter: raw.capitalize_first_letter !== false,
      padWithSpacesForShortInputs: raw.pad_with_spaces_for_short_inputs === true,
      replaceCharacters: (raw.replace_characters as Record<string, string> | undefined) ?? {},
      maxTokensPerChunk: num('max_token_per_chunk')
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Voice states (`voices.bin`, format `PTVB1`)
// ---------------------------------------------------------------------------------------------

type TypedData = Float32Array | BigInt64Array | Uint8Array

export interface StateTensor {
  dtype: PocketDtype
  shape: number[]
  data: TypedData
}

/** One voice: the flow model's state after it heard the speaker, keyed `<module>/<key>`. */
export type VoiceRecord = Record<string, StateTensor>

/** Parses a `voices.bin`: `PTVB1`, a voice count, then per voice a name and its tensors. */
export function parseVoicesBin(bytes: Uint8Array): Map<string, VoiceRecord> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const text = new TextDecoder()
  if (text.decode(bytes.subarray(0, 5)) !== 'PTVB1') throw new Error('Not a Pocket TTS voices file')
  let offset = 5
  const read = (size: number): number => {
    const value = size === 1 ? view.getUint8(offset) : size === 2 ? view.getUint16(offset, true) : view.getUint32(offset, true)
    offset += size
    return value
  }
  const voices = new Map<string, VoiceRecord>()
  const count = read(4)
  for (let voice = 0; voice < count; voice += 1) {
    const name = text.decode(bytes.subarray(offset + 2, offset + 2 + view.getUint16(offset, true)))
    offset += 2 + view.getUint16(offset, true)
    const record: VoiceRecord = {}
    const tensors = read(2)
    for (let index = 0; index < tensors; index += 1) {
      const keyLength = read(2)
      const key = text.decode(bytes.subarray(offset, offset + keyLength))
      offset += keyLength
      const code = read(1)
      const rank = read(1)
      const shape = Array.from({ length: rank }, () => read(4))
      const length = read(4)
      if (offset + length > bytes.length) throw new Error('Pocket TTS voices file is truncated')
      const raw = bytes.slice(offset, offset + length).buffer
      offset += length
      if (code === 0) record[key] = { dtype: 'float32', shape, data: new Float32Array(raw) }
      else if (code === 1) record[key] = { dtype: 'int64', shape, data: new BigInt64Array(raw) }
      else if (code === 2) record[key] = { dtype: 'bool', shape, data: new Uint8Array(raw) }
      else throw new Error(`Unsupported voices file data type ${code}`)
    }
    voices.set(name, record)
  }
  return voices
}

const product = (shape: readonly number[]): number => shape.reduce((total, size) => total * size, 1)

/** A tensor's worth of data for `entry`, filled the way the bundle says. */
export function filledData(entry: Pick<StateEntry, 'shape' | 'dtype' | 'fill'>): TypedData {
  const size = product(entry.shape)
  if (entry.dtype === 'int64') return new BigInt64Array(size)
  if (entry.dtype === 'bool') return new Uint8Array(size).fill(entry.fill === 'ones' ? 1 : 0)
  const data = new Float32Array(size)
  if (entry.fill === 'nan') data.fill(NaN)
  else if (entry.fill === 'ones') data.fill(1)
  return data
}

/**
 * Copies `source` into a tensor of the target shape: the leading part of each axis is written and
 * the rest keeps its fill. A voice's attention cache has as many rows as the voice took, while the
 * model's cache has room for the whole text and speech after it.
 */
export function fitToShape(source: StateTensor, entry: StateEntry): TypedData {
  const target = filledData(entry)
  if (source.shape.length !== entry.shape.length) return target
  const copyShape = source.shape.map((size, axis) => Math.min(size, entry.shape[axis]))
  if (copyShape.some((size) => size === 0)) return target
  const strides = (shape: readonly number[]): number[] => shape.map((_, axis) => product(shape.slice(axis + 1)))
  const sourceStrides = strides(source.shape)
  const targetStrides = strides(entry.shape)
  const last = copyShape.length - 1
  const run = copyShape[last]
  const index = new Array<number>(copyShape.length).fill(0)
  for (;;) {
    let from = 0
    let to = 0
    for (let axis = 0; axis < last; axis += 1) {
      from += index[axis] * sourceStrides[axis]
      to += index[axis] * targetStrides[axis]
    }
    ;(target as Float32Array).set((source.data as Float32Array).subarray(from, from + run), to)
    let axis = last - 1
    while (axis >= 0 && ++index[axis] === copyShape[axis]) index[axis--] = 0
    if (axis < 0) break
  }
  return target
}

// ---------------------------------------------------------------------------------------------
// Synthesis
// ---------------------------------------------------------------------------------------------

export interface PocketFiles {
  /** `bundle.json` as text. */
  bundle: string
  /** `tokenizer.json` as text. */
  tokenizer: string
  /** `voices.bin`. */
  voices: Uint8Array
  /** The bytes of one ONNX graph; read one at a time. */
  readGraph: (graph: 'textConditioner' | 'flowLmMain' | 'flowLmFlow' | 'mimiDecoder') => Promise<Uint8Array>
}

export interface PocketSynthesizer {
  voices: string[]
  sampleRate: number
  /** Voices one piece of text. */
  synthesize: (text: string, voice: string) => Promise<Float32Array>
}

/** Standard normal numbers scaled by `std`, by the Box-Muller transform. */
export function gaussian(count: number, std: number, random: () => number = Math.random, clamp: number | null = null): Float32Array {
  const out = new Float32Array(count)
  for (let index = 0; index < count; index += 1) {
    let u = 0
    let v = 0
    while (u === 0) u = random()
    while (v === 0) v = random()
    const value = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v) * std
    out[index] = clamp === null ? value : Math.max(-clamp, Math.min(clamp, value))
  }
  return out
}

/** Most latent frames per chunk of text: about three tokens a second plus two seconds, at 12.5 frames a second. */
export function maxFramesFor(tokenCount: number): number {
  return Math.ceil((tokenCount / 3 + 2) * 12.5)
}

/** Loads the four graphs. `ort` is onnxruntime-web in the worker; tests may pass the Node build. */
export async function createPocketSynthesizer(
  ort: typeof Ort,
  files: PocketFiles,
  options: { executionProviders?: string[]; random?: () => number } = {}
): Promise<PocketSynthesizer> {
  const bundle = parsePocketBundle(files.bundle)
  const tokenizer = new UnigramTokenizer(files.tokenizer)
  const voiceRecords = parseVoicesBin(files.voices)
  const sessionOptions = { executionProviders: options.executionProviders ?? ['wasm'] }
  const load = async (graph: Parameters<PocketFiles['readGraph']>[0]): Promise<Ort.InferenceSession> =>
    ort.InferenceSession.create(await files.readGraph(graph), sessionOptions)
  const textConditioner = await load('textConditioner')
  const flowLmMain = await load('flowLmMain')
  const flowLmFlow = await load('flowLmFlow')
  const mimiDecoder = await load('mimiDecoder')

  type State = Record<string, Ort.Tensor>
  const tensorOf = (entry: StateEntry, data: TypedData): Ort.Tensor => new ort.Tensor(entry.dtype, data as never, entry.shape)
  const initialState = (manifest: StateEntry[]): State =>
    Object.fromEntries(manifest.map((entry) => [entry.input_name, tensorOf(entry, filledData(entry))]))
  const carry = (state: State, outputs: Record<string, Ort.Tensor>, manifest: StateEntry[]): void => {
    for (const entry of manifest) state[entry.input_name] = outputs[entry.output_name]
  }

  /** The flow model's state for a voice: its cache copied into the model's cache, with its counters. */
  const voiceStates = new Map<string, State>()
  const voiceState = (voice: string): State => {
    let state = voiceStates.get(voice)
    if (state) return state
    const record = voiceRecords.get(voice)
    if (!record) throw new Error(`Pocket TTS has no voice named ${voice}`)
    state = initialState(bundle.flowLmState)
    for (const entry of bundle.flowLmState) {
      const source = record[`${entry.module}/${entry.key}`]
      if (source) state[entry.input_name] = tensorOf(entry, fitToShape(source, entry))
    }
    voiceStates.set(voice, state)
    return state
  }

  const emptySequence = new ort.Tensor('float32', new Float32Array(0), [1, 0, bundle.latentDim])
  const emptyText = new ort.Tensor('float32', new Float32Array(0), [1, 0, bundle.conditioningDim])
  const steps = Array.from({ length: bundle.samplerDecodeSteps }, (_, step) => ({
    s: new ort.Tensor('float32', Float32Array.of(step / bundle.samplerDecodeSteps), [1, 1]),
    t: new ort.Tensor('float32', Float32Array.of((step + 1) / bundle.samplerDecodeSteps), [1, 1])
  }))

  /** Generates the latent frames for one chunk of text, starting from the voice. */
  const generateLatents = async (text: string, framesAfterEos: number, voice: string): Promise<Float32Array[]> => {
    const ids = tokenizer.encode(text)
    const tokenIds = new ort.Tensor('int64', BigInt64Array.from(ids, BigInt), [1, ids.length])
    let embeddings = (await textConditioner.run({ token_ids: tokenIds }))[textConditioner.outputNames[0]]
    if (embeddings.dims.length === 2) embeddings = new ort.Tensor('float32', embeddings.data as Float32Array, [1, embeddings.dims[0], embeddings.dims[1]])

    const state: State = { ...voiceState(voice) }
    carry(state, await flowLmMain.run({ sequence: emptySequence, text_embeddings: embeddings, ...state }), bundle.flowLmState)

    const latents: Float32Array[] = []
    let current = new ort.Tensor('float32', new Float32Array(bundle.latentDim).fill(NaN), [1, 1, bundle.latentDim])
    let eosStep: number | null = null
    const maxFrames = maxFramesFor(ids.length)
    for (let step = 0; step < maxFrames; step += 1) {
      const result = await flowLmMain.run({ sequence: current, text_embeddings: emptyText, ...state })
      const eos = (result.eos_logit.data as Float32Array)[0] > bundle.eosThreshold
      if (eos && eosStep === null && step >= bundle.minFramesBeforeEos) eosStep = step
      if (eosStep !== null && step >= eosStep + framesAfterEos) break

      const latent = gaussian(bundle.latentDim, Math.sqrt(bundle.temperature), options.random, bundle.noiseClamp)
      for (const { s, t } of steps) {
        const flow = await flowLmFlow.run({
          c: result.conditioning,
          s,
          t,
          x: new ort.Tensor('float32', latent, [1, bundle.latentDim])
        })
        const direction = flow.flow_dir.data as Float32Array
        for (let index = 0; index < latent.length; index += 1) latent[index] += direction[index] / bundle.samplerDecodeSteps
      }
      latents.push(Float32Array.from(latent))
      current = new ort.Tensor('float32', latent, [1, 1, bundle.latentDim])
      carry(state, result, bundle.flowLmState)
    }
    return latents
  }

  const decode = async (latents: Float32Array[]): Promise<Float32Array> => {
    if (latents.length === 0) return new Float32Array(0)
    const mimi = initialState(bundle.mimiState)
    const flat = new Float32Array(latents.length * bundle.latentDim)
    latents.forEach((latent, frame) => flat.set(latent, frame * bundle.latentDim))
    const result = await mimiDecoder.run({ latent: new ort.Tensor('float32', flat, [1, latents.length, bundle.latentDim]), ...mimi })
    return Float32Array.from(result[mimiDecoder.outputNames[0]].data as Float32Array)
  }

  return {
    voices: bundle.voices.length > 0 ? bundle.voices : [...voiceRecords.keys()],
    sampleRate: bundle.sampleRate,
    synthesize: async (text, voice) => {
      const parts: Float32Array[] = []
      for (const chunk of splitPocketChunks(text, tokenizer, bundle.text)) {
        const frames = bundle.framesAfterEos ?? chunk.framesAfterEos
        parts.push(await decode(await generateLatents(chunk.text, frames, voice)))
      }
      const out = new Float32Array(parts.reduce((total, part) => total + part.length, 0))
      let offset = 0
      for (const part of parts) {
        out.set(part, offset)
        offset += part.length
      }
      return out
    }
  }
}
