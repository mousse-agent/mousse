import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { LlmProviderOption } from '../src/shared/settings'
import { MOONSHINE_BASE, isSttModelId, sttModelsFromProviders } from '../src/shared/dictation'
import { insertTranscript } from '../src/renderer/dictation/insertTranscript'
import {
  loadDictationSelection,
  parseDictationSelection,
  sameDictationSelection,
  saveDictationSelection
} from '../src/renderer/dictation/selection'

const provider = (id: string, models: string[]): LlmProviderOption =>
  ({ id, label: id.toUpperCase(), models: models.map((model) => ({ id: model, label: `${model} label` })) }) as unknown as LlmProviderOption

describe('isSttModelId', () => {
  it.each(['whisper-1', 'gpt-4o-transcribe', 'gpt-4o-mini-transcribe-2025-03-20', 'whisper-large-v3-turbo', 'distil-whisper-large-v3-en'])(
    'accepts %s',
    (id) => expect(isSttModelId(id)).toBe(true)
  )
  it.each(['gpt-4o', 'tts-1', 'gpt-4o-transcribe-diarize', 'text-embedding-3-small'])('rejects %s', (id) =>
    expect(isSttModelId(id)).toBe(false)
  )
})

describe('sttModelsFromProviders', () => {
  it('keeps speech-to-text models of providers that can transcribe', () => {
    const models = sttModelsFromProviders([
      provider('openai', ['gpt-4o', 'whisper-1', 'gpt-4o-transcribe', 'gpt-4o-transcribe-diarize', 'tts-1']),
      provider('groq', ['whisper-large-v3', 'llama-3.3-70b']),
      provider('anthropic', ['whisper-1'])
    ])
    expect(models.map((model) => `${model.providerId}:${model.modelId}`)).toEqual([
      'openai:whisper-1',
      'openai:gpt-4o-transcribe',
      'groq:whisper-large-v3'
    ])
    expect(models[0]).toMatchObject({ providerLabel: 'OPENAI', label: 'whisper-1 label' })
  })

  it('returns nothing when no provider lists a speech-to-text model', () => {
    expect(sttModelsFromProviders([provider('openai', ['gpt-4o'])])).toEqual([])
  })
})

describe('dictation selection storage', () => {
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
    const remote = { source: 'provider', providerId: 'openai', modelId: 'whisper-1', label: 'OpenAI · whisper-1' } as const
    const local = { source: 'local', modelId: MOONSHINE_BASE.id, label: MOONSHINE_BASE.label } as const
    saveDictationSelection('alice', remote)
    saveDictationSelection('bob', local)
    expect(loadDictationSelection('alice')).toEqual(remote)
    expect(loadDictationSelection('bob')).toEqual(local)
    expect(loadDictationSelection('carol')).toBeNull()
    expect([...store.keys()].some((key) => key.includes('alice') && key.endsWith('dictationModel'))).toBe(true)
  })

  it('clears the saved value when saving null', () => {
    saveDictationSelection('alice', { source: 'local', modelId: 'moonshine-base', label: 'x' })
    saveDictationSelection('alice', null)
    expect(store.size).toBe(0)
  })

  it('drops unknown local ids and malformed values', () => {
    expect(parseDictationSelection({ source: 'local', modelId: 'missing-model', label: 'x' })).toBeNull()
    expect(parseDictationSelection({ source: 'provider', providerId: 'openai' })).toBeNull()
    expect(parseDictationSelection({ source: 'provider', providerId: 'anthropic', modelId: 'whisper-1', label: 'x' })).toBeNull()
    expect(parseDictationSelection({ source: 'provider', providerId: 'openai', modelId: 'tts-1', label: 'x' })).toBeNull()
    expect(parseDictationSelection({ source: 'cloud' })).toBeNull()
    expect(parseDictationSelection('local')).toBeNull()
    expect(parseDictationSelection(null)).toBeNull()
    store.set('mousse-profile-alice-dictationModel', '{not json')
    expect(loadDictationSelection('alice')).toBeNull()
  })

  it('takes the label of a local model from the catalog', () => {
    expect(parseDictationSelection({ source: 'local', modelId: 'moonshine-base', label: 'spoofed' })).toEqual({
      source: 'local',
      modelId: 'moonshine-base',
      label: MOONSHINE_BASE.label
    })
  })

  it('compares selections by source and model', () => {
    const a = { source: 'provider', providerId: 'openai', modelId: 'whisper-1', label: 'a' } as const
    expect(sameDictationSelection(a, { ...a, label: 'b' })).toBe(true)
    expect(sameDictationSelection(a, { ...a, providerId: 'groq' })).toBe(false)
    expect(sameDictationSelection(a, { source: 'local', modelId: 'moonshine-base', label: 'a' })).toBe(false)
    expect(sameDictationSelection(null, null)).toBe(true)
    expect(sameDictationSelection(a, null)).toBe(false)
  })
})

describe('insertTranscript', () => {
  it('appends to an empty box without padding', () => {
    expect(insertTranscript('', 0, 0, ' hello world ')).toEqual({ value: 'hello world', caret: 11 })
  })

  it('separates the text from a preceding word', () => {
    expect(insertTranscript('Fix the bug', 11, 11, 'in the parser')).toEqual({ value: 'Fix the bug in the parser', caret: 25 })
  })

  it('does not double an existing space or newline', () => {
    expect(insertTranscript('Fix ', 4, 4, 'it').value).toBe('Fix it')
    expect(insertTranscript('Fix\n', 4, 4, 'it').value).toBe('Fix\nit')
  })

  it('inserts at the caret and keeps the text after it apart', () => {
    expect(insertTranscript('Fix the parser', 7, 7, 'big')).toEqual({ value: 'Fix the big parser', caret: 11 })
    expect(insertTranscript('Fix the parser', 3, 3, 'it now')).toEqual({ value: 'Fix it now the parser', caret: 10 })
  })

  it('replaces the selection', () => {
    expect(insertTranscript('Fix the bug today', 8, 11, 'crash')).toEqual({ value: 'Fix the crash today', caret: 13 })
  })

  it('leaves the box alone for an empty transcript and clamps bad offsets', () => {
    expect(insertTranscript('abc', 1, 2, '  ')).toEqual({ value: 'abc', caret: 2 })
    expect(insertTranscript('abc', 99, 120, 'd')).toEqual({ value: 'abc d', caret: 5 })
  })
})
