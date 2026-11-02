import { create } from 'zustand'
import {
  DEFAULT_DICTATION_VOCABULARY,
  type DictationPolishOptions,
  type DictationVocabularyEntry
} from '../../shared/dictationPostProcess'
import { findLocalTtsModel, resolveProviderTtsVoice, type ReadAloudSelection } from '../../shared/readAloud'
import { profilePreferenceKey } from '../lib/profilePreferences'
import { useAppStore } from '../stores/appStore'

/** How read aloud sounds and how dictation records, per profile (Settings, Speech). */
export interface SpeechPreferences {
  /** Read aloud pace; 1 is the model's normal speed. */
  speed: number
  /** Voice chosen for each read aloud model, keyed by `readAloudVoiceKey`. */
  voices: Record<string, string>
  /** Dictation runs the microphone through noise suppression before the model hears it. */
  reduceNoise: boolean
  /** Words the dictation model keeps mishearing, and their spelling. */
  vocabulary: DictationVocabularyEntry[]
  /** Dictation writes spoken paths and numbers as symbols: "dot dot slash" is ../, "five point five" is 5.5. */
  expandSymbols: boolean
  /** Dictation writes "point number one ... point number two ..." as a numbered list. */
  detectLists: boolean
}

export const SPEECH_SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2] as const

export const DEFAULT_SPEECH_PREFERENCES: SpeechPreferences = {
  speed: 1,
  voices: {},
  reduceNoise: true,
  vocabulary: [...DEFAULT_DICTATION_VOCABULARY],
  expandSymbols: true,
  detectLists: true
}

const PREFERENCE_NAME = 'speech'

/** Fills in defaults and drops values Mousse cannot use. */
export function parseSpeechPreferences(value: unknown): SpeechPreferences {
  const record = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  const speed = SPEECH_SPEEDS.find((option) => option === record.speed) ?? DEFAULT_SPEECH_PREFERENCES.speed
  const voices: Record<string, string> = {}
  if (record.voices && typeof record.voices === 'object') {
    for (const [key, voice] of Object.entries(record.voices as Record<string, unknown>)) {
      if (typeof voice === 'string' && voice) voices[key] = voice
    }
  }
  const flag = (name: 'reduceNoise' | 'expandSymbols' | 'detectLists'): boolean =>
    typeof record[name] === 'boolean' ? (record[name] as boolean) : DEFAULT_SPEECH_PREFERENCES[name]
  // A saved list, even an empty one, is the user's; only a missing one gets the defaults.
  const vocabulary = Array.isArray(record.vocabulary)
    ? (record.vocabulary as unknown[]).flatMap((entry) => {
        const item = entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : {}
        return typeof item.spoken === 'string' && item.spoken.trim() && typeof item.written === 'string' && item.written.trim()
          ? [{ spoken: item.spoken.trim(), written: item.written.trim() }]
          : []
      })
    : [...DEFAULT_DICTATION_VOCABULARY]
  return { speed, voices, reduceNoise: flag('reduceNoise'), vocabulary, expandSymbols: flag('expandSymbols'), detectLists: flag('detectLists') }
}

/** The cleanup dictation applies to a finished transcript under `preferences`. */
export function dictationPolishOptions(preferences: SpeechPreferences): DictationPolishOptions {
  return { vocabulary: preferences.vocabulary, expandSymbols: preferences.expandSymbols, detectLists: preferences.detectLists }
}

export function readAloudVoiceKey(selection: ReadAloudSelection): string {
  return selection.source === 'local' ? `local:${selection.modelId}` : `provider:${selection.providerId}:${selection.modelId}`
}

/** The voice read aloud uses with `selection`: the saved choice when the model still has it, else the default. */
export function voiceFor(preferences: SpeechPreferences, selection: ReadAloudSelection): string | undefined {
  const saved = preferences.voices[readAloudVoiceKey(selection)]
  if (selection.source === 'provider') return resolveProviderTtsVoice(selection.providerId, selection.modelId, saved)
  const model = findLocalTtsModel(selection.modelId)
  if (!model) return undefined
  return saved && model.voices.some((voice) => voice.id === saved) ? saved : model.defaultVoice
}

function load(profileId: string): SpeechPreferences {
  try {
    const raw = localStorage.getItem(profilePreferenceKey(profileId, PREFERENCE_NAME))
    return parseSpeechPreferences(raw ? JSON.parse(raw) : null)
  } catch {
    return { ...DEFAULT_SPEECH_PREFERENCES }
  }
}

function save(profileId: string, preferences: SpeechPreferences): void {
  try {
    localStorage.setItem(profilePreferenceKey(profileId, PREFERENCE_NAME), JSON.stringify(preferences))
  } catch {
    /* ignore quota / private mode */
  }
}

interface SpeechPreferencesState {
  profileId: string | null
  preferences: SpeechPreferences
  syncProfile: (profileId: string) => void
  setSpeed: (speed: number) => void
  setVoice: (selection: ReadAloudSelection, voice: string) => void
  setReduceNoise: (reduceNoise: boolean) => void
  setVocabulary: (vocabulary: DictationVocabularyEntry[]) => void
  setExpandSymbols: (expandSymbols: boolean) => void
  setDetectLists: (detectLists: boolean) => void
}

export const useSpeechPreferences = create<SpeechPreferencesState>((set, get) => {
  const update = (change: Partial<SpeechPreferences>): void => {
    const profileId = useAppStore.getState().profileId
    get().syncProfile(profileId)
    const preferences = { ...get().preferences, ...change }
    save(profileId, preferences)
    set({ preferences })
  }

  return {
    profileId: null,
    preferences: { ...DEFAULT_SPEECH_PREFERENCES },
    syncProfile: (profileId) => {
      if (get().profileId === profileId) return
      set({ profileId, preferences: load(profileId) })
    },
    setSpeed: (speed) => update({ speed }),
    setVoice: (selection, voice) => update({ voices: { ...get().preferences.voices, [readAloudVoiceKey(selection)]: voice } }),
    setReduceNoise: (reduceNoise) => update({ reduceNoise }),
    setVocabulary: (vocabulary) => update({ vocabulary }),
    setExpandSymbols: (expandSymbols) => update({ expandSymbols }),
    setDetectLists: (detectLists) => update({ detectLists })
  }
})

/** The current profile's preferences, loaded on first use. */
export function currentSpeechPreferences(): SpeechPreferences {
  const store = useSpeechPreferences.getState()
  store.syncProfile(useAppStore.getState().profileId)
  return useSpeechPreferences.getState().preferences
}
