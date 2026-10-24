import { describe, expect, it } from 'vitest'
import {
  SUPERTONIC_STEPS,
  createSupertonicSynthesizer,
  parseSupertonicConfig,
  parseSupertonicVoice,
  sampleNoisyLatent,
  supertonicText,
  supertonicTokens
} from '../src/renderer/readAloud/supertonicTts'
import { LOCAL_TTS_MODELS, SUPERTONIC_3, findLocalTtsModel } from '../src/shared/readAloud'

const CONFIG = { sampleRate: 44100, baseChunkSize: 512, chunkCompress: 6, latentDim: 24 }
const CONFIG_JSON = JSON.stringify({ ae: { sample_rate: 44100, base_chunk_size: 512 }, ttl: { chunk_compress_factor: 6, latent_dim: 24 } })

describe('supertonicText', () => {
  it('wraps the text in the language tag and ends it with a period', () => {
    expect(supertonicText('Hello world')).toBe('<na>Hello world.</na>')
    expect(supertonicText('Bonjour le monde !', 'fr')).toBe('<fr>Bonjour le monde!</fr>')
  })

  it('keeps text that already ends in punctuation, quotes or a closing bracket', () => {
    for (const ending of ['.', '!', '?', ';', ':', ',', '"', ')', '。', '»']) {
      expect(supertonicText(`Hi${ending}`)).toBe(`<na>Hi${ending}</na>`)
    }
    // Compatibility decomposition turns the ellipsis character into three dots.
    expect(supertonicText('Hi…')).toBe('<na>Hi...</na>')
  })

  it('removes emoji and symbols the model does not read, and replaces dashes and quotes', () => {
    expect(supertonicText('Great \u{1F600} work ♥')).toBe('<na>Great work.</na>')
    expect(supertonicText('A — B – C, “quoted” and ‘this’')).toBe('<na>A - B - C, "quoted" and\'this\'</na>')
    expect(supertonicText('a_b [c] d|e f/g #h')).toBe('<na>a b c d e f g h.</na>')
  })

  it('reads @ and a few abbreviations as words, and tightens spacing before punctuation', () => {
    expect(supertonicText('mail me @ home , e.g., now ;')).toBe('<na>mail me at home, for example, now;</na>')
  })

  it('collapses repeated quotes and whitespace', () => {
    expect(supertonicText('say ""hi""   there')).toBe('<na>say "hi" there.</na>')
  })

  it('decomposes accented letters, as the model was trained on decomposed text', () => {
    expect(supertonicText('été')).toBe('<na>été.</na>')
  })
})

describe('supertonicTokens', () => {
  const indexer = Array.from({ length: 200 }, (_, index) => (index === 0 ? -1 : index + 1000))

  it('maps each code point through the indexer', () => {
    expect(supertonicTokens('AB', indexer)).toEqual([1065, 1066])
  })

  it('gives -1 to characters beyond the table or unknown to it', () => {
    expect(supertonicTokens('A中\0', indexer)).toEqual([1065, -1, -1])
  })

  it('counts a character outside the BMP once', () => {
    expect(supertonicTokens('\u{1F600}', indexer)).toEqual([-1])
  })
})

describe('parseSupertonicConfig', () => {
  it('reads the audio and latent sizes', () => {
    expect(parseSupertonicConfig(CONFIG_JSON)).toEqual(CONFIG)
  })

  it('rejects an incomplete config', () => {
    expect(() => parseSupertonicConfig('{"ae":{"sample_rate":44100}}')).toThrow('incomplete')
  })
})

describe('parseSupertonicVoice', () => {
  const style = (dims: number[], data: unknown) => ({ dims, data, type: 'float32' })

  it('flattens the nested style data and keeps its shape', () => {
    const voice = parseSupertonicVoice(
      JSON.stringify({ style_ttl: style([1, 2, 2], [[[1, 2], [3, 4]]]), style_dp: style([1, 1, 3], [[[5, 6, 7]]]) })
    )
    expect(voice.ttl.dims).toEqual([1, 2, 2])
    expect(Array.from(voice.ttl.data)).toEqual([1, 2, 3, 4])
    expect(voice.dp.dims).toEqual([1, 1, 3])
    expect(Array.from(voice.dp.data)).toEqual([5, 6, 7])
  })

  it('rejects a style whose data does not fit its shape or that is missing', () => {
    expect(() => parseSupertonicVoice(JSON.stringify({ style_ttl: style([1, 2, 2], [[[1, 2]]]), style_dp: style([1], [[1]]) }))).toThrow('shape')
    expect(() => parseSupertonicVoice(JSON.stringify({ style_ttl: style([1], [1]) }))).toThrow('style_dp')
  })
})

describe('sampleNoisyLatent', () => {
  it('covers the duration in frames of 512 x 6 samples with 24 x 6 rows', () => {
    const { latent, mask, rows, frames } = sampleNoisyLatent(1, CONFIG, () => 0.5)
    expect(rows).toBe(144)
    expect(frames).toBe(Math.ceil(44100 / 3072))
    expect(latent).toHaveLength(rows * frames)
    expect(Array.from(mask)).toEqual(new Array(frames).fill(1))
  })

  it('draws standard normal noise with the Box-Muller transform', () => {
    const values = [0.5, 0.25]
    let index = 0
    const { latent } = sampleNoisyLatent(0.01, CONFIG, () => values[index++ % 2])
    expect(latent[0]).toBeCloseTo(Math.sqrt(-2 * Math.log(0.5)) * Math.cos(2 * Math.PI * 0.25))
  })

  it('always has at least one frame', () => {
    expect(sampleNoisyLatent(0, CONFIG).frames).toBe(1)
  })
})

describe('createSupertonicSynthesizer', () => {
  type Feeds = Record<string, { type: string; data: ArrayLike<number | bigint>; dims: number[] }>

  /** Graphs that record their inputs and answer with the shapes the real ones return. */
  function fakeRuntime(durationSeconds: number) {
    const calls: Array<{ graph: string; feeds: Feeds }> = []
    class Tensor {
      constructor(
        readonly type: string,
        readonly data: ArrayLike<number | bigint>,
        readonly dims: number[]
      ) {}
    }
    const graphs: Record<string, (feeds: Feeds) => Record<string, Tensor>> = {
      duration: () => ({ duration: new Tensor('float32', Float32Array.of(durationSeconds), [1]) }),
      encoder: () => ({ text_emb: new Tensor('float32', new Float32Array(4), [1, 1, 4]) }),
      estimator: (feeds) => ({ denoised_latent: new Tensor('float32', Float32Array.from(feeds.noisy_latent.data as Float32Array, (value) => value + 1), feeds.noisy_latent.dims) }),
      vocoder: (feeds) => ({ wav_tts: new Tensor('float32', new Float32Array(Math.round(44100 * 20)).fill(feeds.latent.data[0] as number), [1, 44100 * 20]) })
    }
    // Graphs are created in this order, so the nth session is that graph.
    const order = ['duration', 'encoder', 'estimator', 'vocoder']
    let created = 0
    const ort = {
      Tensor,
      InferenceSession: {
        create: async () => {
          const graph = order[created++]
          return { run: async (feeds: Feeds) => (calls.push({ graph, feeds }), graphs[graph](feeds)) }
        }
      }
    } as never
    return { ort, calls }
  }

  const files = (reads: string[]) => ({
    readGraph: async (graph: string) => (reads.push(graph), new Uint8Array()),
    config: CONFIG_JSON,
    indexer: JSON.stringify(Array.from({ length: 128 }, (_, index) => index))
  })
  const voice = parseSupertonicVoice(
    JSON.stringify({ style_ttl: { dims: [1, 1, 2], data: [[[1, 2]]] }, style_dp: { dims: [1, 1, 2], data: [[[3, 4]]] } })
  )

  it('loads the four graphs one at a time, in order', async () => {
    const { ort } = fakeRuntime(1)
    const reads: string[] = []
    await createSupertonicSynthesizer(ort, files(reads))
    expect(reads).toEqual(['durationPredictor', 'textEncoder', 'vectorEstimator', 'vocoder'])
  })

  it('predicts the duration, encodes the text, denoises step by step and trims to the duration', async () => {
    const { ort, calls } = fakeRuntime(2.1)
    const tts = await createSupertonicSynthesizer(ort, files([]), { random: () => 0.5 })
    expect(tts.sampleRate).toBe(44100)
    const audio = await tts.synthesize('Hi', voice, 1.05)

    const byGraph = (graph: string) => calls.filter((call) => call.graph === graph)
    const [duration] = byGraph('duration')
    expect(Array.from(duration.feeds.text_ids.data as BigInt64Array).map(Number)).toEqual(
      Array.from('<na>Hi.</na>', (character) => character.codePointAt(0))
    )
    expect(Array.from(duration.feeds.style_dp.data)).toEqual([3, 4])
    expect(byGraph('encoder')).toHaveLength(1)
    expect(Array.from(byGraph('encoder')[0].feeds.style_ttl.data)).toEqual([1, 2])

    const steps = byGraph('estimator')
    expect(steps).toHaveLength(SUPERTONIC_STEPS)
    expect(steps.map((call) => call.feeds.current_step.data[0])).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    expect(steps[0].feeds.total_step.data[0]).toBe(SUPERTONIC_STEPS)
    // Each step starts from the previous step's output (the fake adds one).
    expect(steps[1].feeds.noisy_latent.data[0]).toBeCloseTo((steps[0].feeds.noisy_latent.data[0] as number) + 1)
    // The speed shortens the predicted 2.1 s.
    expect(audio).toHaveLength(Math.floor((Math.fround(2.1) / 1.05) * 44100))
    expect(steps[0].feeds.noisy_latent.dims).toEqual([1, 144, Math.ceil((2 * 44100) / 3072)])
  })

  it('runs as many denoising steps as asked', async () => {
    const { ort, calls } = fakeRuntime(1)
    const tts = await createSupertonicSynthesizer(ort, files([]), { steps: 3 })
    await tts.synthesize('Hi', voice, 1)
    expect(calls.filter((call) => call.graph === 'estimator')).toHaveLength(3)
  })
})

describe('Supertonic 3 manifest', () => {
  it('is listed and can be found by id', () => {
    expect(LOCAL_TTS_MODELS).toContain(SUPERTONIC_3)
    expect(findLocalTtsModel('supertonic-3')).toBe(SUPERTONIC_3)
  })

  it('pins the archived revision under the OpenRAIL-M licence', () => {
    expect(SUPERTONIC_3.repo).toBe('supertone-oss-archive/supertonic-3')
    expect(SUPERTONIC_3.revision).toBe('aafc6e32416a594460b32413efc49d7fe4ce6d46')
    expect(SUPERTONIC_3.license).toBe('OpenRAIL-M')
    expect(SUPERTONIC_3.description).toBe('31 languages')
  })

  it('lists the graphs and tables its runtime reads as required files', () => {
    const files = new Map(SUPERTONIC_3.files.map((file) => [file.path, file]))
    for (const path of [
      SUPERTONIC_3.durationPredictor,
      SUPERTONIC_3.textEncoder,
      SUPERTONIC_3.vectorEstimator,
      SUPERTONIC_3.vocoder,
      SUPERTONIC_3.config,
      SUPERTONIC_3.indexer
    ]) {
      expect(files.get(path)?.sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(files.get(path)?.optional).toBeUndefined()
    }
  })

  it('has ten voices, each a style file, and only the default one is required', () => {
    expect(SUPERTONIC_3.voices.map((voice) => voice.id)).toEqual(['F1', 'F2', 'F3', 'F4', 'F5', 'M1', 'M2', 'M3', 'M4', 'M5'])
    expect(SUPERTONIC_3.voices[0]).toEqual({ id: 'F1', label: 'F1, female' })
    expect(SUPERTONIC_3.voices[9]).toEqual({ id: 'M5', label: 'M5, male' })
    const styles = SUPERTONIC_3.files.filter((file) => file.path.startsWith(`${SUPERTONIC_3.voiceStyles}/`))
    expect(styles.map((file) => file.path)).toEqual(SUPERTONIC_3.voices.map((voice) => `${SUPERTONIC_3.voiceStyles}/${voice.id}.json`))
    expect(styles.filter((file) => !file.optional).map((file) => file.path)).toEqual([`${SUPERTONIC_3.voiceStyles}/${SUPERTONIC_3.defaultVoice}.json`])
  })
})
