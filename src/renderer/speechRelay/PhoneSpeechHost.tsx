import { useEffect } from 'react'
import type { LocalSttModelId } from '../../shared/dictation'
import type { LocalTtsModelId } from '../../shared/readAloud'
import { useDictationStore } from '../dictation/dictationStore'
import { transcribeRecording } from '../dictation/transcribe'
import { synthesizeWithLocalModel } from '../readAloud/localEngine'
import { useReadAloudStore } from '../readAloud/readAloudStore'
import { currentSpeechPreferences, voiceFor } from '../speech/speechPreferences'
import { useAppStore } from '../stores/appStore'
import type { PhoneSpeechDeps } from './phoneSpeechJobs'
import { startPhoneSpeechHost, type SpeechHostRequest } from './startPhoneSpeechHost'

/** This window's models, choices and preferences, read fresh for every phone request. */
const windowDeps: PhoneSpeechDeps = {
  profileId: () => useAppStore.getState().profileId,
  dictationSelection: () => {
    const store = useDictationStore.getState()
    store.syncProfile(useAppStore.getState().profileId)
    return useDictationStore.getState().selection
  },
  setDictationSelection: (selection) => useDictationStore.getState().setSelection(selection),
  readAloudSelection: () => {
    const store = useReadAloudStore.getState()
    store.syncProfile(useAppStore.getState().profileId)
    return useReadAloudStore.getState().selection
  },
  setReadAloudSelection: (selection) => useReadAloudStore.getState().setSelection(selection),
  preferences: currentSpeechPreferences,
  voiceFor,
  providers: async () => (await window.mousse.settings.getOptions()).llmProviders,
  localModels: (kind) => (kind === 'dictation' ? window.mousse.dictation.localModels() : window.mousse.readAloud.localModels()),
  download: (kind, modelId) =>
    kind === 'dictation'
      ? window.mousse.dictation.downloadLocalModel(modelId as LocalSttModelId)
      : window.mousse.readAloud.downloadLocalModel(modelId as LocalTtsModelId),
  cancelDownload: (kind, modelId) =>
    kind === 'dictation'
      ? window.mousse.dictation.cancelLocalModelDownload(modelId as LocalSttModelId)
      : window.mousse.readAloud.cancelLocalModelDownload(modelId as LocalTtsModelId),
  onLocalStatus: (kind, listener) =>
    kind === 'dictation' ? window.mousse.dictation.onLocalModelStatus(listener) : window.mousse.readAloud.onLocalModelStatus(listener),
  transcribe: transcribeRecording,
  synthesizeLocal: synthesizeWithLocalModel,
  synthesizeProvider: (request) => window.mousse.readAloud.synthesizeWithProvider(request)
}

const request: SpeechHostRequest = (method, params) => window.mousse.platformRequest.request(method, params ?? {})

/**
 * Mounted once at the app root: lets paired phones dictate and hear messages with this window's
 * speech models. Restarts when the window switches profile.
 */
export function PhoneSpeechHost() {
  const profileId = useAppStore((state) => state.profileId)
  useEffect(() => startPhoneSpeechHost(request, windowDeps), [profileId])
  return null
}
