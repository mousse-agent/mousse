import { strToU8, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { phonemizeKeepingPunctuation } from '../src/renderer/readAloud/espeakPhonemes'
import {
  KITTEN_SAMPLE_RATE,
  createKittenSynthesizer,
  kittenChunks,
  kittenStyle,
  kittenTokens,
  parseKittenConfig
} from '../src/renderer/readAloud/kittenTts'
import { KITTEN_TTS_MICRO, KITTEN_TTS_MINI, KITTEN_TTS_NANO, LOCAL_TTS_MODELS, findLocalTtsModel } from '../src/shared/readAloud'

describe('kittenChunks', () => {
  it('splits sentences, drops their end marks and closes each with a comma', () => {
    expect(kittenChunks('Hello. World! Yes?? Fine')).toEqual(['Hello,', 'World,', 'Yes,', 'Fine,'])
  })

  it('keeps commas, semicolons and colons a piece already ends with', () => {
    expect(kittenChunks('First, second; third: fourth.')).toEqual(['First, second; third: fourth,'])
    expect(kittenChunks('Wait,. Go')).toEqual(['Wait,', 'Go,'])
  })

  it('does not split at a dot inside a word or number', () => {
    expect(kittenChunks('It cost 4.99 on shop.example.com today. Next')).toEqual(['It cost 4.99 on shop.example.com today,', 'Next,'])
  })

  it('splits a very long sentence at word boundaries of at most 400 characters', () => {
    const text = Array.from({ length: 200 }, (_, index) => `word${index}`).join(' ')
    const chunks = kittenChunks(text)
    expect(chunks.length).toBeGreaterThan(2)
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(401)
    expect(chunks.map((chunk) => chunk.replace(/,$/, '')).join(' ')).toBe(text)
  })

  it('returns nothing for empty text', () => {
    expect(kittenChunks('  ')).toEqual([])
    expect(kittenChunks('...')).toEqual([])
  })
})

describe('kittenTokens', () => {
  // Expected ids come from running upstream's TextCleaner and tokenizer on the same strings.
  it.each([
    ['həlˈoʊ, wˈɜːld!', [0, 50, 83, 54, 156, 57, 135, 16, 3, 16, 65, 156, 87, 158, 54, 46, 16, 5, 10, 0]],
    ['ɪts θɹˈiː pɔɪnt wˈʌn', [0, 102, 62, 61, 16, 119, 123, 156, 51, 158, 16, 58, 76, 102, 56, 62, 16, 65, 156, 138, 56, 10, 0]],
    ['sˈɛd (x) {y}', [0, 61, 156, 86, 46, 16, 16, 66, 16, 16, 16, 67, 16, 10, 0]],
    [
      'ðɪs ɪz ɐ tˈɛst: "ˈoʊkeɪ" — ɡʊd…',
      [0, 81, 102, 61, 16, 102, 68, 16, 70, 16, 62, 156, 86, 61, 62, 16, 2, 16, 15, 16, 156, 57, 135, 53, 47, 102, 16, 15, 16, 9, 16, 92, 135, 46, 16, 10, 10, 0]
    ]
  ])('maps %s to the ids upstream produces', (phonemes, ids) => {
    expect(kittenTokens(phonemes)).toEqual(ids)
  })

  it('frames an empty string with the pad and end ids', () => {
    expect(kittenTokens('')).toEqual([0, 10, 0])
  })
})

describe('kittenStyle', () => {
  const matrix = { shape: [3, 4], data: Float32Array.from({ length: 12 }, (_, index) => index) }

  it('picks the row for the text length', () => {
    expect(Array.from(kittenStyle(matrix, 1))).toEqual([4, 5, 6, 7])
  })

  it('uses the last row for longer text', () => {
    expect(Array.from(kittenStyle(matrix, 400))).toEqual([8, 9, 10, 11])
  })
})

describe('parseKittenConfig', () => {
  it('reads voice aliases and speed priors', () => {
    const config = parseKittenConfig(
      JSON.stringify({ voice_aliases: { Bella: 'expr-voice-2-f', Odd: 7 }, speed_priors: { 'expr-voice-2-f': 0.8, bad: 'x', zero: 0 } })
    )
    expect(config).toEqual({ voiceAliases: { Bella: 'expr-voice-2-f' }, speedPriors: { 'expr-voice-2-f': 0.8 } })
  })

  it('accepts a config without either table', () => {
    expect(parseKittenConfig('{}')).toEqual({ voiceAliases: {}, speedPriors: {} })
  })
})

describe('phonemizeKeepingPunctuation', () => {
  it('phonemizes the text between punctuation and keeps the punctuation', async () => {
    const seen: string[] = []
    const result = await phonemizeKeepingPunctuation('Hello, world! (yes)', 'en-us', async (text, language) => {
      seen.push(`${language}:${text}`)
      return [`<${text.trim()}>`]
    })
    expect(seen).toEqual(['en-us:Hello', 'en-us:world', 'en-us:yes'])
    expect(result).toBe('<Hello>, <world>! (<yes>)')
  })
})

describe('createKittenSynthesizer', () => {
  /** An ONNX runtime that records its inputs and answers with a constant waveform. */
  function fakeRuntime(samples: number) {
    const runs: Array<Record<string, { type: string; data: ArrayLike<unknown>; dims: number[] }>> = []
    class Tensor {
      constructor(
        readonly type: string,
        readonly data: ArrayLike<unknown>,
        readonly dims: number[]
      ) {}
    }
    const session = {
      outputNames: ['waveform'],
      run: async (feeds: Record<string, Tensor>) => {
        runs.push(feeds)
        return { waveform: new Tensor('float32', new Float32Array(samples).fill(0.5), [samples]) }
      }
    }
    return { runs, ort: { Tensor, InferenceSession: { create: async () => session } } as never }
  }

  function voices(): Uint8Array {
    const header = "{'descr': '<f4', 'fortran_order': False, 'shape': (2, 256), }"
    const text = header.padEnd(118, ' ') + '\n'
    const file = new Uint8Array(10 + text.length + 2 * 256 * 4)
    file.set([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59, 1, 0])
    new DataView(file.buffer).setUint16(8, text.length, true)
    file.set(strToU8(text), 10)
    const view = new DataView(file.buffer)
    for (let index = 0; index < 512; index += 1) view.setFloat32(10 + text.length + index * 4, index < 256 ? 1 : 2, true)
    return zipSync({ 'expr-voice-2-f.npy': [file, { level: 0 }] })
  }

  const config = JSON.stringify({ voice_aliases: { Bella: 'expr-voice-2-f' }, speed_priors: { 'expr-voice-2-f': 0.8 } })
  const phonemize = async (text: string): Promise<string[]> => [text.toLowerCase()]

  it('runs one pass per sentence with tokens, a style row by length and the voice speed prior', async () => {
    const { runs, ort } = fakeRuntime(KITTEN_SAMPLE_RATE)
    const kitten = await createKittenSynthesizer(ort, { model: new Uint8Array(), config, voices: voices() }, { phonemize })
    const audio = await kitten.synthesize('Hi. Ok', 'Bella', 1.5)

    expect(runs).toHaveLength(2)
    const first = runs[0]
    expect(first.input_ids.type).toBe('int64')
    expect(first.input_ids.dims).toEqual([1, first.input_ids.data.length])
    expect(Array.from(first.input_ids.data as BigInt64Array).map(Number)).toEqual(kittenTokens('hi,'))
    // "Hi," is 3 characters, so row 1 of the matrix (all 2s) is used.
    expect(first.style.dims).toEqual([1, 256])
    expect(Array.from(first.style.data as Float32Array).every((value) => value === 2)).toBe(true)
    expect(first.speed.data[0]).toBeCloseTo(1.2)
    // Each pass loses its last 5000 samples; the two are joined with a short gap.
    expect(audio.length).toBe(2 * (KITTEN_SAMPLE_RATE - 5000) + Math.round(0.1 * KITTEN_SAMPLE_RATE))
  })

  it('spells numbers out before voicing them', async () => {
    const { runs, ort } = fakeRuntime(10_000)
    const kitten = await createKittenSynthesizer(ort, { model: new Uint8Array(), config, voices: voices() }, { phonemize })
    await kitten.synthesize('Pay $5 now', 'Bella', 1)
    expect(Array.from(runs[0].input_ids.data as BigInt64Array).map(Number)).toEqual(kittenTokens('pay five dollars now,'))
  })

  it('accepts a voice by its name in voices.npz and rejects an unknown voice', async () => {
    const { ort } = fakeRuntime(10_000)
    const kitten = await createKittenSynthesizer(ort, { model: new Uint8Array(), config, voices: voices() }, { phonemize })
    await expect(kitten.synthesize('Hi', 'expr-voice-2-f', 1)).resolves.toBeInstanceOf(Float32Array)
    await expect(kitten.synthesize('Hi', 'Nobody', 1)).rejects.toThrow('no voice named Nobody')
  })
})

describe('Kitten TTS manifests', () => {
  const models = [KITTEN_TTS_MINI, KITTEN_TTS_MICRO, KITTEN_TTS_NANO]

  it('are listed after Kokoro and can be found by id', () => {
    expect(LOCAL_TTS_MODELS.slice(0, 4).map((model) => model.id)).toEqual(['kokoro-82m', 'kitten-tts-mini', 'kitten-tts-micro', 'kitten-tts-nano'])
    for (const model of models) expect(findLocalTtsModel(model.id)).toBe(model)
  })

  it.each(models.map((model) => [model.id, model] as const))('%s pins a revision and lists the files its runtime reads', (_id, model) => {
    expect(model.runtime).toBe('kitten')
    expect(model.revision).toMatch(/^[0-9a-f]{40}$/)
    expect(model.license).toBe('Apache-2.0')
    const paths = new Map(model.files.map((file) => [file.path, file]))
    for (const path of [model.config, model.model, model.voicesFile]) {
      expect(paths.get(path)?.sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(paths.get(path)?.optional).toBeUndefined()
    }
    expect(model.files).toHaveLength(3)
    expect(model.voices.map((voice) => voice.id)).toEqual(['Bella', 'Jasper', 'Luna', 'Bruno', 'Rosie', 'Hugo', 'Kiki', 'Leo'])
    expect(model.voices[0].label).toBe('Bella, female')
    expect(model.voices.some((voice) => voice.id === model.defaultVoice)).toBe(true)
  })

  it('use the nano int8 build for Nano', () => {
    expect(KITTEN_TTS_NANO.repo).toBe('KittenML/kitten-tts-nano-0.8-int8')
  })
})
