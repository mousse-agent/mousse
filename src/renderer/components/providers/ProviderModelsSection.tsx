import { useState } from 'react'
import type { InstanceSnapshot } from '../../../shared/harness/status'
import type { CustomModel, InstanceModel, ModelCapabilities, ModelPrefsPatch } from '../../../shared/harness/types'
import { EFFORT_LEVELS, formatEffortLabel } from '../../../shared/modelVariants'
import { ArrowDown, ArrowUp, Pencil, Plus, Star, X } from '../../lib/icons'
import { Switch } from '../settings/SettingsRow'
import { RefreshButton, useAsyncAction } from './parts'

const FILTER_THRESHOLD = 8

type ModelGroup = 'favorite' | 'visible' | 'hidden'

/** T3 Code's grouping: favorites, then the rest, then models hidden from the picker. */
export function modelGroupOf(model: Pick<InstanceModel, 'favorite' | 'hidden' | 'source'>): ModelGroup {
  if (model.favorite) return 'favorite'
  return isHiddenInPicker(model) ? 'hidden' : 'visible'
}

/** Hidden from the picker; custom models are always shown. */
export function isHiddenInPicker(model: Pick<InstanceModel, 'hidden' | 'source'>): boolean {
  return model.source !== 'custom' && model.hidden
}

/** The snapshot's models (already in the saved order) grouped for display. */
export function displayModels(entries: readonly InstanceModel[]): InstanceModel[] {
  return [
    ...entries.filter((model) => modelGroupOf(model) === 'favorite'),
    ...entries.filter((model) => modelGroupOf(model) === 'visible'),
    ...entries.filter((model) => modelGroupOf(model) === 'hidden')
  ]
}

/** The order after moving one model up or down within its group; null when it cannot move. */
export function movedOrder(display: readonly InstanceModel[], id: string, direction: -1 | 1): string[] | null {
  const index = display.findIndex((model) => model.id === id)
  const target = index + direction
  if (index < 0 || target < 0 || target >= display.length) return null
  if (modelGroupOf(display[index]!) !== modelGroupOf(display[target]!)) return null
  const order = display.map((model) => model.id)
  ;[order[index], order[target]] = [order[target]!, order[index]!]
  return order
}

/**
 * "Hide all" or "Show all": an edit of the built-in models only, so a custom model's stored hidden
 * flag is left as it is.
 */
export function bulkVisibilityPatch(entries: readonly InstanceModel[]): ModelPrefsPatch {
  const builtIn = entries.filter((model) => model.source !== 'custom')
  const ids = builtIn.map((model) => model.id)
  return builtIn.length > 0 && builtIn.every((model) => model.hidden) ? { unhide: ids } : { hide: ids }
}

function customOf(entries: readonly InstanceModel[]): CustomModel[] {
  return entries
    .filter((model) => model.source === 'custom')
    .map((model) => ({ id: model.id, ...(model.label !== model.id ? { label: model.label } : {}), capabilities: model.capabilities }))
}

/** "High, Max · Images · 200k context": what a model can do, for its row. */
export function describeCapabilities(capabilities: ModelCapabilities): string {
  const parts: string[] = []
  if (capabilities.efforts.length > 0) parts.push(capabilities.efforts.map(formatEffortLabel).join(', '))
  if (capabilities.images) parts.push('Images')
  if (capabilities.contextWindow) parts.push(`${Math.round(capabilities.contextWindow / 1000)}k context`)
  return parts.join(' · ')
}

/**
 * T3 Code's provider Models section on the instance's snapshot: counter, filter past eight models,
 * favorites first, a show-in-picker switch and move up/down per model, bulk hide/show, and
 * custom models with their capabilities stated. Every change is saved to the daemon's model prefs.
 */
export function ProviderModelsSection({
  snapshot,
  allowCustom,
  onSave,
  onRefresh
}: {
  snapshot: InstanceSnapshot
  allowCustom: boolean
  onSave: (patch: ModelPrefsPatch) => Promise<void>
  onRefresh: () => Promise<void>
}) {
  const [filter, setFilter] = useState('')
  const [editing, setEditing] = useState<{ original?: CustomModel } | null>(null)
  const save = useAsyncAction()
  const refresh = useAsyncAction()

  const entries = snapshot.models.entries
  const display = displayModels(entries)
  const hidden = entries.filter((model) => model.hidden && model.source !== 'custom').map((model) => model.id)
  const builtIn = entries.filter((model) => model.source !== 'custom')
  const favoriteCount = entries.filter((model) => model.favorite).length
  const showFilter = entries.length > FILTER_THRESHOLD
  const query = filter.trim().toLowerCase()
  const filtering = showFilter && query.length > 0
  const visible = filtering ? display.filter((model) => model.label.toLowerCase().includes(query) || model.id.toLowerCase().includes(query)) : display
  const allHidden = builtIn.length > 0 && builtIn.every((model) => model.hidden)

  const write = (patch: ModelPrefsPatch) => void save.run('save', () => onSave(patch))
  // Stars and hides are edits of the stored lists, so a save in flight is never undone by this one.
  const setHidden = (id: string, hide: boolean) => write(hide ? { hide: [id] } : { unhide: [id] })
  const toggleFavorite = (model: InstanceModel) => write(model.favorite ? { unstar: [model.id] } : { star: [model.id] })
  const move = (id: string, direction: -1 | 1) => {
    const order = movedOrder(display, id, direction)
    if (order) write({ order })
  }
  const saveCustom = async (next: CustomModel, original?: CustomModel) => {
    const custom = customOf(entries)
    await onSave({ custom: original ? custom.map((entry) => (entry.id === original.id ? next : entry)) : [...custom, next] })
    setEditing(null)
  }
  const removeCustom = (id: string) => write({ custom: customOf(entries).filter((entry) => entry.id !== id) })

  const groupLabel = (text: string, first: boolean) => <div className={`prov-models-group${first ? ' is-first' : ''}`}>{text}</div>

  return (
    <div className="prov-models">
      <div className="prov-models-bar">
        {showFilter && (
          <input
            className="settings-input prov-models-filter"
            value={filter}
            placeholder="Filter models"
            aria-label="Filter models"
            spellCheck={false}
            onChange={(event) => setFilter(event.target.value)}
          />
        )}
        <span className="prov-models-meta">
          {builtIn.length > 0 && (
            <button type="button" className="prov-ghost-btn" onClick={() => write(bulkVisibilityPatch(entries))}>
              {allHidden ? 'Show all' : 'Hide all'}
            </button>
          )}
          <span className="prov-models-count">
            {entries.length} model{entries.length === 1 ? '' : 's'}
            {favoriteCount > 0 ? ` · ${favoriteCount} favorite${favoriteCount === 1 ? '' : 's'}` : ''}
            {hidden.length > 0 ? ` · ${hidden.length} hidden` : ''}
          </span>
        </span>
        <span className="prov-models-actions">
          {allowCustom && !editing && (
            <button type="button" className="prov-ghost-btn" onClick={() => setEditing({})}>
              <Plus size={12} />
              Add custom model
            </button>
          )}
          <RefreshButton label="Refresh models" busy={refresh.busy === 'refresh'} onClick={() => void refresh.run('refresh', onRefresh)} />
        </span>
      </div>
      {(refresh.error ?? save.error ?? snapshot.models.error) && <p className="prov-error">{refresh.error ?? save.error ?? snapshot.models.error}</p>}

      <div className="prov-models-list">
        {visible.length === 0 && <p className="prov-models-empty">{filtering ? 'No models match.' : 'No models reported for this provider yet.'}</p>}
        {visible.map((model, index) => {
          const group = modelGroupOf(model)
          const previous = visible[index - 1]
          const next = visible[index + 1]
          const startsGroup = previous === undefined || modelGroupOf(previous) !== group
          const custom = model.source === 'custom'
          // A hidden favorite stays in Favorites, so its own flag says whether it is hidden.
          const isHidden = isHiddenInPicker(model)
          const capabilities = describeCapabilities(model.capabilities)
          return (
            <div key={`${model.source}:${model.id}`}>
              {startsGroup && favoriteCount > 0 && group === 'favorite' && groupLabel('Favorites', index === 0)}
              {startsGroup && favoriteCount > 0 && group === 'visible' && groupLabel('All', index === 0)}
              {startsGroup && group === 'hidden' && groupLabel('Hidden from picker', index === 0)}
              <div className={`prov-model-row${isHidden ? ' is-hidden' : ''}`}>
                <button
                  type="button"
                  className={`settings-icon-btn prov-micro prov-star${model.favorite ? ' is-on' : ''}`}
                  title={model.favorite ? 'Remove from favorites' : 'Add to favorites'}
                  aria-label={`${model.favorite ? 'Remove' : 'Add'} ${model.label} ${model.favorite ? 'from' : 'to'} favorites`}
                  aria-pressed={model.favorite}
                  onClick={() => toggleFavorite(model)}
                >
                  <Star size={13} />
                </button>
                <span className="prov-model-main">
                  <span className="prov-model-text">
                    <span className="prov-model-name">{model.label}</span>
                    {model.label !== model.id && <code className="prov-model-detail">{model.id}</code>}
                    {custom && <span className="prov-model-detail">custom</span>}
                  </span>
                  <span className="prov-model-caps">{capabilities}</span>
                </span>
                <span className="prov-model-actions">
                  {group !== 'hidden' && !filtering && (
                    <>
                      <button
                        type="button"
                        className="settings-icon-btn prov-micro"
                        title="Move up"
                        aria-label={`Move ${model.label} up`}
                        disabled={previous === undefined || modelGroupOf(previous) !== group}
                        onClick={() => move(model.id, -1)}
                      >
                        <ArrowUp size={12} />
                      </button>
                      <button
                        type="button"
                        className="settings-icon-btn prov-micro"
                        title="Move down"
                        aria-label={`Move ${model.label} down`}
                        disabled={next === undefined || modelGroupOf(next) !== group}
                        onClick={() => move(model.id, 1)}
                      >
                        <ArrowDown size={12} />
                      </button>
                    </>
                  )}
                  {custom && allowCustom && (
                    <>
                      <button
                        type="button"
                        className="settings-icon-btn prov-micro"
                        title="Edit name and options"
                        aria-label={`Edit ${model.id}`}
                        onClick={() => setEditing({ original: customOf([model])[0] })}
                      >
                        <Pencil size={12} />
                      </button>
                      <button
                        type="button"
                        className="settings-icon-btn prov-micro danger"
                        title="Remove custom model"
                        aria-label={`Remove ${model.id}`}
                        onClick={() => removeCustom(model.id)}
                      >
                        <X size={12} />
                      </button>
                    </>
                  )}
                </span>
                <span title={custom ? 'Custom models are always shown in the picker' : isHidden ? 'Hidden from picker' : 'Shown in picker'}>
                  <Switch
                    checked={!isHidden}
                    disabled={custom}
                    label={`Show ${model.label} in the model picker`}
                    onChange={(show) => setHidden(model.id, !show)}
                  />
                </span>
              </div>
            </div>
          )
        })}
      </div>

      {allowCustom && editing && (
        <CustomModelEditor
          key={editing.original?.id ?? 'new'}
          original={editing.original}
          taken={entries.map((model) => model.id)}
          onSave={(next) => saveCustom(next, editing.original)}
          onCancel={() => setEditing(null)}
        />
      )}
    </div>
  )
}

/**
 * Adds or edits a custom model. Its capabilities are stated, not guessed: which reasoning efforts
 * it accepts, whether it takes images, and its context window when known.
 */
function CustomModelEditor({
  original,
  taken,
  onSave,
  onCancel
}: {
  original?: CustomModel
  taken: readonly string[]
  onSave: (model: CustomModel) => Promise<void>
  onCancel: () => void
}) {
  const [id, setId] = useState(original?.id ?? '')
  const [label, setLabel] = useState(original?.label ?? '')
  const [efforts, setEfforts] = useState<string[]>(original?.capabilities.efforts ?? [])
  const [images, setImages] = useState(original?.capabilities.images ?? false)
  const [contextWindow, setContextWindow] = useState(original?.capabilities.contextWindow ? String(original.capabilities.contextWindow) : '')
  const { busy, error, setError, run } = useAsyncAction()

  const submit = () => {
    const slug = id.trim()
    if (!slug) return setError('Enter a model id.')
    if (slug !== original?.id && taken.includes(slug)) return setError('That model is already listed.')
    const tokens = contextWindow.trim() ? Number(contextWindow.trim()) : undefined
    if (tokens !== undefined && (!Number.isInteger(tokens) || tokens <= 0)) return setError('Context window is a whole number of tokens.')
    void run('save', () =>
      onSave({
        id: slug,
        ...(label.trim() ? { label: label.trim() } : {}),
        capabilities: { efforts: EFFORT_LEVELS.filter((level) => efforts.includes(level)), images, ...(tokens ? { contextWindow: tokens } : {}) }
      })
    )
  }

  return (
    <div
      className="prov-models-add"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          onCancel()
        }
      }}
    >
      <div className="prov-models-add-row">
        <input
          className="settings-input prov-mono"
          autoFocus={!original}
          value={id}
          disabled={Boolean(original)}
          placeholder="model-id"
          aria-label="Custom model id"
          spellCheck={false}
          onChange={(event) => {
            setId(event.target.value)
            setError(null)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') submit()
          }}
        />
        <input
          className="settings-input"
          value={label}
          placeholder="Display name (optional)"
          aria-label="Custom model display name"
          onChange={(event) => setLabel(event.target.value)}
        />
      </div>
      <div className="prov-models-add-row">
        <span className="prov-models-add-label">Reasoning</span>
        <span className="prov-chips" role="group" aria-label="Reasoning efforts it accepts">
          {EFFORT_LEVELS.map((level) => {
            const on = efforts.includes(level)
            return (
              <button
                key={level}
                type="button"
                className={`prov-chip${on ? ' is-on' : ''}`}
                aria-pressed={on}
                onClick={() => setEfforts((current) => (on ? current.filter((entry) => entry !== level) : [...current, level]))}
              >
                {formatEffortLabel(level)}
              </button>
            )
          })}
        </span>
      </div>
      <div className="prov-models-add-row">
        <label className="prov-models-add-label" htmlFor="prov-custom-images">
          Images
        </label>
        <Switch id="prov-custom-images" checked={images} label="Accepts images" onChange={setImages} />
        <input
          className="settings-input prov-models-add-window"
          inputMode="numeric"
          value={contextWindow}
          placeholder="Context window (tokens)"
          aria-label="Context window in tokens"
          onChange={(event) => setContextWindow(event.target.value.replace(/[^\d]/g, ''))}
        />
        <span className="prov-models-add-actions">
          <button type="button" className="settings-btn" disabled={busy !== null} onClick={submit}>
            {original ? 'Save' : 'Add'}
          </button>
          <button type="button" className="settings-btn" disabled={busy !== null} onClick={onCancel}>
            Cancel
          </button>
        </span>
      </div>
      {error && <p className="prov-error">{error}</p>}
    </div>
  )
}
