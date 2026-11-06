import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { localModelBytes, type LocalModelManifest, type LocalModelState, type LocalModelStatus } from '../../shared/localModels'
import { Modal } from '../components/ui/Modal'
import { ChevronLeft, ChevronRight, Download, Plus, RotateCcw, Trash2, X } from '../lib/icons'
import { SettingsGroup, SettingsRow } from '../components/settings/SettingsRow'
import { Select } from '../components/ui/Select'
import { Spinner } from '../components/ui/Spinner'
import { isBestValue, pickModels, type ModelComparison, type ModelMetric, type ModelPick } from './modelComparison'
import {
  downloadPercent,
  formatModelSize,
  useLocalModelActions,
  useLocalModelStates,
  type LocalModelApi,
  type SpeechProviderModel,
  type SpeechSelection
} from './SpeechModelPicker'

/**
 * Settings, Speech: one model row (a select of the models ready to use, plus "Get more models";
 * with none ready, only "Add model", which opens the same dialog) and the dialog that compares, downloads, deletes and picks the models that run on this computer.
 */
export interface SpeechModelSettingProps<S extends SpeechSelection, M extends LocalModelManifest> {
  title: string
  description: string
  /** Title of the "Get more models" dialog. */
  dialogTitle: string
  /** Accessible name of the one add action shown while no model is ready, e.g. "Add a dictation model". */
  addLabel: string
  value: S | null
  onSelect: (selection: S) => void
  providerModels: SpeechProviderModel[] | null
  providerSelection: (model: SpeechProviderModel) => S
  localModels: readonly M[]
  localSelection: (model: M) => S
  localApi: LocalModelApi
  /** The figures the dialog compares and how it picks its columns. */
  comparison: ModelComparison<M>
}

/** How long the models may take before the select shows its loader, so a quick load never flashes one. */
export const MODELS_PENDING_DELAY_MS = 160

/** The select's content while models load: empty at first, then a small spinner read as "Loading models". */
function PendingModels() {
  const [shown, setShown] = useState(false)
  useEffect(() => {
    const timer = window.setTimeout(() => setShown(true), MODELS_PENDING_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [])
  return shown ? <span className="speech-models-pending" role="status" aria-label="Loading models"><Spinner size={14} /></span> : null
}

const optionKey = (selection: SpeechSelection): string =>
  selection.source === 'local' ? `local:${selection.modelId}` : `provider:${selection.providerId}:${selection.modelId}`

export function SpeechModelSetting<S extends SpeechSelection, M extends LocalModelManifest>({
  title,
  description,
  dialogTitle,
  addLabel,
  value,
  onSelect,
  providerModels,
  providerSelection,
  localModels,
  localSelection,
  localApi,
  comparison
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
  // With nothing to choose from, the select would be dead: adding a model is the one action.
  const needsModel = empty && providerModels !== null

  return (
    <>
      <SettingsRow
        title={title}
        description={description}
        htmlFor={needsModel ? undefined : selectId}
        control={
          needsModel ? (
            <button type="button" className="settings-btn" aria-label={addLabel} title={addLabel} onClick={() => setDialogOpen(true)}>
              <Plus size={14} aria-hidden="true" />
              Add model
            </button>
          ) : (
            <>
              <Select
                id={selectId}
                value={valueKey}
                disabled={empty}
                placeholder={empty ? <PendingModels /> : 'Choose a model'}
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
          )
        }
      />
      {dialogOpen && (
        <SpeechModelsDialog
          title={dialogTitle}
          localModels={localModels}
          comparison={comparison}
          states={states}
          api={localApi}
          onStatus={onStatus}
          inUseId={value?.source === 'local' ? value.modelId : null}
          onUse={(model) => onSelect(localSelection(model))}
          onClose={() => setDialogOpen(false)}
        />
      )}
    </>
  )
}

interface DialogModelProps<M extends LocalModelManifest> {
  states: Record<string, LocalModelState | undefined>
  api: LocalModelApi
  onStatus: (status: LocalModelStatus) => void
  /** The local model the feature uses now, if any. */
  inUseId: string | null
  onUse: (model: M) => void
}

export function SpeechModelsDialog<M extends LocalModelManifest>({
  title,
  localModels,
  comparison,
  onClose,
  ...modelProps
}: DialogModelProps<M> & {
  title: string
  localModels: readonly M[]
  comparison: ModelComparison<M>
  onClose: () => void
}) {
  const [view, setView] = useState<'compare' | 'all'>('compare')
  const picks = pickModels(localModels, comparison.picks)
  const tags = new Map(picks.map((pick) => [pick.model.id, pick.tag]))
  const remaining = localModels.length - picks.length

  // Focus follows the switch: Back on the list, the row that opened it on the way back.
  const backRef = useRef<HTMLButtonElement>(null)
  const moreRef = useRef<HTMLButtonElement>(null)
  const switched = useRef(false)
  useEffect(() => {
    if (!switched.current) return
    ;(view === 'all' ? backRef : moreRef).current?.focus()
  }, [view])
  const show = (next: 'compare' | 'all'): void => {
    switched.current = true
    setView(next)
  }

  return (
    <Modal
      open
      title={view === 'compare' ? title : `All ${title.toLowerCase()}`}
      className="speech-models-dialog"
      onClose={onClose}
      headerStart={
        view === 'all' ? (
          <button ref={backRef} type="button" className="settings-icon-btn speech-models-back" title="Back" aria-label="Back" onClick={() => show('compare')}>
            <ChevronLeft size={16} />
          </button>
        ) : undefined
      }
    >
      {view === 'compare' ? (
        <>
          <ModelComparisonTable picks={picks} metrics={comparison.metrics} {...modelProps} />
          <button ref={moreRef} type="button" className="speech-models-more" onClick={() => show('all')}>
            <span>{remaining > 0 ? `${remaining} more ${remaining === 1 ? 'model' : 'models'}` : 'All models'}</span>
            <ChevronRight size={16} />
          </button>
        </>
      ) : (
        <AllModels models={localModels} tags={tags} metrics={comparison.metrics} {...modelProps} />
      )}
    </Modal>
  )
}

// ---------------------------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------------------------

const stateOf = (states: DialogModelProps<LocalModelManifest>['states'], id: string): LocalModelState => states[id] ?? { status: 'not-downloaded' }

function ModelComparisonTable<M extends LocalModelManifest>({
  picks,
  metrics,
  ...modelProps
}: DialogModelProps<M> & { picks: ReadonlyArray<ModelPick<M>>; metrics: ReadonlyArray<ModelMetric<M>> }) {
  const { states } = modelProps
  // A row none of the columns has a figure for says nothing.
  const rows = metrics.filter((metric) => picks.some((pick) => metric.value(pick.model) !== undefined))
  const at = (column: number, row: number): CSSProperties => ({ gridColumn: column + 1, gridRow: row + 1 })
  const downloadRow = rows.length + 1
  const actionRow = rows.length + 2
  const recommended = picks.findIndex((pick) => pick.tag === 'Recommended')

  return (
    <div className="speech-compare" role="table" aria-label="Model comparison" style={{ gridTemplateColumns: `minmax(132px, auto) repeat(${picks.length}, minmax(0, 1fr))` }}>
      {recommended >= 0 && <div className="speech-compare-panel" aria-hidden="true" style={{ gridColumn: recommended + 2, gridRow: `1 / ${actionRow + 2}` }} />}
      <div role="row" className="speech-compare-row">
        <span role="columnheader" style={at(0, 0)} />
        {picks.map((pick, index) => (
          <div key={pick.model.id} role="columnheader" className="speech-compare-head" style={at(index + 1, 0)}>
            <span className={`speech-models-tag${index === recommended ? ' recommended' : ''}`}>{pick.tag}</span>
            <span className="speech-compare-name">{pick.model.label}</span>
            <span className="speech-compare-desc">{pick.model.description}</span>
          </div>
        ))}
      </div>
      {rows.map((metric, row) => {
        const values = picks.map((pick) => metric.value(pick.model))
        return (
          <div key={metric.label} role="row" className="speech-compare-row">
            <span role="rowheader" className="speech-compare-label" title={metric.hint} style={at(0, row + 1)}>
              {metric.label}
            </span>
            {picks.map((pick, index) => {
              const value = values[index]
              const best = isBestValue(value, values, metric.best)
              return (
                <span key={pick.model.id} role="cell" className={`speech-compare-cell${best ? ' best' : ''}`} style={at(index + 1, row + 1)}>
                  {value === undefined ? '—' : metric.cell(value, pick.model)}
                </span>
              )
            })}
          </div>
        )
      })}
      <div role="row" className="speech-compare-row">
        <span role="rowheader" className="speech-compare-label" style={at(0, downloadRow)}>
          Download
        </span>
        {picks.map((pick, index) => (
          <span key={pick.model.id} role="cell" className="speech-compare-cell" style={at(index + 1, downloadRow)}>
            <DownloadCell model={pick.model} state={stateOf(states, pick.model.id)} />
          </span>
        ))}
      </div>
      <div role="row" className="speech-compare-row">
        <span role="rowheader" style={at(0, actionRow)} />
        {picks.map((pick, index) => (
          <span key={pick.model.id} role="cell" className="speech-compare-cell speech-compare-action" style={at(index + 1, actionRow)}>
            <ModelActions model={pick.model} variant="compare" {...modelProps} />
          </span>
        ))}
      </div>
    </div>
  )
}

function DownloadCell({ model, state }: { model: LocalModelManifest; state: LocalModelState }) {
  switch (state.status) {
    case 'downloaded':
      return <>Downloaded</>
    case 'downloading':
      return <>{downloadPercent(state)}%</>
    case 'error':
      return (
        <span className="speech-models-error" role="alert" title={state.message}>
          Download failed
        </span>
      )
    default:
      return <>{formatModelSize(localModelBytes(model))}</>
  }
}

// ---------------------------------------------------------------------------------------------
// All models
// ---------------------------------------------------------------------------------------------

/** English-only models first, then the rest, each group in catalogue order. */
function languageGroups<M extends LocalModelManifest>(models: readonly M[]): Array<{ title: string; models: M[] }> {
  const english = models.filter((model) => model.compare?.languages?.count === 1 && model.compare.languages.name === 'English')
  const other = models.filter((model) => !english.includes(model))
  return [
    { title: 'English', models: english },
    { title: 'Other languages', models: other }
  ].filter((group) => group.models.length > 0)
}

function AllModels<M extends LocalModelManifest>({
  models,
  tags,
  metrics,
  ...modelProps
}: DialogModelProps<M> & { models: readonly M[]; tags: ReadonlyMap<string, string>; metrics: ReadonlyArray<ModelMetric<M>> }) {
  return (
    <div className="speech-models-all">
      {languageGroups(models).map((group) => (
        <section key={group.title} className="speech-models-group" aria-label={group.title}>
          <h4 className="speech-models-group-title">{group.title}</h4>
          <SettingsGroup className="speech-models-list">
            {group.models.map((model) => (
              <ModelListRow key={model.id} model={model} tag={tags.get(model.id)} metrics={metrics} {...modelProps} />
            ))}
          </SettingsGroup>
        </section>
      ))}
    </div>
  )
}

function ModelListRow<M extends LocalModelManifest>({
  model,
  tag,
  metrics,
  ...modelProps
}: DialogModelProps<M> & { model: M; tag: string | undefined; metrics: ReadonlyArray<ModelMetric<M>> }) {
  const state = stateOf(modelProps.states, model.id)
  const size = formatModelSize(localModelBytes(model))
  let stats: ReactNode
  if (state.status === 'downloading') stats = `Downloading · ${downloadPercent(state)}% of ${size}`
  else if (state.status === 'error') {
    stats = (
      <span className="speech-models-error" role="alert">
        {state.message}
      </span>
    )
  } else {
    const parts = metrics.flatMap((metric) => {
      const value = metric.value(model)
      const text = value === undefined ? '' : metric.stat(value, model)
      // Never repeat what the description line already says ("99 languages").
      return text && !model.description.toLowerCase().includes(text.toLowerCase()) ? [text] : []
    })
    stats = [...parts, size].join(' · ')
  }
  return (
    <SettingsRow
      title={model.label}
      titleAction={tag ? <span className={`speech-models-tag${tag === 'Recommended' ? ' recommended' : ''}`}>{tag}</span> : undefined}
      description={
        <>
          <span className="speech-models-desc">{model.description}</span>
          <span className="speech-models-stats">{stats}</span>
        </>
      }
      control={<ModelActions model={model} variant="list" {...modelProps} />}
    />
  )
}

// ---------------------------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------------------------

const RING_R = 12
const RING_C = 2 * Math.PI * RING_R

/**
 * What can be done with one model: In use, Use (and Delete in the list), Download, the progress
 * ring with Cancel while it downloads, and Retry after a failure.
 */
function ModelActions<M extends LocalModelManifest>({
  model,
  variant,
  states,
  api,
  onStatus,
  inUseId,
  onUse
}: DialogModelProps<M> & { model: M; variant: 'compare' | 'list' }) {
  const { download, cancel, remove, deleting, size } = useLocalModelActions(model, api, onStatus)
  const state = stateOf(states, model.id)

  if (state.status === 'downloading') {
    const percent = downloadPercent(state)
    return (
      <span className="speech-models-progress">
        <svg viewBox="0 0 28 28" role="progressbar" aria-label={`Downloading ${model.label}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
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
  }
  if (state.status === 'downloaded') {
    if (model.id === inUseId) {
      return (
        <span className="speech-models-in-use">
          <span className="speech-models-dot" aria-hidden="true" />
          In use
        </span>
      )
    }
    return (
      <span className="speech-models-actions">
        {variant === 'list' && (
          <button type="button" className="settings-icon-btn" title="Delete" aria-label={`Delete ${model.label}`} disabled={deleting} onClick={remove}>
            <Trash2 size={15} />
          </button>
        )}
        <button type="button" className="settings-btn" aria-label={`Use ${model.label}`} disabled={deleting} onClick={() => onUse(model)}>
          Use
        </button>
      </span>
    )
  }
  if (state.status === 'error') {
    return variant === 'compare' ? (
      <button type="button" className="settings-btn" aria-label={`Retry downloading ${model.label}`} onClick={download}>
        Try again
      </button>
    ) : (
      <button type="button" className="settings-icon-btn speech-models-action" title="Try again" aria-label={`Retry downloading ${model.label}`} onClick={download}>
        <RotateCcw size={15} />
      </button>
    )
  }
  return variant === 'compare' ? (
    <button type="button" className="settings-btn" aria-label={`Download ${model.label}`} onClick={download}>
      Download {size}
    </button>
  ) : (
    <button type="button" className="settings-btn speech-models-get" title="Download" aria-label={`Download ${model.label}`} onClick={download}>
      <Download size={14} />
      {size}
    </button>
  )
}
