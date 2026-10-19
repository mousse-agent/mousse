import { useEffect } from 'react'
import {
  findLocalTtsModel,
  providerTtsVoices,
  type ReadAloudSelection
} from '../../shared/readAloud'
import { useReadAloudStore } from '../readAloud/readAloudStore'
import { useAppStore } from '../stores/appStore'
import { SPEECH_SPEEDS, useSpeechPreferences, voiceFor } from './speechPreferences'
import '../styles/speech.css'

const PREVIEW_KEY = 'speech-settings-preview'
const PREVIEW_TEXT =
  'This is how messages sound when they are read aloud. You can change the voice and the speed at any time.'

function voiceOptions(selection: ReadAloudSelection): { id: string; label: string }[] {
  if (selection.source === 'local') return [...(findLocalTtsModel(selection.modelId)?.voices ?? [])]
  return providerTtsVoices(selection.providerId, selection.modelId).map((voice) => ({
    id: voice,
    label: voice
  }))
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
  const toggle = useReadAloudStore((state) => state.toggle)
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
            <label className="registry-control-label" htmlFor="speech-voice">
              Voice
            </label>
            <span className="registry-control-hint">
              {selection
                ? `Voices of ${selection.label}. Each read aloud model keeps its own choice.`
                : 'Choose a read aloud model under Models to pick its voice.'}
            </span>
          </div>
          <div className="speech-voice-controls">
            <select
              id="speech-voice"
              className="settings-select"
              value={voice ?? ''}
              disabled={!selection || voices.length === 0}
              onChange={(event) => selection && setVoice(selection, event.target.value)}
            >
              {!selection && <option value="">No model selected</option>}
              {voices.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn btn-sm"
              disabled={!selection}
              title={previewError ?? undefined}
              onClick={() => toggle(PREVIEW_KEY, PREVIEW_TEXT, { inThread: false })}
            >
              {previewing ? 'Stop' : 'Play sample'}
            </button>
          </div>
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
