import { describe, expect, it } from 'vitest'
import { detectWhisperLanguage, transcribeWhisper, type WhisperParts } from '../src/renderer/dictation/whisperRecognizer'

const LANG_TO_ID = { '<|en|>': 3, '<|fr|>': 4, '<|de|>': 5, '<|yue|>': 6, '<|transcribe|>': 1, '<|notimestamps|>': 2 }

describe('detectWhisperLanguage', () => {
  it('picks the language token with the highest score', () => {
    expect(detectWhisperLanguage([0, 9, 9, 0.1, 0.8, 0.3, 0.2], LANG_TO_ID)).toBe('fr')
    expect(detectWhisperLanguage([0, 0, 0, 0.9, 0.8, 0.3, 0.2], LANG_TO_ID)).toBe('en')
    expect(detectWhisperLanguage([0, 0, 0, 0, 0, 0, 0.5], LANG_TO_ID)).toBe('yue')
  })

  it('ignores task tokens even when they score higher, and ids outside the logits', () => {
    expect(detectWhisperLanguage([0, 100, 100, 0.1, 0.2], LANG_TO_ID)).toBe('fr')
    expect(detectWhisperLanguage([0, 0, 0, 0.1], LANG_TO_ID)).toBe('en')
  })

  it('returns nothing when there are no language tokens', () => {
    expect(detectWhisperLanguage([1, 2, 3], {})).toBeUndefined()
  })
})

describe('transcribeWhisper', () => {
  function fakeParts(languageScores: number[]) {
    const calls: Array<[string, unknown]> = []
    const features = { name: 'features' }
    const encoderOutputs = { name: 'encoder-outputs' }
    const parts: WhisperParts = {
      processor: async (samples) => {
        calls.push(['processor', samples.length])
        return { input_features: features }
      },
      model: {
        generation_config: { decoder_start_token_id: 50258, lang_to_id: LANG_TO_ID },
        _prepare_encoder_decoder_kwargs_for_generation: async (options) => {
          calls.push(['encode', options.inputs_tensor])
          return { encoder_outputs: encoderOutputs }
        },
        forward: async (inputs) => {
          calls.push(['detect', { encoder: inputs.encoder_outputs, start: inputs.decoder_input_ids }])
          return { logits: { data: languageScores, dims: [1, 1, languageScores.length] } }
        },
        generate: async (options) => {
          calls.push(['generate', options])
          return ['tokens']
        }
      },
      tokenizer: {
        batch_decode: (tokens, options) => {
          calls.push(['decode', { tokens, options }])
          return [' Bonjour tout le monde. ']
        }
      },
      startTokens: (id) => ({ start: id })
    }
    return { parts, calls, features, encoderOutputs }
  }

  it('encodes once, detects the language from the start token and decodes in that language as plain text', async () => {
    const { parts, calls, features, encoderOutputs } = fakeParts([0, 0, 0, 0.1, 0.9, 0.2, 0.1])
    const text = await transcribeWhisper(parts, new Float32Array(16000))
    expect(text).toBe(' Bonjour tout le monde. ')
    expect(calls.map(([name]) => name)).toEqual(['processor', 'encode', 'detect', 'generate', 'decode'])
    expect(calls[1][1]).toBe(features)
    expect(calls[2][1]).toEqual({ encoder: encoderOutputs, start: { start: 50258 } })
    const generate = calls[3][1] as Record<string, unknown>
    expect(generate).toMatchObject({ inputs: features, language: 'fr', task: 'transcribe', return_timestamps: false })
    // The encoder result is reused, not recomputed.
    expect(generate.encoder_outputs).toBe(encoderOutputs)
    expect(calls[4][1]).toEqual({ tokens: ['tokens'], options: { skip_special_tokens: true } })
  })

  it('never forces English: the language comes from the detection alone', async () => {
    const { parts, calls } = fakeParts([0, 0, 0, 0.1, 0.2, 0.9, 0.1])
    await transcribeWhisper(parts, new Float32Array(16000))
    expect((calls.find(([name]) => name === 'generate')![1] as { language: string }).language).toBe('de')
  })
})
