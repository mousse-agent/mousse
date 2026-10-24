import { useEffect, useId } from 'react'
import { LOCAL_STT_MODELS, sttModelsFromProviders } from '../../shared/dictation'
import {
  LOCAL_TTS_MODELS,
  findLocalTtsModel,
  providerTtsVoices,
  ttsModelsFromProviders,
  type ReadAloudSelection
} from '../../shared/readAloud'
import { Segmented, SettingsGroup, SettingsRow, Switch } from '../components/settings/SettingsRow'
import { Select } from '../components/ui/Select'
import {
  dictationLocalApi,
  localSelection as dictationLocalSelection,
  providerSelection as dictationProviderSelection
} from '../dictation/DictationModelPicker'
import { useDictationStore } from '../dictation/dictationStore'
import { Loader2, Mic, Play, Stop, VolumeHigh } from '../lib/icons'
import {
  localSelection as readAloudLocalSelection,
  providerSelection as readAloudProviderSelection,
  readAloudLocalApi
} from '../readAloud/ReadAloudModelPicker'
import { useReadAloudStore } from '../readAloud/readAloudStore'
import { useProviderSpeechModels } from '../speechModels/SpeechModelPicker'
import { SpeechModelSetting } from '../speechModels/SpeechModelSetting'
import { useAppStore } from '../stores/appStore'
import { SPEECH_SPEEDS, useSpeechPreferences, voiceFor } from './speechPreferences'
import '../styles/speech.css'

const PREVIEW_KEY = 'speech-settings-preview'
const PREVIEW_TEXT =
  'This is how messages sound when they are read aloud. You can change the voice and the speed at any time.'

interface VoiceOption {
  id: string
  label: string
}

function voiceOptions(selection: ReadAloudSelection): VoiceOption[] {
  if (selection.source === 'local') {
    // Kokoro labels read "Heart, American female".
    return (findLocalTtsModel(selection.modelId)?.voices ?? []).map((voice) => ({ id: voice.id, label: voice.label }))
  }
  return providerTtsVoices(selection.providerId, selection.modelId).map((voice) => {
    const name = voice.replace(/-PlayAI$/, '')
    return { id: voice, label: name.charAt(0).toUpperCase() + name.slice(1) }
  })
}

const SPEED_OPTIONS = SPEECH_SPEEDS.map((speed) => ({ value: speed, label: `${speed}×` }))

/** Settings, Speech: the read aloud and dictation models, the voice, speed and microphone cleanup. */
export function SpeechSettings() {
  return (
    <>
      <ReadAloudSpeechSettings />
      <DictationSpeechSettings />
    </>
  )
}

function ReadAloudSpeechSettings() {
  const voiceSelectId = useId()
  const speedLabelId = useId()
  const profileId = useAppStore((state) => state.profileId)
  const selection = useReadAloudStore((state) => state.selection)
  const setSelection = useReadAloudStore((state) => state.setSelection)
  const syncReadAloud = useReadAloudStore((state) => state.syncProfile)
  const previewStatus = useReadAloudStore((state) => (state.activeKey === PREVIEW_KEY ? state.status : 'idle'))
  const previewing = previewStatus !== 'idle'
  // A voice can take a few seconds to load before the first sound, so show that it is working.
  const previewLoading = previewStatus === 'loading'
  const previewError = useReadAloudStore((state) => (state.error?.key === PREVIEW_KEY ? state.error.message : null))
  const toggle = useReadAloudStore((state) => state.toggle)
  const stop = useReadAloudStore((state) => state.stop)
  const preferences = useSpeechPreferences((state) => state.preferences)
  const syncPreferences = useSpeechPreferences((state) => state.syncProfile)
  const setSpeed = useSpeechPreferences((state) => state.setSpeed)
  const setVoice = useSpeechPreferences((state) => state.setVoice)
  const providerModels = useProviderSpeechModels(ttsModelsFromProviders)

  useEffect(() => {
    syncReadAloud(profileId)
    syncPreferences(profileId)
  }, [profileId, syncReadAloud, syncPreferences])

  const voices = selection ? voiceOptions(selection) : []
  const voice = selection ? voiceFor(preferences, selection) : undefined
  const playSample = (): void => toggle(PREVIEW_KEY, PREVIEW_TEXT, { inThread: false })

  const chooseVoice = (voiceId: string): void => {
    if (!selection) return
    setVoice(selection, voiceId)
    // A sample that is playing switches to the new voice.
    if (previewing) {
      stop()
      playSample()
    }
  }

  return (
    <SettingsGroup title="Read aloud" icon={VolumeHigh}>
      <SpeechModelSetting
        title="Model"
        description="Reads messages when you press read aloud under one."
        dialogTitle="Read aloud models"
        value={selection}
        onSelect={setSelection}
        providerModels={providerModels}
        providerSelection={readAloudProviderSelection}
        localModels={LOCAL_TTS_MODELS}
        localSelection={readAloudLocalSelection}
        localApi={readAloudLocalApi}
      />
      <SettingsRow
        title="Voice"
        description={
          previewError ? (
            <span className="speech-settings-error" role="alert">
              {previewError}
            </span>
          ) : selection ? (
            'Each model keeps its own voice.'
          ) : (
            'Choose a model first.'
          )
        }
        htmlFor={voiceSelectId}
        disabled={!selection}
        control={
          <>
            <Select
              id={voiceSelectId}
              value={voice ?? ''}
              disabled={voices.length === 0}
              placeholder="No voices"
              onChange={chooseVoice}
              options={voices.map((option) => ({ value: option.id, label: option.label }))}
            />
            <button
              type="button"
              className="settings-icon-btn primary"
              disabled={!selection}
              title={previewLoading ? 'Loading voice, click to stop' : previewing ? 'Stop sample' : 'Play sample'}
              aria-label={previewing ? 'Stop sample' : 'Play sample'}
              aria-busy={previewLoading || undefined}
              onClick={playSample}
            >
              {previewLoading ? (
                <Loader2 size={14} strokeWidth={2} className="icon-spin" aria-hidden="true" />
              ) : previewing ? (
                <Stop size={14} strokeWidth={2} aria-hidden="true" />
              ) : (
                <Play size={14} strokeWidth={2} aria-hidden="true" />
              )}
            </button>
          </>
        }
      />
      <SettingsRow
        title="Speed"
        titleId={speedLabelId}
        description="A change applies from the next sentence."
        control={<Segmented value={preferences.speed} options={SPEED_OPTIONS} onChange={setSpeed} ariaLabelledBy={speedLabelId} />}
      />
    </SettingsGroup>
  )
}

function DictationSpeechSettings() {
  const noiseSwitchId = useId()
  const profileId = useAppStore((state) => state.profileId)
  const selection = useDictationStore((state) => state.selection)
  const setSelection = useDictationStore((state) => state.setSelection)
  const syncDictation = useDictationStore((state) => state.syncProfile)
  const reduceNoise = useSpeechPreferences((state) => state.preferences.reduceNoise)
  const syncPreferences = useSpeechPreferences((state) => state.syncProfile)
  const setReduceNoise = useSpeechPreferences((state) => state.setReduceNoise)
  const providerModels = useProviderSpeechModels(sttModelsFromProviders)

  useEffect(() => {
    syncDictation(profileId)
    syncPreferences(profileId)
  }, [profileId, syncDictation, syncPreferences])

  return (
    <SettingsGroup title="Dictation" icon={Mic}>
      <SpeechModelSetting
        title="Model"
        description="Turns speech into text when you press the microphone in the message box."
        dialogTitle="Dictation models"
        value={selection}
        onSelect={setSelection}
        providerModels={providerModels}
        providerSelection={dictationProviderSelection}
        localModels={LOCAL_STT_MODELS}
        localSelection={dictationLocalSelection}
        localApi={dictationLocalApi}
      />
      <SettingsRow
        title="Reduce background noise"
        description="Removes fans, typing and street noise before your speech is turned into text."
        htmlFor={noiseSwitchId}
        control={<Switch id={noiseSwitchId} checked={reduceNoise} onChange={setReduceNoise} />}
      />
    </SettingsGroup>
  )
}
