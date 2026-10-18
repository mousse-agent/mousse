import { useEffect, useId, useState, type KeyboardEvent } from 'react'
import {
  LOCAL_TTS_MODELS,
  localTtsModelBytes,
  ttsModelsFromProviders,
  type LocalTtsModel,
  type LocalTtsModelId,
  type LocalTtsModelState,
  type LocalTtsModelStatus,
  type ProviderTtsModel,
  type ReadAloudSelection
} from '../../shared/readAloud'
import { Check, Download, Loader2, Trash2, X } from '../lib/icons'
import { useReadAloudStore } from './readAloudStore'
import { sameReadAloudSelection } from './selection'
import '../styles/read-aloud.css'

type PickerTab = 'provider' | 'local'

const TABS: ReadonlyArray<{ id: PickerTab; label: string }> = [
  { id: 'provider', label: 'Providers' },
  { id: 'local', label: 'Local' }
]

export function formatModelSize(bytes: number): string {
  return bytes >= 1_000_000 ? `${Math.round(bytes / 1_000_000)} MB` : `${Math.max(1, Math.round(bytes / 1000))} KB`
}

export function providerSelection(model: ProviderTtsModel): ReadAloudSelection {
  return {
    source: 'provider',
    providerId: model.providerId,
    modelId: model.modelId,
    label: `${model.providerLabel} · ${model.label}`
  }
}

function useProviderTtsModels(): ProviderTtsModel[] | null {
  const [models, setModels] = useState<ProviderTtsModel[] | null>(null)
  useEffect(() => {
    let disposed = false
    const load = (): void => {
      window.mousse.settings
        .getOptions()
        .then((options) => {
          if (!disposed) setModels(ttsModelsFromProviders(options.llmProviders))
        })
        .catch(() => {
          if (!disposed) setModels((current) => current ?? [])
        })
    }
    load()
    const unsubscribe = window.mousse.providers.onChanged(load)
    return () => {
      disposed = true
      unsubscribe()
    }
  }, [])
  return models
}

type LocalStates = Partial<Record<LocalTtsModelId, LocalTtsModelState>>

function useLocalModelStates(): [LocalStates, (status: LocalTtsModelStatus) => void] {
  const [states, setStates] = useState<LocalStates>({})
  const apply = (status: LocalTtsModelStatus): void => setStates((current) => ({ ...current, [status.modelId]: status.state }))
  useEffect(() => {
    let disposed = false
    const merge = (status: LocalTtsModelStatus): void => {
      if (!disposed) setStates((current) => ({ ...current, [status.modelId]: status.state }))
    }
    window.mousse.readAloud
      .localModels()
      .then((list) => list.forEach(merge))
      .catch(() => undefined)
    const unsubscribe = window.mousse.readAloud.onLocalModelStatus(merge)
    return () => {
      disposed = true
      unsubscribe()
    }
  }, [])
  return [states, apply]
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
  const baseId = useId()
  const providerModels = useProviderTtsModels()
  const [localStates, applyLocalStatus] = useLocalModelStates()
  const [chosenTab, setChosenTab] = useState<PickerTab | null>(null)
  const tab: PickerTab = chosenTab ?? value?.source ?? (providerModels && providerModels.length === 0 ? 'local' : 'provider')
  const tabId = (id: PickerTab): string => `${baseId}-tab-${id}`
  const panelId = `${baseId}-panel`

  const onTabKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const index = TABS.findIndex((item) => item.id === tab)
    const next =
      event.key === 'Home' ? 0 : event.key === 'End' ? TABS.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + TABS.length) % TABS.length
    setChosenTab(TABS[next].id)
    event.currentTarget.querySelector<HTMLElement>(`[id="${tabId(TABS[next].id)}"]`)?.focus()
  }

  return (
    <div className="read-aloud-picker">
      <div className="files-view-toggle read-aloud-tabs" role="tablist" aria-label="Read aloud model source" onKeyDown={onTabKeyDown}>
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            id={tabId(item.id)}
            aria-selected={tab === item.id}
            aria-controls={panelId}
            tabIndex={tab === item.id ? 0 : -1}
            className={`btn btn-sm${tab === item.id ? ' active' : ''}`}
            onClick={() => setChosenTab(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div id={panelId} role="tabpanel" aria-labelledby={tabId(tab)}>
        {tab === 'provider' ? (
          <ProviderModelList models={providerModels} value={value} onSelect={onSelect} onShowLocal={() => setChosenTab('local')} />
        ) : (
          <ul className="read-aloud-list" role="radiogroup" aria-label="Local models">
            {LOCAL_TTS_MODELS.map((model) => (
              <LocalModelRow
                key={model.id}
                model={model}
                state={localStates[model.id] ?? { status: 'not-downloaded' }}
                selected={value?.source === 'local' && value.modelId === model.id}
                onStatus={applyLocalStatus}
                onSelect={() => onSelect({ source: 'local', modelId: model.id, label: model.label })}
                onDeleted={onLocalModelDeleted}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

function ProviderModelList({
  models,
  value,
  onSelect,
  onShowLocal
}: {
  models: ProviderTtsModel[] | null
  value: ReadAloudSelection | null
  onSelect: (selection: ReadAloudSelection) => void
  onShowLocal: () => void
}) {
  if (models === null) {
    return (
      <p className="read-aloud-empty">
        <Loader2 size={14} className="read-aloud-spin" /> Loading models
      </p>
    )
  }
  if (models.length === 0) {
    return (
      <div className="read-aloud-empty">
        <p>No configured provider lists a text-to-speech model.</p>
        <p>
          OpenAI&apos;s <code>tts-1</code> and <code>gpt-4o-mini-tts</code> appear after you sign in to OpenAI and refresh its models under
          Providers.
        </p>
        <p>
          You can also{' '}
          <button type="button" className="read-aloud-link" onClick={onShowLocal}>
            use a local model
          </button>{' '}
          that runs on this computer.
        </p>
      </div>
    )
  }
  return (
    <ul className="read-aloud-list" role="radiogroup" aria-label="Provider models">
      {models.map((model) => {
        const selection = providerSelection(model)
        return (
          <li key={`${model.providerId}:${model.modelId}`} className="read-aloud-option">
            <label className="read-aloud-option-main">
              <input
                type="radio"
                name="read-aloud-model"
                checked={sameReadAloudSelection(value, selection)}
                onChange={() => onSelect(selection)}
              />
              <span className="read-aloud-option-text">
                <strong>{model.label}</strong>
                <span>{model.providerLabel}</span>
              </span>
            </label>
          </li>
        )
      })}
    </ul>
  )
}

function LocalModelRow({
  model,
  state,
  selected,
  onStatus,
  onSelect,
  onDeleted
}: {
  model: LocalTtsModel
  state: LocalTtsModelState
  selected: boolean
  onStatus: (status: LocalTtsModelStatus) => void
  onSelect: () => void
  onDeleted?: (modelId: LocalTtsModelId) => void
}) {
  const deleteLocalModel = useReadAloudStore((store) => store.deleteLocalModel)
  const [deleting, setDeleting] = useState(false)
  const downloaded = state.status === 'downloaded'
  const totalBytes = localTtsModelBytes(model)
  const size = formatModelSize(totalBytes)

  const download = (): void => {
    onStatus({ modelId: model.id, state: { status: 'downloading', receivedBytes: 0, totalBytes } })
    window.mousse.readAloud.downloadLocalModel(model.id).then(onStatus, (error: unknown) =>
      onStatus({ modelId: model.id, state: { status: 'error', message: error instanceof Error ? error.message : String(error) } })
    )
  }
  const cancel = (): void => {
    void window.mousse.readAloud.cancelLocalModelDownload(model.id).catch(() => undefined)
  }
  const remove = (): void => {
    if (!window.confirm(`Delete ${model.label}? Its ${size} download is removed from this computer.`)) return
    setDeleting(true)
    deleteLocalModel(model.id)
      .then((status) => {
        onStatus(status)
        onDeleted?.(model.id)
      })
      .catch((error: unknown) =>
        onStatus({ modelId: model.id, state: { status: 'error', message: error instanceof Error ? error.message : String(error) } })
      )
      .finally(() => setDeleting(false))
  }

  return (
    <li className="read-aloud-option" data-downloaded={downloaded || undefined}>
      <label className="read-aloud-option-main">
        <input type="radio" name="read-aloud-model" checked={selected} disabled={!downloaded} onChange={onSelect} />
        <span className="read-aloud-option-text">
          <strong>{model.label}</strong>
          <span>
            {model.parameters} parameters · {size} · {model.license}
          </span>
          <span>{downloaded ? model.description : `${model.description}. Download it to use it.`}</span>
          {state.status === 'error' && <span className="read-aloud-error">{state.message}</span>}
        </span>
      </label>
      <div className="read-aloud-option-actions">
        <a className="read-aloud-link" href={model.homepage} target="_blank" rel="noopener noreferrer">
          Model card
        </a>
        {state.status === 'downloading' ? (
          <>
            <span className="read-aloud-progress" role="progressbar" aria-label={`Downloading ${model.label}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={downloadPercent(state)}>
              <span style={{ width: `${downloadPercent(state)}%` }} />
            </span>
            <span className="read-aloud-percent">{downloadPercent(state)}%</span>
            <button type="button" className="read-aloud-icon-btn" title="Cancel download" aria-label={`Cancel downloading ${model.label}`} onClick={cancel}>
              <X size={14} />
            </button>
          </>
        ) : downloaded ? (
          <>
            <span className="read-aloud-done">
              <Check size={14} /> Downloaded
            </span>
            <button
              type="button"
              className="read-aloud-icon-btn"
              title={`Delete ${model.label}`}
              aria-label={`Delete ${model.label}`}
              disabled={deleting}
              onClick={remove}
            >
              {deleting ? <Loader2 size={14} className="read-aloud-spin" /> : <Trash2 size={14} />}
            </button>
          </>
        ) : (
          <button
            type="button"
            className="read-aloud-icon-btn"
            title={state.status === 'error' ? `Retry download (${size})` : `Download ${model.label} (${size})`}
            aria-label={state.status === 'error' ? `Retry downloading ${model.label}` : `Download ${model.label}`}
            onClick={download}
          >
            <Download size={14} />
          </button>
        )}
      </div>
    </li>
  )
}

function downloadPercent(state: Extract<LocalTtsModelState, { status: 'downloading' }>): number {
  return state.totalBytes > 0 ? Math.min(100, Math.floor((state.receivedBytes / state.totalBytes) * 100)) : 0
}
