import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import type { DictationSelection } from '../../src/shared/dictation'
import type { ReadAloudSelection } from '../../src/shared/readAloud'
import { KOKORO_82M } from '../../src/shared/readAloud'
import { useDictationStore } from '../../src/renderer/dictation/dictationStore'
import { useReadAloudStore } from '../../src/renderer/readAloud/readAloudStore'
import { DEFAULT_SPEECH_PREFERENCES, useSpeechPreferences } from '../../src/renderer/speech/speechPreferences'
import { SpeechSettings } from '../../src/renderer/speech/SpeechSettings'

// Server rendering reads a store's initial state, so the seeds go there.
const readAloudInitial = { ...useReadAloudStore.getInitialState() }
const dictationInitial = { ...useDictationStore.getInitialState() }
const preferencesInitial = { ...useSpeechPreferences.getInitialState() }
afterEach(() => {
  Object.assign(useReadAloudStore.getInitialState(), readAloudInitial)
  Object.assign(useDictationStore.getInitialState(), dictationInitial)
  Object.assign(useSpeechPreferences.getInitialState(), preferencesInitial)
})

const render = ({
  readAloud = null,
  dictation = null,
  terms = 0
}: { readAloud?: ReadAloudSelection | null; dictation?: DictationSelection | null; terms?: number } = {}): string => {
  Object.assign(useReadAloudStore.getInitialState(), { selection: readAloud })
  Object.assign(useDictationStore.getInitialState(), { selection: dictation })
  const vocabulary = Array.from({ length: terms }, (_, index) => ({ term: `Term${index}`, soundsLike: [] }))
  Object.assign(useSpeechPreferences.getInitialState(), { preferences: { ...DEFAULT_SPEECH_PREFERENCES, vocabulary } })
  return renderToStaticMarkup(createElement(SpeechSettings))
}

const kokoro: ReadAloudSelection = { source: 'local', modelId: KOKORO_82M.id, label: KOKORO_82M.label }
const parakeet: DictationSelection = { source: 'local', modelId: 'parakeet-tdt-110m', label: 'Parakeet' }
const whisper: DictationSelection = { source: 'local', modelId: 'whisper-base', label: 'Whisper' }

describe('Settings, Speech: rows that need a model', () => {
  it('shows only the model rows before any model is chosen', () => {
    const html = render({ terms: 2 })
    for (const title of ['Voice', 'Play sample', 'Speed', 'Reduce background noise', 'Vocabulary']) expect(html).not.toContain(title)
  })

  it('reveals voice, sample and speed for a model that offers voices', () => {
    const html = render({ readAloud: kokoro })
    expect(html).toContain('Voice')
    expect(html).toContain('aria-label="Play sample"')
    expect(html).toContain('Speed')
  })

  it('keeps speed but no voice or sample for a model without voices', () => {
    const html = render({ readAloud: { source: 'provider', providerId: 'unknown', modelId: 'tts', label: 'TTS' } })
    expect(html).not.toContain('Voice')
    expect(html).not.toContain('sample')
    expect(html).toContain('Speed')
  })

  it('shows the vocabulary beside a dictation model that uses it', () => {
    const html = render({ dictation: parakeet, terms: 1 })
    expect(html).toContain('Vocabulary')
    expect(html).toContain('1 term')
    expect(html).toContain('Reduce background noise')
    // The vocabulary row comes straight after the model.
    expect(html.indexOf('Vocabulary')).toBeLessThan(html.indexOf('Reduce background noise'))
  })

  it('does not offer the vocabulary for a model that ignores it, and says so when terms are saved', () => {
    const saved = render({ dictation: whisper, terms: 2 })
    expect(saved).not.toContain('Vocabulary')
    expect(saved).toContain('use your vocabulary. Parakeet models do.')
    expect(saved).toContain('Reduce background noise')
    // The saved terms are untouched.
    expect(useSpeechPreferences.getInitialState().preferences.vocabulary).toHaveLength(2)

    const none = render({ dictation: whisper })
    expect(none).not.toContain('Vocabulary')
    expect(none).not.toContain('use your vocabulary')
  })
})
