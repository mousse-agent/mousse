import {
  LOCAL_STT_MODELS,
  sttModelsFromProviders,
  type DictationSelection,
  type LocalSttModel,
  type LocalSttModelId,
  type LocalSttModelStatus
} from '../../shared/dictation'
import { SpeechModelPicker, useProviderSpeechModels, type LocalModelApi, type SpeechProviderModel } from '../speechModels/SpeechModelPicker'
import { useDictationStore } from './dictationStore'
import { sameDictationSelection } from './selection'

function providerSelection(model: SpeechProviderModel): DictationSelection {
  return {
    source: 'provider',
    providerId: model.providerId,
    modelId: model.modelId,
    label: `${model.providerLabel} · ${model.label}`
  }
}

function localSelection(model: LocalSttModel): DictationSelection {
  return { source: 'local', modelId: model.id, label: model.label }
}

const localApi: LocalModelApi = {
  list: () => window.mousse.dictation.localModels(),
  download: (modelId) => window.mousse.dictation.downloadLocalModel(modelId as LocalSttModelId),
  cancelDownload: (modelId) => window.mousse.dictation.cancelLocalModelDownload(modelId as LocalSttModelId),
  remove: (modelId) => useDictationStore.getState().deleteLocalModel(modelId as LocalSttModelId),
  onStatus: (listener) => window.mousse.dictation.onLocalModelStatus((status: LocalSttModelStatus) => listener(status))
}

function renderEmptyProviders(showLocal: () => void) {
  return (
    <>
      <p>No configured provider lists a speech-to-text model.</p>
      <p>
        OpenAI&apos;s <code>whisper-1</code> and <code>gpt-4o-transcribe</code>, and Groq&apos;s <code>whisper-large-v3</code>, appear after you sign
        in and refresh the provider&apos;s models under Providers.
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
 * Model choices for dictation: provider speech-to-text models and downloadable local models.
 * Used by the first-click dialog (which confirms a choice) and by Settings (which saves it on click).
 */
export function DictationModelPicker({
  value,
  onSelect,
  onLocalModelDeleted
}: {
  value: DictationSelection | null
  onSelect: (selection: DictationSelection) => void
  onLocalModelDeleted?: (modelId: LocalSttModelId) => void
}) {
  const providerModels = useProviderSpeechModels(sttModelsFromProviders)
  return (
    <SpeechModelPicker
      value={value}
      onSelect={onSelect}
      onLocalModelDeleted={onLocalModelDeleted as ((modelId: string) => void) | undefined}
      tabsLabel="Dictation model source"
      radioName="dictation-model"
      providerModels={providerModels}
      providerSelection={providerSelection}
      localModels={LOCAL_STT_MODELS}
      localSelection={localSelection}
      localApi={localApi}
      sameSelection={sameDictationSelection}
      renderEmptyProviders={renderEmptyProviders}
    />
  )
}
