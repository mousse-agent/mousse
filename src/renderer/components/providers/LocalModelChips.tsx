import { useState } from 'react'
import type { InstanceSnapshot } from '../../../shared/harness/status'
import type { InstanceModel } from '../../../shared/harness/types'
import { localChatOnly, localEffectiveWindow, type LocalModelFacts } from '../../../shared/localServers'
import { formatEffortLabel } from '../../../shared/modelVariants'
import { formatWindow, localProviderIdOf } from '../../lib/localModels'
import { useProvidersComputer } from '../../lib/providersComputer'
import { errorText } from './parts'

/** "32768", "32k", "32K" → tokens; anything else is not a window. */
export function parseWindow(text: string): number | undefined {
  const match = /^(\d+)\s*([kKmM]?)$/.exec(text.trim())
  if (!match) return undefined
  const value = Number(match[1]) * (match[2] ? (match[2].toLowerCase() === 'k' ? 1024 : 1024 * 1024) : 1)
  return Number.isSafeInteger(value) && value > 0 ? value : undefined
}

/**
 * A local model's chips on its row: reasoning, its window (`32K`, or `Window unknown · Set`), `Images`, `Chat only`
 * when it runs without tools, `Cloud` when the server runs it elsewhere, and `Check tools` while its tool calling is
 * only reported. Setting the window or checking tools saves on the computer the page shows, then reads the list again.
 */
export function LocalModelChips({
  model,
  local,
  snapshot,
  onChanged
}: {
  model: InstanceModel
  local: LocalModelFacts
  snapshot: InstanceSnapshot
  onChanged: () => Promise<void>
}) {
  const { api } = useProvidersComputer()
  const providerId = localProviderIdOf(snapshot)
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const effective = localEffectiveWindow(local)
  const efforts = model.capabilities.efforts

  const setWindow = async (tokens: number | null) => {
    if (!providerId) return
    setBusy(true)
    setNote(null)
    try {
      if (!(await api.local.setModel({ providerId, modelId: model.id, window: tokens }))) throw new Error('This model is no longer listed.')
      setEditing(false)
      await onChanged()
    } catch (error) {
      setNote(errorText(error))
    } finally {
      setBusy(false)
    }
  }
  const save = () => {
    const tokens = parseWindow(text)
    if (tokens === undefined) return setNote('Enter the window in tokens, like 32768 or 32K.')
    void setWindow(tokens)
  }
  const checkTools = async () => {
    if (!providerId) return
    setBusy(true)
    setNote(null)
    try {
      const result = await api.local.checkTools({ providerId, modelId: model.id })
      if (!result.ok) setNote(result.problem === 'cold' ? 'Load it in its app first' : result.message)
      else await onChanged()
    } catch (error) {
      setNote(errorText(error))
    } finally {
      setBusy(false)
    }
  }

  if (editing) {
    return (
      <span
        className="prov-model-caps prov-local-window-edit"
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            setEditing(false)
            setNote(null)
          }
        }}
      >
        <input
          className="settings-input prov-local-window-input"
          inputMode="numeric"
          autoFocus
          value={text}
          disabled={busy}
          placeholder="32768"
          aria-label={`${model.label} context window in tokens`}
          onChange={(event) => {
            setText(event.target.value)
            setNote(null)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') save()
          }}
        />
        <button type="button" className="prov-text-btn" disabled={busy} onClick={save}>
          Set
        </button>
        {local.windowOverride !== undefined && (
          <button type="button" className="prov-text-btn" disabled={busy} title="Use the window the server reports" onClick={() => void setWindow(null)}>
            Clear
          </button>
        )}
        {note && <span className="prov-local-note is-error">{note}</span>}
      </span>
    )
  }

  const tools = local.tools
  const openEditor = () => {
    setText(local.windowOverride ? String(local.windowOverride) : '')
    setNote(null)
    setEditing(true)
  }
  return (
    <span className="prov-model-caps">
      {efforts.length > 0 && (
        <span className="prov-model-chip" title={`Reasoning: ${efforts.map(formatEffortLabel).join(', ')}`}>
          {efforts.length > 2 ? `${formatEffortLabel(efforts[0]!)}–${formatEffortLabel(efforts[efforts.length - 1]!)}` : efforts.map(formatEffortLabel).join(', ')}
        </span>
      )}
      {effective !== undefined ? (
        <button
          type="button"
          className="prov-model-chip prov-chip-btn"
          title={`${effective.toLocaleString()} token context window${local.windowOverride !== undefined ? ' (set by you)' : ''}. Click to change.`}
          aria-label={`${model.label} context window ${formatWindow(effective)}: change`}
          onClick={openEditor}
        >
          {formatWindow(effective)}
        </button>
      ) : (
        <button
          type="button"
          className="prov-model-chip prov-chip-btn is-attention"
          title="The server does not say how much this model can read. Agent turns need it."
          aria-label={`Set the context window of ${model.label}`}
          onClick={openEditor}
        >
          Window unknown · Set
        </button>
      )}
      {local.images && (
        <span className="prov-model-chip" title="Accepts images">
          Images
        </span>
      )}
      {localChatOnly(local) && (
        <span className="prov-model-chip" title={tools === 'failed' ? 'Failed a tool call check: runs chats without tools' : 'The server says it has no tool calling: runs chats without tools'}>
          Chat only
        </span>
      )}
      {local.cloud && (
        <span className="prov-model-chip" title="Runs on the server's cloud, not on this computer">
          Cloud
        </span>
      )}
      {note && (
        <span className="prov-local-note" role="status">
          {note}
        </span>
      )}
      {(tools === 'reported' || tools === 'unknown') && (
          <button
            type="button"
            className="prov-text-btn"
            disabled={busy}
            title="Run one short tool call on this model, already loaded in its app"
            aria-label={`Check tools of ${model.label}`}
            onClick={() => void checkTools()}
          >
            {busy ? 'Checking…' : 'Check tools'}
          </button>
      )}
    </span>
  )
}
