import { useEffect } from 'react'
import {
  findLocalTtsModel,
  providerTtsVoices,
  type ReadAloudSelection
} from '../../shared/readAloud'
import { Play, Stop } from '../lib/icons'
import { useReadAloudStore } from '../readAloud/readAloudStore'
import { useAppStore } from '../stores/appStore'
import { SPEECH_SPEEDS, useSpeechPreferences, voiceFor } from './speechPreferences'
import { VoiceCarousel, type VoiceOption } from './VoiceCarousel'
import '../styles/speech.css'

const PREVIEW_KEY = 'speech-settings-preview'
const PREVIEW_TEXT =
  'This is how messages sound when they are read aloud. You can change the voice and the speed at any time.'

function voiceOptions(selection: ReadAloudSelection): VoiceOption[] {
  if (selection.source === 'local') {
    // Kokoro labels read "Heart, American female".
    return (findLocalTtsModel(selection.modelId)?.voices ?? []).map((voice, index) => {
      const [name, detail = ''] = voice.label.split(', ')
      return { id: voice.id, name, detail, index }
    })
  }
  return providerTtsVoices(selection.providerId, selection.modelId).map((voice) => {
    const name = voice.replace(/-PlayAI$/, '')
    return { id: voice, name: name.charAt(0).toUpperCase() + name.slice(1), detail: '' }
  })
}

const formatSpeed = (speed: number): string => `${speed}×`

/** Settings, Speech: how fast read aloud speaks and with which voice. */
export function ReadAloudSpeechSettings() {
  const profileId = useAppStore((state) => state.profileId)
  const selection = useReadAloudStore((state) => state.selection)
  const syncReadAloud = useReadAloudStore((state) => state.syncProfile)
  const previewing = useReadAloudStore(
    (state) => state.activeKey === PREVIEW_KEY && state.status !== 'idle'
  )
  const previewError = useReadAloudStore((state) =>
    state.error?.key === PREVIEW_KEY ? state.error.message : null
  )
  const previewLevels = useReadAloudStore((state) =>
    state.activeKey === PREVIEW_KEY ? state.levels : null
  )
  const toggle = useReadAloudStore((state) => state.toggle)
  const stop = useReadAloudStore((state) => state.stop)
  const preferences = useSpeechPreferences((state) => state.preferences)
  const syncPreferences = useSpeechPreferences((state) => state.syncProfile)
  const setSpeed = useSpeechPreferences((state) => state.setSpeed)
  const setVoice = useSpeechPreferences((state) => state.setVoice)

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
    <>
      <div className="registry-controls">
        <div className="registry-control-row speech-setting">
          <div className="registry-control-text">
            <span className="registry-control-label" id="speech-speed-label">
              Speed
            </span>
            <span className="registry-control-hint">
              How fast messages are read. A change applies from the next sentence.
            </span>
          </div>
          <div className="files-view-toggle" role="radiogroup" aria-labelledby="speech-speed-label">
            {SPEECH_SPEEDS.map((speed) => (
              <button
                key={speed}
                type="button"
                role="radio"
                aria-checked={preferences.speed === speed}
                className={`btn btn-sm${preferences.speed === speed ? ' active' : ''}`}
                onClick={() => setSpeed(speed)}
              >
                {formatSpeed(speed)}
              </button>
            ))}
          </div>
        </div>

        <div className="registry-control-row speech-setting">
          <div className="registry-control-text">
            <span className="registry-control-label" id="speech-voice-label">
              Voice
            </span>
            <span className="registry-control-hint">
              {selection
                ? `Voices of ${selection.label}. Each read aloud model keeps its own choice.`
                : 'Choose a read aloud model under Models to pick its voice.'}
            </span>
          </div>
          {voices.length > 0 && (
            <VoiceCarousel
              voices={voices}
              value={voice}
              onSelect={chooseVoice}
              label="Read aloud voice"
              levels={previewLevels}
            />
          )}
          <button
            type="button"
            className="btn btn-sm speech-sample-button"
            disabled={!selection}
            title={previewError ?? undefined}
            onClick={playSample}
          >
            {previewing ? (
              <Stop size={12} strokeWidth={2} aria-hidden="true" />
            ) : (
              <Play size={12} strokeWidth={2} aria-hidden="true" />
            )}
            {previewing ? 'Stop sample' : 'Play sample'}
          </button>
        </div>
      </div>
      {previewError && (
        <p className="speech-settings-error" role="alert">
          {previewError}
        </p>
      )}
    </>
  )
}

/** Settings, Speech: how dictation records the microphone. */
export function DictationSpeechSettings() {
  const profileId = useAppStore((state) => state.profileId)
  const reduceNoise = useSpeechPreferences((state) => state.preferences.reduceNoise)
  const syncPreferences = useSpeechPreferences((state) => state.syncProfile)
  const setReduceNoise = useSpeechPreferences((state) => state.setReduceNoise)

  useEffect(() => {
    syncPreferences(profileId)
  }, [profileId, syncPreferences])

  return (
    <div className="registry-controls">
      <div className="registry-control-row">
        <div className="registry-control-text">
          <span className="registry-control-label">Reduce background noise</span>
          <span className="registry-control-hint">
            Dictation cleans the microphone with RNNoise, which removes fans, typing and street
            noise before the speech-to-text model hears it.
          </span>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={reduceNoise}
          aria-label="Reduce background noise"
          className={`toggle-switch${reduceNoise ? ' on' : ''}`}
          onClick={() => setReduceNoise(!reduceNoise)}
        />
      </div>
    </div>
  )
}
