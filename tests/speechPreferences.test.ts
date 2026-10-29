import { describe, expect, it } from 'vitest'
import { KOKORO_82M, providerTtsVoice, providerTtsVoices, resolveProviderTtsVoice } from '../src/shared/readAloud'
import {
  DEFAULT_SPEECH_PREFERENCES,
  parseSpeechPreferences,
  readAloudVoiceKey,
  voiceFor
} from '../src/renderer/speech/speechPreferences'

const local = { source: 'local', modelId: 'kokoro-82m', label: 'Kokoro 82M' } as const
const openai = { source: 'provider', providerId: 'openai', modelId: 'gpt-4o-mini-tts', label: 'GPT-4o mini TTS' } as const

describe('parseSpeechPreferences', () => {
  it('fills in defaults for missing or malformed values', () => {
    expect(parseSpeechPreferences(null)).toEqual(DEFAULT_SPEECH_PREFERENCES)
    expect(parseSpeechPreferences({ speed: 9, voices: { a: 3, b: 'x' }, reduceNoise: 'no', vocabulary: 'x', expandSymbols: 1 })).toEqual({
      ...DEFAULT_SPEECH_PREFERENCES,
      voices: { b: 'x' }
    })
  })

  it('keeps supported values, including an emptied vocabulary', () => {
    expect(
      parseSpeechPreferences({
        speed: 1.5,
        voices: { 'local:kokoro-82m': 'bm_george' },
        reduceNoise: false,
        vocabulary: [{ spoken: ' gh-rysp ', written: 'gh-ryspa' }, { spoken: '', written: 'x' }, 'junk'],
        expandSymbols: false,
        detectLists: false
      })
    ).toEqual({
      speed: 1.5,
      voices: { 'local:kokoro-82m': 'bm_george' },
      reduceNoise: false,
      vocabulary: [{ spoken: 'gh-rysp', written: 'gh-ryspa' }],
      expandSymbols: false,
      detectLists: false
    })
    expect(parseSpeechPreferences({ vocabulary: [] }).vocabulary).toEqual([])
  })
})

describe('voiceFor', () => {
  it('uses the saved voice of each model and falls back to the default', () => {
    const preferences = parseSpeechPreferences({
      voices: { [readAloudVoiceKey(local)]: 'bm_george', [readAloudVoiceKey(openai)]: 'nope' }
    })
    expect(voiceFor(preferences, local)).toBe('bm_george')
    expect(voiceFor(preferences, openai)).toBe('alloy')
    expect(voiceFor(DEFAULT_SPEECH_PREFERENCES, local)).toBe(KOKORO_82M.defaultVoice)
  })
})

describe('voices', () => {
  it('ships a verified file for every Kokoro voice', () => {
    const paths = new Set(KOKORO_82M.files.map((file) => file.path))
    expect(KOKORO_82M.voices).toHaveLength(28)
    for (const voice of KOKORO_82M.voices) expect(paths).toContain(`voices/${voice.id}.bin`)
    expect(KOKORO_82M.voices[0]).toEqual({ id: 'af_heart', label: 'Heart, American female' })
    // Only the default voice is needed for the model to count as downloaded.
    const required = KOKORO_82M.files.filter((file) => file.path.startsWith('voices/') && !file.optional)
    expect(required.map((file) => file.path)).toEqual([`voices/${KOKORO_82M.defaultVoice}.bin`])
  })

  it('lists provider voices per model and keeps the old defaults', () => {
    expect(providerTtsVoices('openai', 'gpt-4o-mini-tts')).toContain('marin')
    expect(providerTtsVoices('openai', 'tts-1')).not.toContain('marin')
    expect(providerTtsVoice('groq', 'playai-tts')).toBe('Fritz-PlayAI')
    expect(providerTtsVoice('groq', 'playai-tts-arabic')).toBe('Ahmad-PlayAI')
    expect(providerTtsVoice('groq', 'canopylabs/orpheus-v1-english')).toBe('troy')
    expect(providerTtsVoices('anthropic', 'tts-1')).toEqual([])
    expect(resolveProviderTtsVoice('groq', 'canopylabs/orpheus-v1-english', 'diana')).toBe('diana')
  })
})
