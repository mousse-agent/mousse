import { useCallback, useId, useState, type ReactNode } from 'react'
import type { LlmModelOption } from '../../../shared/settings'
import { ProviderIcon } from '../../lib/providerIcons'
import { Folder, RefreshCw } from '../../lib/icons'
import { SettingsRow, Switch } from '../settings/SettingsRow'
import { ipcErrorMessage } from '../../utils/voiceErrors'

/** Row health, shown only as the status dot colour; the words live in its tooltip and label. */
export type Health = 'ready' | 'attention' | 'error' | 'unknown'

export interface HealthState {
  health: Health
  label: string
  /** Longer wording for the tooltip and the expanded sign-in row. */
  detail?: string
}

/** The message without the channel prefix Electron adds to errors from the main process. */
export function errorText(error: unknown): string {
  return ipcErrorMessage(error) || String(error)
}

/** One async action at a time per component, with its error. */
export function useAsyncAction() {
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const run = useCallback(async (key: string, action: () => Promise<unknown>) => {
    setBusy(key)
    setError(null)
    try {
      await action()
    } catch (failure) {
      setError(errorText(failure))
    } finally {
      setBusy(null)
    }
  }, [])
  return { busy, error, setError, run }
}

export function StatusDot({ state, enabled }: { state: HealthState; enabled: boolean }) {
  const label = enabled ? state.label : `Off · ${state.label}`
  const title = state.detail && state.detail !== state.label ? `${label}. ${state.detail}` : label
  return <span className={`prov-dot is-${state.health}`} role="img" aria-label={title} title={title} />
}

/** Icon-only refresh; the glyph spins while busy. */
export function RefreshButton({ label, busy, disabled, onClick }: { label: string; busy?: boolean; disabled?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      className="settings-icon-btn"
      aria-label={label}
      title={label}
      disabled={disabled || busy}
      onClick={onClick}
    >
      <RefreshCw size={14} className={busy ? 'icon-spin' : undefined} />
    </button>
  )
}

export { ConfirmRemoveButton as RemoveButton } from '../settings/IconButtons'

/** Opens the native file picker; `onPick` gets the chosen absolute path (nothing when cancelled). */
export function BrowseButton({
  title,
  defaultPath,
  disabled,
  onPick
}: {
  title: string
  defaultPath?: string
  disabled?: boolean
  onPick: (path: string) => void
}) {
  const [picking, setPicking] = useState(false)
  const browse = async () => {
    setPicking(true)
    try {
      const path = await window.mousse.dialog.pickExecutable({ title, defaultPath: defaultPath || undefined })
      if (path) onPick(path)
    } catch (error) {
      console.error('Executable picker failed', error)
    } finally {
      setPicking(false)
    }
  }
  return (
    <button type="button" className="settings-icon-btn" title={title} aria-label={title} disabled={disabled || picking} onClick={() => void browse()}>
      <Folder size={14} />
    </button>
  )
}

const MODEL_PREVIEW = 10

export function ModelsSubRow({ models, onRefresh }: { models: LlmModelOption[]; onRefresh: () => Promise<void> }) {
  const [showAll, setShowAll] = useState(false)
  const { busy, error, run } = useAsyncAction()
  const shown = showAll ? models : models.slice(0, MODEL_PREVIEW)
  const hidden = models.length - shown.length
  return (
    <SettingsRow
      indent
      title="Models"
      description={
        <>
          {models.length === 0 ? 'None yet' : shown.map((model) => model.label || model.id).join(' · ')}
          {hidden > 0 && (
            <>
              {' '}
              <button type="button" className="prov-link" onClick={() => setShowAll(true)}>
                and {hidden} more
              </button>
            </>
          )}
          {error && <span className="prov-error">{error}</span>}
        </>
      }
      control={<RefreshButton label="Refresh models" busy={busy === 'refresh'} onClick={() => void run('refresh', onRefresh)} />}
    />
  )
}

export function modelCount(models: LlmModelOption[]): string | undefined {
  if (models.length === 0) return undefined
  return `${models.length} model${models.length === 1 ? '' : 's'}`
}

export function formatVersion(version: string | undefined): string | undefined {
  const trimmed = version?.trim()
  if (!trimmed) return undefined
  return /^\d/.test(trimmed) ? `v${trimmed}` : trimmed
}

/**
 * A provider row in the shared row anatomy: logo, name and status dot on the left; the enable
 * switch on the right. Clicking the row opens its details as indented sub-rows below.
 */
export function ProviderRow({
  iconId,
  name,
  version,
  meta,
  state,
  enabled,
  toggleLabel,
  open,
  onOpenChange,
  onToggle,
  children
}: {
  iconId: string
  name: string
  version?: string
  meta?: string
  state: HealthState
  enabled: boolean
  toggleLabel: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onToggle: (enabled: boolean) => Promise<void>
  children: ReactNode
}) {
  const panelId = useId()
  const [toggling, setToggling] = useState(false)
  return (
    <div className={`prov-row${open ? ' is-open' : ''}${enabled ? '' : ' is-off'}`}>
      <div className="prov-row-main" onClick={() => onOpenChange(!open)}>
        <button type="button" className="prov-row-head" aria-expanded={open} aria-controls={open ? panelId : undefined}>
          <span className="prov-logo">
            <ProviderIcon providerId={iconId} size={16} />
          </span>
          <span className="settings-item-text">
            <span className="settings-item-title prov-name">
              {name}
              {version && <span className="prov-version">{version}</span>}
              <StatusDot state={state} enabled={enabled} />
            </span>
            {meta && <span className="settings-item-desc">{meta}</span>}
          </span>
        </button>
        <span className="prov-switch" onClick={(event) => event.stopPropagation()}>
          <Switch
            checked={enabled}
            label={toggleLabel}
            disabled={toggling}
            onChange={(next) => {
              setToggling(true)
              void onToggle(next).finally(() => setToggling(false))
            }}
          />
        </span>
      </div>
      {open && (
        <div className="prov-row-panel" id={panelId}>
          {children}
        </div>
      )}
    </div>
  )
}
