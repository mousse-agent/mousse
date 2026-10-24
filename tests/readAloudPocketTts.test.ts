import { describe, expect, it } from 'vitest'
import {
  createPocketSynthesizer,
  filledData,
  fitToShape,
  gaussian,
  maxFramesFor,
  parsePocketBundle,
  parseVoicesBin,
  type StateEntry,
  type StateTensor
} from '../src/renderer/readAloud/pocketTts'
import { stretchSpeech } from '../src/renderer/readAloud/timeStretch'
import { LOCAL_TTS_MODELS, POCKET_TTS_MODELS, findLocalTtsModel } from '../src/shared/readAloud'

const MARK = '▁'

const FLOW_STATE: StateEntry[] = [
  { index: 0, module: 'layer.0', key: 'offset', input_name: 'state_0', output_name: 'next_state_0', shape: [1], dtype: 'int64', fill: 'zeros' },
  { index: 1, module: 'layer.0', key: 'cache', input_name: 'state_1', output_name: 'next_state_1', shape: [2, 1, 6, 2, 2], dtype: 'float32', fill: 'zeros' }
]
const MIMI_STATE: StateEntry[] = [
  { index: 0, module: 'decoder', key: 'first', input_name: 'state_0', output_name: 'next_state_0', shape: [1], dtype: 'bool', fill: 'ones' },
  { index: 1, module: 'decoder', key: 'previous', input_name: 'state_1', output_name: 'next_state_1', shape: [1, 4, 0], dtype: 'float32', fill: 'zeros' }
]

function bundleJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schema_version: 3,
    temperature: 0.3,
    sampler_decode_steps: 1,
    noise_clamp: null,
    eos_threshold: -4,
    min_frames_before_eos: 2,
    sample_rate: 24000,
    samples_per_frame: 1920,
    latent_dim: 3,
    conditioning_dim: 4,
    max_token_per_chunk: 50,
    predefined_voices: ['alba', 'jean'],
    flow_lm_state_manifest: FLOW_STATE,
    mimi_state_manifest: MIMI_STATE,
    replace_characters: {},
    append_terminal_punctuation: true,
    capitalize_first_letter: true,
    remove_semicolons: false,
    pad_with_spaces_for_short_inputs: false,
    model_recommended_frames_after_eos: null,
    ...overrides
  })
}

function tokenizerJson(): string {
  const vocab: Array<[string, number]> = [['<unk>', 0], ['<s>', 0], ['</s>', 0], ['<pad>', 0]]
  for (let byte = 0; byte < 256; byte += 1) vocab.push([`<0x${byte.toString(16).toUpperCase().padStart(2, '0')}>`, 0])
  for (const piece of [MARK, `${MARK}hi`, '.']) vocab.push([piece, -1])
  return JSON.stringify({ normalizer: { type: 'Prepend', prepend: MARK }, model: { type: 'Unigram', unk_id: 0, byte_fallback: true, vocab } })
}

/** `PTVB1` voices file with the given voices, each a list of [key, dtype code, shape, bytes]. */
function voicesBin(voices: Record<string, Array<[string, number, number[], Uint8Array]>>): Uint8Array {
  const parts: number[] = [...new TextEncoder().encode('PTVB1')]
  const u = (value: number, size: number): void => {
    for (let index = 0; index < size; index += 1) parts.push((value >> (8 * index)) & 0xff)
  }
  const names = Object.keys(voices)
  u(names.length, 4)
  for (const name of names) {
    const encoded = new TextEncoder().encode(name)
    u(encoded.length, 2)
    parts.push(...encoded)
    u(voices[name].length, 2)
    for (const [key, code, shape, bytes] of voices[name]) {
      const keyBytes = new TextEncoder().encode(key)
      u(keyBytes.length, 2)
      parts.push(...keyBytes)
      u(code, 1)
      u(shape.length, 1)
      for (const dim of shape) u(dim, 4)
      u(bytes.length, 4)
      parts.push(...bytes)
    }
  }
  return Uint8Array.from(parts)
}

const floats = (...values: number[]): Uint8Array => new Uint8Array(Float32Array.from(values).buffer)
const int64 = (value: bigint): Uint8Array => new Uint8Array(BigInt64Array.of(value).buffer)

describe('parsePocketBundle', () => {
  it('reads the sampling settings, text rules and state layout', () => {
    const bundle = parsePocketBundle(bundleJson({ remove_semicolons: true, replace_characters: { '"': '' }, model_recommended_frames_after_eos: 2 }))
    expect(bundle).toMatchObject({
      sampleRate: 24000,
      latentDim: 3,
      temperature: 0.3,
      eosThreshold: -4,
      minFramesBeforeEos: 2,
      samplerDecodeSteps: 1,
      framesAfterEos: 2,
      voices: ['alba', 'jean'],
      noiseClamp: null
    })
    expect(bundle.text).toEqual({
      removeSemicolons: true,
      appendTerminalPunctuation: true,
      capitalizeFirstLetter: true,
      padWithSpacesForShortInputs: false,
      replaceCharacters: { '"': '' },
      maxTokensPerChunk: 50
    })
    expect(bundle.flowLmState).toHaveLength(2)
    expect(bundle.mimiState).toHaveLength(2)
  })

  it('rejects another schema or a missing field', () => {
    expect(() => parsePocketBundle(bundleJson({ schema_version: 2 }))).toThrow('schema 2')
    expect(() => parsePocketBundle(bundleJson({ latent_dim: undefined }))).toThrow('latent_dim')
    expect(() => parsePocketBundle(bundleJson({ mimi_state_manifest: undefined }))).toThrow('mimi_state_manifest')
  })
})

describe('parseVoicesBin', () => {
  it('reads each voice with its float, integer and bool tensors', () => {
    const file = voicesBin({
      alba: [
        ['layer.0/cache', 0, [1, 2], floats(1.5, -2)],
        ['layer.0/offset', 1, [1], int64(126n)],
        ['decoder/first', 2, [1], Uint8Array.of(1)]
      ],
      jean: [['layer.0/cache', 0, [1, 1], floats(9)]]
    })
    const voices = parseVoicesBin(file)
    expect([...voices.keys()]).toEqual(['alba', 'jean'])
    const alba = voices.get('alba')!
    expect(alba['layer.0/cache']).toMatchObject({ dtype: 'float32', shape: [1, 2] })
    expect(Array.from(alba['layer.0/cache'].data as Float32Array)).toEqual([1.5, -2])
    expect(alba['layer.0/offset'].data).toEqual(BigInt64Array.of(126n))
    expect(Array.from(alba['decoder/first'].data as Uint8Array)).toEqual([1])
    expect(Array.from(voices.get('jean')!['layer.0/cache'].data as Float32Array)).toEqual([9])
  })

  it('rejects a file that is not a voices file or is cut short', () => {
    expect(() => parseVoicesBin(new TextEncoder().encode('PTVB2....'))).toThrow('voices file')
    const file = voicesBin({ alba: [['k/cache', 0, [2], floats(1, 2)]] })
    expect(() => parseVoicesBin(file.subarray(0, file.length - 3))).toThrow('truncated')
  })
})

describe('state data', () => {
  it('fills tensors the way the bundle says', () => {
    expect(Array.from(filledData({ shape: [3], dtype: 'float32', fill: 'zeros' }) as Float32Array)).toEqual([0, 0, 0])
    expect(Array.from(filledData({ shape: [2], dtype: 'float32', fill: 'ones' }) as Float32Array)).toEqual([1, 1])
    expect(Number.isNaN((filledData({ shape: [1], dtype: 'float32', fill: 'nan' }) as Float32Array)[0])).toBe(true)
    expect(filledData({ shape: [2], dtype: 'int64', fill: 'zeros' })).toEqual(new BigInt64Array(2))
    expect(Array.from(filledData({ shape: [1], dtype: 'bool', fill: 'ones' }) as Uint8Array)).toEqual([1])
    expect(filledData({ shape: [1, 4, 0], dtype: 'float32', fill: 'zeros' })).toHaveLength(0)
  })

  it('copies a voice cache into the larger cache of the model, row by row', () => {
    // [kv, batch, rows, heads, dim] = [2, 1, 2, 1, 2] into [2, 1, 4, 1, 2]
    const source: StateTensor = { dtype: 'float32', shape: [2, 1, 2, 1, 2], data: Float32Array.from([1, 2, 3, 4, 5, 6, 7, 8]) }
    const target = fitToShape(source, { ...FLOW_STATE[1], shape: [2, 1, 4, 1, 2] }) as Float32Array
    expect(Array.from(target)).toEqual([1, 2, 3, 4, 0, 0, 0, 0, 5, 6, 7, 8, 0, 0, 0, 0])
  })

  it('copies counters and keeps the fill when the rank differs', () => {
    expect(fitToShape({ dtype: 'int64', shape: [1], data: BigInt64Array.of(126n) }, FLOW_STATE[0])).toEqual(BigInt64Array.of(126n))
    const mismatch = fitToShape({ dtype: 'float32', shape: [4], data: new Float32Array(4).fill(7) }, FLOW_STATE[1]) as Float32Array
    expect(mismatch.every((value) => value === 0)).toBe(true)
  })
})

describe('sampling helpers', () => {
  it('draws normal noise scaled by the standard deviation, optionally clamped', () => {
    const values = [0.5, 0.25]
    let index = 0
    const noise = gaussian(2, 2, () => values[index++ % 2])
    expect(noise[0]).toBeCloseTo(2 * Math.sqrt(-2 * Math.log(0.5)) * Math.cos(2 * Math.PI * 0.25), 5)
    expect(gaussian(50, 100, Math.random, 1).every((value) => Math.abs(value) <= 1)).toBe(true)
  })

  it('allows about three tokens a second plus two seconds at 12.5 frames a second', () => {
    expect(maxFramesFor(30)).toBe(150)
    expect(maxFramesFor(1)).toBe(30)
  })
})

describe('createPocketSynthesizer', () => {
  type Feeds = Record<string, { type: string; data: ArrayLike<number | bigint>; dims: number[] }>

  /** Graphs that follow the contract: the flow model's states count up, and it signals the end after `eosAfter` steps. */
  function fakeRuntime(eosAfter: number) {
    const calls: Array<{ graph: string; feeds: Feeds }> = []
    class Tensor {
      constructor(
        readonly type: string,
        readonly data: ArrayLike<number | bigint>,
        readonly dims: number[]
      ) {}
    }
    let mainCalls = 0
    const run: Record<string, (feeds: Feeds) => Record<string, Tensor>> = {
      textConditioner: (feeds) => ({ text_embeddings: new Tensor('float32', new Float32Array(feeds.token_ids.dims[1] * 4), [1, feeds.token_ids.dims[1], 4]) }),
      flowLmMain: (feeds) => {
        mainCalls += 1
        const autoregressive = feeds.sequence.dims[1] === 1
        const step = autoregressive ? mainCalls - 2 : -1
        return {
          conditioning: new Tensor('float32', new Float32Array(4).fill(step), [1, 4]),
          eos_logit: new Tensor('float32', Float32Array.of(autoregressive && step >= eosAfter ? 0 : -10), [1, 1]),
          next_state_0: new Tensor('int64', BigInt64Array.of((feeds.state_0.data as BigInt64Array)[0] + 1n), [1]),
          next_state_1: feeds.state_1 as never
        }
      },
      flowLmFlow: () => ({ flow_dir: new Tensor('float32', Float32Array.of(1, 1, 1), [1, 3]) }),
      mimiDecoder: (feeds) => ({
        audio: new Tensor('float32', new Float32Array(feeds.latent.dims[1] * 1920).fill(0.25), [1, 1, feeds.latent.dims[1] * 1920]),
        next_state_0: feeds.state_0 as never,
        next_state_1: feeds.state_1 as never
      })
    }
    const order = ['textConditioner', 'flowLmMain', 'flowLmFlow', 'mimiDecoder']
    let created = 0
    const outputNames: Record<string, string[]> = { textConditioner: ['text_embeddings'], mimiDecoder: ['audio', 'next_state_0', 'next_state_1'] }
    const ort = {
      Tensor,
      InferenceSession: {
        create: async () => {
          const graph = order[created++]
          return { outputNames: outputNames[graph] ?? [], run: async (feeds: Feeds) => (calls.push({ graph, feeds }), run[graph](feeds)) }
        }
      }
    } as never
    return { ort, calls }
  }

  const voices = voicesBin({
    alba: [
      ['layer.0/offset', 1, [1], int64(3n)],
      ['layer.0/cache', 0, [2, 1, 3, 2, 2], floats(...Array.from({ length: 24 }, (_, index) => index + 1))]
    ]
  })

  const files = (reads: string[] = []) => ({
    bundle: bundleJson(),
    tokenizer: tokenizerJson(),
    voices,
    readGraph: async (graph: string) => (reads.push(graph), new Uint8Array())
  })

  it('loads the graphs in order and lists the voices', async () => {
    const { ort } = fakeRuntime(3)
    const reads: string[] = []
    const pocket = await createPocketSynthesizer(ort, files(reads))
    expect(reads).toEqual(['textConditioner', 'flowLmMain', 'flowLmFlow', 'mimiDecoder'])
    expect(pocket.voices).toEqual(['alba', 'jean'])
    expect(pocket.sampleRate).toBe(24000)
  })

  it('reads the voice and text, steps from an empty first frame, and stops after the end signal', async () => {
    const { ort, calls } = fakeRuntime(3)
    const pocket = await createPocketSynthesizer(ort, files(), { random: () => 0.5 })
    const audio = await pocket.synthesize('hi', 'alba')

    const main = calls.filter((call) => call.graph === 'flowLmMain')
    // One pass for the text, then autoregressive steps 0..: the end signal comes at step 3, and three frames are kept
    // after it for this short text (3 words or fewer wait 3 + 2).
    const [conditioning, firstStep] = main
    expect(conditioning.feeds.sequence.dims).toEqual([1, 0, 3])
    expect(conditioning.feeds.text_embeddings.dims[1]).toBeGreaterThan(0)
    expect(firstStep.feeds.sequence.dims).toEqual([1, 1, 3])
    expect(Number.isNaN(firstStep.feeds.sequence.data[0] as number)).toBe(true)
    expect(firstStep.feeds.text_embeddings.dims).toEqual([1, 0, 4])
    // The voice's counter and cache reached the model, the cache padded to the model's six rows.
    expect(conditioning.feeds.state_0.data[0]).toBe(3n)
    expect(conditioning.feeds.state_1.dims).toEqual([2, 1, 6, 2, 2])
    expect(Array.from(conditioning.feeds.state_1.data as Float32Array).slice(0, 12)).toEqual([...Array.from({ length: 12 }, (_, index) => index + 1)])
    expect(Array.from(conditioning.feeds.state_1.data as Float32Array).slice(12, 24).every((value) => value === 0)).toBe(true)
    // The counter returned by one pass is the input of the next.
    expect(firstStep.feeds.state_0.data[0]).toBe(4n)
    expect(main[2].feeds.state_0.data[0]).toBe(5n)
    // The next frame is fed back: the flow head's direction (1) added to noise.
    expect(main[2].feeds.sequence.dims).toEqual([1, 1, 3])
    expect(Number.isNaN(main[2].feeds.sequence.data[0] as number)).toBe(false)

    const steps = main.length - 1
    expect(steps).toBe(3 + 5 + 1)
    const decoded = calls.filter((call) => call.graph === 'mimiDecoder')
    expect(decoded).toHaveLength(1)
    const frames = steps - 1
    expect(decoded[0].feeds.latent.dims).toEqual([1, frames, 3])
    expect(decoded[0].feeds.state_0.data[0]).toBe(1)
    expect(audio).toHaveLength(frames * 1920)
    expect(calls.filter((call) => call.graph === 'flowLmFlow')).toHaveLength(frames)
  })

  it('ignores an end signal before the minimum number of frames', async () => {
    const { ort, calls } = fakeRuntime(0)
    const pocket = await createPocketSynthesizer(ort, files(), { random: () => 0.5 })
    await pocket.synthesize('hi', 'alba')
    // Signalled at step 0, but counted from step 2 (min_frames_before_eos), and then five frames more.
    expect(calls.filter((call) => call.graph === 'flowLmMain')).toHaveLength(1 + 2 + 5 + 1)
  })

  it('uses the frames after the end that the bundle recommends', async () => {
    const { ort, calls } = fakeRuntime(3)
    const pocket = await createPocketSynthesizer(ort, { ...files(), bundle: bundleJson({ model_recommended_frames_after_eos: 1 }) }, { random: () => 0.5 })
    await pocket.synthesize('hi', 'alba')
    expect(calls.filter((call) => call.graph === 'flowLmMain')).toHaveLength(1 + 3 + 1 + 1)
  })

  it('rejects a voice it does not have', async () => {
    const { ort } = fakeRuntime(3)
    const pocket = await createPocketSynthesizer(ort, files())
    await expect(pocket.synthesize('hi', 'nobody')).rejects.toThrow('no voice named nobody')
  })
})

describe('stretchSpeech', () => {
  const rate = 24000
  const tone = Float32Array.from({ length: rate * 2 }, (_, index) => Math.sin((2 * Math.PI * 200 * index) / rate) * 0.5)

  const crossings = (samples: Float32Array): number => {
    let count = 0
    for (let index = 1; index < samples.length; index += 1) if (samples[index - 1] < 0 && samples[index] >= 0) count += 1
    return count
  }

  it('returns the same audio at normal speed', () => {
    expect(stretchSpeech(tone, rate, 1)).toBe(tone)
  })

  it.each([0.75, 1.25, 1.5, 2])('changes the length by the speed and keeps the pitch at %s', (speed) => {
    const out = stretchSpeech(tone, rate, speed)
    expect(out.length).toBe(Math.floor(tone.length / speed))
    // 200 Hz stays 200 Hz: the crossings per second do not change.
    const frequency = crossings(out) / (out.length / rate)
    expect(frequency).toBeGreaterThan(190)
    expect(frequency).toBeLessThan(210)
    expect(out.every(Number.isFinite)).toBe(true)
    const peak = out.reduce((largest, value) => Math.max(largest, Math.abs(value)), 0)
    expect(peak).toBeGreaterThan(0.4)
    expect(peak).toBeLessThan(0.6)
  })

  it('leaves audio too short to stretch as it is', () => {
    const short = new Float32Array(100)
    expect(stretchSpeech(short, rate, 1.5)).toBe(short)
  })
})

describe('Pocket TTS manifests', () => {
  it('lists seven languages after the other models and finds them by id', () => {
    expect(POCKET_TTS_MODELS.map((model) => model.id)).toEqual(['pocket-tts-en', 'pocket-tts-fr', 'pocket-tts-de', 'pocket-tts-es', 'pocket-tts-it', 'pocket-tts-pt', 'pocket-tts-nl'])
    expect(LOCAL_TTS_MODELS.slice(-7)).toEqual([...POCKET_TTS_MODELS])
    for (const model of POCKET_TTS_MODELS) expect(findLocalTtsModel(model.id)).toBe(model)
  })

  it.each(POCKET_TTS_MODELS.map((model) => [model.id, model] as const))('%s pins the export and lists every file its runtime reads', (_id, model) => {
    expect(model.repo).toBe('Alias-Alias/pocket-3-3-0-tts-onnx')
    expect(model.revision).toBe('71a4d6d11a76e26b98709fa163477c77d16bdbdb')
    expect(model.license).toBe('CC-BY-4.0')
    const files = new Map(model.files.map((file) => [file.path, file]))
    for (const path of [model.bundle, model.tokenizer, model.voicesFile, model.textConditioner, model.flowLmMain, model.flowLmFlow, model.mimiDecoder]) {
      expect(path.startsWith(`${model.language}/`)).toBe(true)
      expect(files.get(path)?.sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(files.get(path)?.optional).toBeUndefined()
    }
    expect(model.files).toHaveLength(7)
    expect(model.voices.map((voice) => voice.id)).toEqual(['alba', 'azelma', 'cosette', 'eponine', 'fantine', 'javert', 'jean', 'marius'])
    expect(model.voices[0]).toEqual({ id: 'alba', label: 'Alba, female' })
    expect(model.defaultVoice).toBe('alba')
  })

  it('has different weights for every language', () => {
    const hashes = POCKET_TTS_MODELS.map((model) => model.files.find((file) => file.path === model.flowLmMain)?.sha256)
    expect(new Set(hashes).size).toBe(POCKET_TTS_MODELS.length)
  })
})
