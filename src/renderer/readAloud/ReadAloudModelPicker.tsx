import {
  LOCAL_TTS_MODELS,
  ttsModelsFromProviders,
  type LocalTtsModel,
  type LocalTtsModelId,
  type LocalTtsModelStatus,
  type ReadAloudSelection
} from '../../shared/readAloud'
import { SpeechModelPicker, useProviderSpeechModels, type LocalModelApi, type SpeechProviderModel } from '../speechModels/SpeechModelPicker'
import { useReadAloudStore } from './readAloudStore'
import { sameReadAloudSelection } from './selection'

export { formatModelSize } from '../speechModels/SpeechModelPicker'

export function providerSelection(model: SpeechProviderModel): ReadAloudSelection {
  return {
    source: 'provider',
    providerId: model.providerId,
    modelId: model.modelId,
    label: `${model.providerLabel} · ${model.label}`
  }
}

export const readAloudLocalApi: LocalModelApi = {
  list: () => window.mousse.readAloud.localModels(),
  download: (modelId) => window.mousse.readAloud.downloadLocalModel(modelId as LocalTtsModelId),
  cancelDownload: (modelId) => window.mousse.readAloud.cancelLocalModelDownload(modelId as LocalTtsModelId),
  remove: (modelId) => useReadAloudStore.getState().deleteLocalModel(modelId as LocalTtsModelId),
  onStatus: (listener) => window.mousse.readAloud.onLocalModelStatus((status: LocalTtsModelStatus) => listener(status))
}

export function localSelection(model: LocalTtsModel): ReadAloudSelection {
  return { source: 'local', modelId: model.id, label: model.label }
}

function renderEmptyProviders(showLocal: () => void) {
  return (
    <>
      <p>No configured provider lists a text-to-speech model.</p>
      <p>
        OpenAI&apos;s <code>tts-1</code> and <code>gpt-4o-mini-tts</code> appear after you sign in to OpenAI and refresh its models under
        Providers.
      </p>
      <p>
        You can also{' '}
        <button type="button" className="read-aloud-link" onClick={showLocal}>
          use a local model
        </button>{' '}
        that runs on this computer.
      </p>
    </>
  )
}

/**
 * Model choices for read aloud: provider text-to-speech models and downloadable local models.
 * Used by the first-click dialog (which confirms a choice) and by Settings (which saves it on click).
 */
export function ReadAloudModelPicker({
  value,
  onSelect,
  onLocalModelDeleted
}: {
  value: ReadAloudSelection | null
  onSelect: (selection: ReadAloudSelection) => void
  onLocalModelDeleted?: (modelId: LocalTtsModelId) => void
}) {
  const providerModels = useProviderSpeechModels(ttsModelsFromProviders)
  return (
    <SpeechModelPicker
      value={value}
      onSelect={onSelect}
      onLocalModelDeleted={onLocalModelDeleted as ((modelId: string) => void) | undefined}
      tabsLabel="Read aloud model source"
      radioName="read-aloud-model"
      providerModels={providerModels}
      providerSelection={providerSelection}
      localModels={LOCAL_TTS_MODELS}
      localSelection={localSelection}
      localApi={readAloudLocalApi}
      sameSelection={sameReadAloudSelection}
      renderEmptyProviders={renderEmptyProviders}
    />
  )
}
