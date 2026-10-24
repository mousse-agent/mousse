import { useEffect, useId, useState, type KeyboardEvent, type ReactNode } from 'react'
import { localModelBytes, type LocalModelManifest, type LocalModelState, type LocalModelStatus } from '../../shared/localModels'
import type { LlmProviderOption } from '../../shared/settings'
import { Check, Download, Loader2, Trash2, X } from '../lib/icons'
import '../styles/read-aloud.css'

/**
 * Model choices shared by read aloud (text-to-speech) and dictation (speech-to-text): provider
 * models and downloadable local models. Each feature supplies its model lists, the local model
 * actions and its selection type.
 */

type PickerTab = 'provider' | 'local'

const TABS: ReadonlyArray<{ id: PickerTab; label: string }> = [
  { id: 'provider', label: 'Providers' },
  { id: 'local', label: 'Local' }
]

export function formatModelSize(bytes: number): string {
  return bytes >= 1_000_000 ? `${Math.round(bytes / 1_000_000)} MB` : `${Math.max(1, Math.round(bytes / 1000))} KB`
}

export interface SpeechProviderModel {
  providerId: string
  providerLabel: string
  modelId: string
  label: string
}

/** The fields the picker reads from a feature's selection type. */
export type SpeechSelection =
  | { source: 'provider'; providerId: string; modelId: string; label: string }
  | { source: 'local'; modelId: string; label: string }

/** Local model operations of one feature (its IPC channel group). */
export interface LocalModelApi {
  list: () => Promise<LocalModelStatus[]>
  download: (modelId: string) => Promise<LocalModelStatus>
  cancelDownload: (modelId: string) => Promise<unknown>
  /** Deletes the files. Features also stop any engine that is using them here. */
  remove: (modelId: string) => Promise<LocalModelStatus>
  onStatus: (listener: (status: LocalModelStatus) => void) => () => void
}

/** Provider models of the configured providers; null until the first load finishes. */
export function useProviderSpeechModels(select: (providers: readonly LlmProviderOption[]) => SpeechProviderModel[]): SpeechProviderModel[] | null {
  const [models, setModels] = useState<SpeechProviderModel[] | null>(null)
  useEffect(() => {
    let disposed = false
    const load = (): void => {
      window.mousse.settings
        .getOptions()
        .then((options) => {
          if (!disposed) setModels(select(options.llmProviders))
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
  }, [select])
  return models
}

export type LocalStates = Record<string, LocalModelState | undefined>

/** Download state of each local model of `api`, kept current from its status events. */
export function useLocalModelStates(api: LocalModelApi): [LocalStates, (status: LocalModelStatus) => void] {
  const [states, setStates] = useState<LocalStates>({})
  const apply = (status: LocalModelStatus): void => setStates((current) => ({ ...current, [status.modelId]: status.state }))
  useEffect(() => {
    let disposed = false
    const merge = (status: LocalModelStatus): void => {
      if (!disposed) setStates((current) => ({ ...current, [status.modelId]: status.state }))
    }
    api
      .list()
      .then((list) => list.forEach(merge))
      .catch(() => undefined)
    const unsubscribe = api.onStatus(merge)
    return () => {
      disposed = true
      unsubscribe()
    }
  }, [api])
  return [states, apply]
}

export interface SpeechModelPickerProps<S extends SpeechSelection, M extends LocalModelManifest> {
  value: S | null
  onSelect: (selection: S) => void
  onLocalModelDeleted?: (modelId: string) => void
  /** Accessible name of the Providers / Local tab list. */
  tabsLabel: string
  /** Groups the radio buttons of both lists. */
  radioName: string
  providerModels: SpeechProviderModel[] | null
  providerSelection: (model: SpeechProviderModel) => S
  localModels: readonly M[]
  localSelection: (model: M) => S
  localApi: LocalModelApi
  sameSelection: (a: S | null, b: S | null) => boolean
  /** Shown on the Providers tab when no configured provider lists a model. `showLocal` switches tabs. */
  renderEmptyProviders: (showLocal: () => void) => ReactNode
}

export function SpeechModelPicker<S extends SpeechSelection, M extends LocalModelManifest>({
  value,
  onSelect,
  onLocalModelDeleted,
  tabsLabel,
  radioName,
  providerModels,
  providerSelection,
  localModels,
  localSelection,
  localApi,
  sameSelection,
  renderEmptyProviders
}: SpeechModelPickerProps<S, M>) {
  const baseId = useId()
  const [localStates, applyLocalStatus] = useLocalModelStates(localApi)
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
      <div className="files-view-toggle read-aloud-tabs" role="tablist" aria-label={tabsLabel} onKeyDown={onTabKeyDown}>
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
          <ProviderModelList
            models={providerModels}
            value={value}
            radioName={radioName}
            toSelection={providerSelection}
            sameSelection={sameSelection}
            onSelect={onSelect}
            renderEmpty={() => renderEmptyProviders(() => setChosenTab('local'))}
          />
        ) : (
          <ul className="read-aloud-list" role="radiogroup" aria-label="Local models">
            {localModels.map((model) => (
              <LocalModelRow
                key={model.id}
                model={model}
                api={localApi}
                radioName={radioName}
                state={localStates[model.id] ?? { status: 'not-downloaded' }}
                selected={value?.source === 'local' && value.modelId === model.id}
                onStatus={applyLocalStatus}
                onSelect={() => onSelect(localSelection(model))}
                onDeleted={onLocalModelDeleted}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

function ProviderModelList<S extends SpeechSelection>({
  models,
  value,
  radioName,
  toSelection,
  sameSelection,
  onSelect,
  renderEmpty
}: {
  models: SpeechProviderModel[] | null
  value: S | null
  radioName: string
  toSelection: (model: SpeechProviderModel) => S
  sameSelection: (a: S | null, b: S | null) => boolean
  onSelect: (selection: S) => void
  renderEmpty: () => ReactNode
}) {
  if (models === null) {
    return (
      <p className="read-aloud-empty">
        <Loader2 size={14} className="read-aloud-spin" /> Loading models
      </p>
    )
  }
  if (models.length === 0) return <div className="read-aloud-empty">{renderEmpty()}</div>
  return (
    <ul className="read-aloud-list" role="radiogroup" aria-label="Provider models">
      {models.map((model) => {
        const selection = toSelection(model)
        return (
          <li key={`${model.providerId}:${model.modelId}`} className="read-aloud-option">
            <label className="read-aloud-option-main">
              <input type="radio" name={radioName} checked={sameSelection(value, selection)} onChange={() => onSelect(selection)} />
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

function errorStatus(modelId: string, error: unknown): LocalModelStatus {
  return { modelId, state: { status: 'error', message: error instanceof Error ? error.message : String(error) } }
}

/** Download, cancel and delete for one local model. Results and errors arrive through `onStatus`. */
export function useLocalModelActions(
  model: LocalModelManifest,
  api: LocalModelApi,
  onStatus: (status: LocalModelStatus) => void,
  onDeleted?: (modelId: string) => void
): { download: () => void; cancel: () => void; remove: () => void; deleting: boolean; size: string } {
  const [deleting, setDeleting] = useState(false)
  const totalBytes = localModelBytes(model)
  const size = formatModelSize(totalBytes)

  const download = (): void => {
    onStatus({ modelId: model.id, state: { status: 'downloading', receivedBytes: 0, totalBytes } })
    api.download(model.id).then(onStatus, (error: unknown) => onStatus(errorStatus(model.id, error)))
  }
  const cancel = (): void => {
    void api.cancelDownload(model.id).catch(() => undefined)
  }
  const remove = (): void => {
    if (!window.confirm(`Delete ${model.label}? Its ${size} download is removed from this computer.`)) return
    setDeleting(true)
    api
      .remove(model.id)
      .then((status) => {
        onStatus(status)
        onDeleted?.(model.id)
      })
      .catch((error: unknown) => onStatus(errorStatus(model.id, error)))
      .finally(() => setDeleting(false))
  }
  return { download, cancel, remove, deleting, size }
}

function LocalModelRow({
  model,
  api,
  radioName,
  state,
  selected,
  onStatus,
  onSelect,
  onDeleted
}: {
  model: LocalModelManifest
  api: LocalModelApi
  radioName: string
  state: LocalModelState
  selected: boolean
  onStatus: (status: LocalModelStatus) => void
  onSelect: () => void
  onDeleted?: (modelId: string) => void
}) {
  const { download, cancel, remove, deleting, size } = useLocalModelActions(model, api, onStatus, onDeleted)
  const downloaded = state.status === 'downloaded'

  return (
    <li className="read-aloud-option" data-downloaded={downloaded || undefined}>
      <label className="read-aloud-option-main">
        <input type="radio" name={radioName} checked={selected} disabled={!downloaded} onChange={onSelect} />
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

export function downloadPercent(state: Extract<LocalModelState, { status: 'downloading' }>): number {
  return state.totalBytes > 0 ? Math.min(100, Math.floor((state.receivedBytes / state.totalBytes) * 100)) : 0
}
