import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { LlmProviderOption } from '../src/shared/settings'
import { KOKORO_82M, isTtsModelId, ttsModelsFromProviders } from '../src/shared/readAloud'
import { splitSpeechChunks } from '../src/renderer/readAloud/speechText'
import { loadReadAloudSelection, parseReadAloudSelection, saveReadAloudSelection } from '../src/renderer/readAloud/selection'

const provider = (id: string, models: string[]): LlmProviderOption =>
  ({ id, label: id.toUpperCase(), models: models.map((model) => ({ id: model, label: `${model} label` })) }) as unknown as LlmProviderOption

describe('isTtsModelId', () => {
  it.each(['tts-1', 'tts-1-hd', 'gpt-4o-mini-tts', 'gpt-4o-mini-tts-2025-03-20', 'playai-tts', 'canopylabs/orpheus-v1-english'])(
    'accepts %s',
    (id) => expect(isTtsModelId(id)).toBe(true)
  )
  it.each(['gpt-4o', 'whisper-1', 'o3', 'text-embedding-3-small'])('rejects %s', (id) => expect(isTtsModelId(id)).toBe(false))
})

describe('ttsModelsFromProviders', () => {
  it('keeps TTS models of providers that can synthesize speech', () => {
    const models = ttsModelsFromProviders([
      provider('openai', ['gpt-4o', 'tts-1', 'gpt-4o-mini-tts', 'whisper-1']),
      provider('groq', ['playai-tts', 'llama-3.3-70b']),
      provider('anthropic', ['tts-1'])
    ])
    expect(models.map((model) => `${model.providerId}:${model.modelId}`)).toEqual([
      'openai:tts-1',
      'openai:gpt-4o-mini-tts',
      'groq:playai-tts'
    ])
    expect(models[0]).toMatchObject({ providerLabel: 'OPENAI', label: 'tts-1 label' })
  })

  it('returns nothing when no provider lists a TTS model', () => {
    expect(ttsModelsFromProviders([provider('openai', ['gpt-4o'])])).toEqual([])
  })
})

describe('splitSpeechChunks', () => {
  it('returns one chunk when the text fits', () => {
    expect(splitSpeechChunks('One. Two.\n\nThree.', 100)).toEqual(['One. Two.\n\nThree.'])
  })

  it('packs whole sentences and never exceeds the limit', () => {
    const text = Array.from({ length: 30 }, (_, i) => `Sentence number ${i} is here.`).join(' ')
    const chunks = splitSpeechChunks(text, 100)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(100)
      expect(chunk.endsWith('.')).toBe(true)
    }
    expect(chunks.join(' ')).toBe(text)
  })

  it('splits a sentence longer than the limit at words, then hard cuts a long token', () => {
    const words = splitSpeechChunks('alpha beta gamma delta epsilon', 12)
    expect(words).toEqual(['alpha beta', 'gamma delta', 'epsilon'])
    const hard = splitSpeechChunks('x'.repeat(25), 10)
    expect(hard).toEqual(['x'.repeat(10), 'x'.repeat(10), 'x'.repeat(5)])
  })

  it('prefers paragraph boundaries when a chunk must break', () => {
    const chunks = splitSpeechChunks('First paragraph here.\n\nSecond paragraph here.', 30)
    expect(chunks).toEqual(['First paragraph here.', 'Second paragraph here.'])
  })

  it('returns no chunks for empty text', () => {
    expect(splitSpeechChunks('  \n\n ', 100)).toEqual([])
  })
})

describe('read aloud selection storage', () => {
  const store = new Map<string, string>()
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')

  beforeEach(() => {
    store.clear()
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => void store.set(key, value),
        removeItem: (key: string) => void store.delete(key)
      }
    })
  })

  afterEach(() => {
    if (original) Object.defineProperty(globalThis, 'localStorage', original)
    else delete (globalThis as { localStorage?: unknown }).localStorage
  })

  it('round-trips a provider and a local selection per profile', () => {
    const provider = { source: 'provider', providerId: 'openai', modelId: 'tts-1', label: 'OpenAI · tts-1' } as const
    const local = { source: 'local', modelId: KOKORO_82M.id, label: KOKORO_82M.label } as const
    saveReadAloudSelection('alice', provider)
    saveReadAloudSelection('bob', local)
    expect(loadReadAloudSelection('alice')).toEqual(provider)
    expect(loadReadAloudSelection('bob')).toEqual(local)
    expect(loadReadAloudSelection('carol')).toBeNull()
    expect([...store.keys()].some((key) => key.includes('alice') && key.endsWith('readAloudModel'))).toBe(true)
  })

  it('clears the saved value when saving null', () => {
    saveReadAloudSelection('alice', { source: 'local', modelId: 'kokoro-82m', label: 'x' })
    saveReadAloudSelection('alice', null)
    expect(store.size).toBe(0)
  })

  it('drops unknown local ids and malformed values', () => {
    expect(parseReadAloudSelection({ source: 'local', modelId: 'missing-model', label: 'x' })).toBeNull()
    expect(parseReadAloudSelection({ source: 'provider', providerId: 'openai' })).toBeNull()
    expect(parseReadAloudSelection({ source: 'provider', providerId: 'anthropic', modelId: 'tts-1', label: 'x' })).toBeNull()
    expect(parseReadAloudSelection({ source: 'cloud' })).toBeNull()
    expect(parseReadAloudSelection('local')).toBeNull()
    expect(parseReadAloudSelection(null)).toBeNull()
    store.set('mousse-profile-alice-readAloudModel', '{not json')
    expect(loadReadAloudSelection('alice')).toBeNull()
  })

  it('takes the label of a local model from the catalog', () => {
    expect(parseReadAloudSelection({ source: 'local', modelId: 'kokoro-82m', label: 'spoofed' })).toEqual({
      source: 'local',
      modelId: 'kokoro-82m',
      label: KOKORO_82M.label
    })
  })
})
