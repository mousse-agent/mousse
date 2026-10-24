import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import type { LocalModelManifest, LocalModelState, LocalModelStatus } from '../../shared/localModels'
import { Modal } from '../components/ui/Modal'
import { Check, Download, RotateCcw, Trash2, X } from '../lib/icons'
import { SettingsGroup, SettingsRow } from '../components/settings/SettingsRow'
import { Select } from '../components/ui/Select'
import {
  downloadPercent,
  useLocalModelActions,
  useLocalModelStates,
  type LocalModelApi,
  type SpeechProviderModel,
  type SpeechSelection
} from './SpeechModelPicker'

/**
 * Settings, Speech: one model row (a select of the models ready to use, plus "Get more models")
 * and the dialog that downloads and deletes the models that run on this computer.
 */
export interface SpeechModelSettingProps<S extends SpeechSelection, M extends LocalModelManifest> {
  title: string
  description: string
  /** Title of the "Get more models" dialog. */
  dialogTitle: string
  value: S | null
  onSelect: (selection: S) => void
  providerModels: SpeechProviderModel[] | null
  providerSelection: (model: SpeechProviderModel) => S
  localModels: readonly M[]
  localSelection: (model: M) => S
  localApi: LocalModelApi
}

const optionKey = (selection: SpeechSelection): string =>
  selection.source === 'local' ? `local:${selection.modelId}` : `provider:${selection.providerId}:${selection.modelId}`

export function SpeechModelSetting<S extends SpeechSelection, M extends LocalModelManifest>({
  title,
  description,
  dialogTitle,
  value,
  onSelect,
  providerModels,
  providerSelection,
  localModels,
  localSelection,
  localApi
}: SpeechModelSettingProps<S, M>) {
  const selectId = useId()
  const [states, applyStatus] = useLocalModelStates(localApi)
  const [dialogOpen, setDialogOpen] = useState(false)

  // A model downloaded while none is chosen becomes the choice.
  const valueRef = useRef(value)
  useEffect(() => {
    valueRef.current = value
  }, [value])
  const onStatus = (status: LocalModelStatus): void => {
    applyStatus(status)
    if (status.state.status !== 'downloaded' || valueRef.current) return
    const model = localModels.find((item) => item.id === status.modelId)
    if (model) onSelect(localSelection(model))
  }

  const providerGroups = new Map<string, Array<{ key: string; label: string; selection: S }>>()
  for (const model of providerModels ?? []) {
    const selection = providerSelection(model)
    const group = providerGroups.get(model.providerLabel) ?? []
    group.push({ key: optionKey(selection), label: model.label, selection })
    providerGroups.set(model.providerLabel, group)
  }
  const installed = localModels
    .filter((model) => states[model.id]?.status === 'downloaded')
    .map((model) => {
      const selection = localSelection(model)
      return { key: optionKey(selection), label: model.label, selection }
    })
  const options = new Map<string, S>()
  for (const group of providerGroups.values()) for (const option of group) options.set(option.key, option.selection)
  for (const option of installed) options.set(option.key, option.selection)

  const valueKey = value ? optionKey(value) : ''
  // The saved choice stays visible even when its model is no longer listed.
  const orphan = value && !options.has(valueKey) ? value : null
  const empty = options.size === 0 && !orphan

  return (
    <>
      <SettingsRow
        title={title}
        description={description}
        htmlFor={selectId}
        control={
          <>
            <Select
              id={selectId}
              value={valueKey}
              disabled={empty}
              placeholder={empty ? (providerModels === null ? 'Loading models' : 'No models yet') : 'Choose a model'}
              onChange={(key) => {
                const selection = options.get(key)
                if (selection) onSelect(selection)
              }}
              options={[
                ...(orphan ? [{ value: valueKey, label: orphan.label }] : []),
                ...[...providerGroups].flatMap(([providerLabel, group]) =>
                  group.map((option) => ({ value: option.key, label: option.label, group: providerLabel }))
                ),
                ...installed.map((option) => ({ value: option.key, label: option.label, group: 'On this computer' }))
              ]}
            />
            <button type="button" className="settings-btn" onClick={() => setDialogOpen(true)}>
              Get more models
            </button>
          </>
        }
      />
      {dialogOpen && (
        <SpeechModelsDialog
          title={dialogTitle}
          localModels={localModels}
          states={states}
          api={localApi}
          onStatus={onStatus}
          onClose={() => setDialogOpen(false)}
        />
      )}
    </>
  )
}

function SpeechModelsDialog<M extends LocalModelManifest>({
  title,
  localModels,
  states,
  api,
  onStatus,
  onClose
}: {
  title: string
  localModels: readonly M[]
  states: Record<string, LocalModelState | undefined>
  api: LocalModelApi
  onStatus: (status: LocalModelStatus) => void
  onClose: () => void
}) {
  // One list in catalogue order, so a row never jumps when its download finishes; the row's icon
  // and check carry its state.
  return (
    <Modal open title={title} onClose={onClose}>
      <SettingsGroup className="speech-models-list">
        {localModels.map((model) => (
          <DialogModelRow key={model.id} model={model} state={states[model.id] ?? { status: 'not-downloaded' }} api={api} onStatus={onStatus} />
        ))}
      </SettingsGroup>
    </Modal>
  )
}

const RING_R = 12
const RING_C = 2 * Math.PI * RING_R

function DialogModelRow({
  model,
  state,
  api,
  onStatus
}: {
  model: LocalModelManifest
  state: LocalModelState
  api: LocalModelApi
  onStatus: (status: LocalModelStatus) => void
}) {
  const { download, cancel, remove, deleting, size } = useLocalModelActions(model, api, onStatus)

  let description: ReactNode = `${size} · ${model.description}`
  let control: ReactNode
  if (state.status === 'downloading') {
    const percent = downloadPercent(state)
    description = `Downloading · ${percent}% of ${size}`
    control = (
      <span className="speech-models-progress">
        <svg
          viewBox="0 0 28 28"
          role="progressbar"
          aria-label={`Downloading ${model.label}`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
        >
          <circle className="speech-models-progress-track" cx="14" cy="14" r={RING_R} />
          <circle
            className="speech-models-progress-fill"
            cx="14"
            cy="14"
            r={RING_R}
            strokeDasharray={RING_C}
            strokeDashoffset={RING_C * (1 - percent / 100)}
          />
        </svg>
        <button type="button" className="settings-icon-btn speech-models-action" title="Cancel download" aria-label={`Cancel downloading ${model.label}`} onClick={cancel}>
          <X size={12} strokeWidth={2.2} />
        </button>
      </span>
    )
  } else if (state.status === 'downloaded') {
    control = (
      <button type="button" className="settings-icon-btn" title="Delete" aria-label={`Delete ${model.label}`} disabled={deleting} onClick={remove}>
        <Trash2 size={15} />
      </button>
    )
  } else if (state.status === 'error') {
    description = (
      <span className="speech-models-error" role="alert">
        {state.message}
      </span>
    )
    control = (
      <button type="button" className="settings-icon-btn speech-models-action" title="Try again" aria-label={`Retry downloading ${model.label}`} onClick={download}>
        <RotateCcw size={15} />
      </button>
    )
  } else {
    control = (
      <button type="button" className="settings-icon-btn speech-models-action accent" title="Download" aria-label={`Download ${model.label}`} onClick={download}>
        <Download size={16} />
      </button>
    )
  }

  return (
    <SettingsRow
      title={model.label}
      titleAction={
        state.status === 'downloaded' ? (
          <span className="speech-models-check" role="img" title="On this computer" aria-label="On this computer">
            <Check size={14} strokeWidth={2.2} />
          </span>
        ) : undefined
      }
      description={description}
      control={control}
    />
  )
}
