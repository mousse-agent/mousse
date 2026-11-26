import { useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import type { StatusDescription } from '../../../shared/harness/status'
import { ProviderIcon } from '../../lib/providerIcons'
import { Check, CircleArrowUp, Copy, Folder, RefreshCw } from '../../lib/icons'
import { Switch } from '../settings/SettingsRow'
import { ipcErrorMessage } from '../../utils/voiceErrors'
import { ProvidersComputerContext } from '../../lib/providersComputer'

/** Only warning and error show a dot. */
export function needsAttention(status: StatusDescription): boolean {
  return status.tone === 'warning' || status.tone === 'error'
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

/**
 * The status said once: the headline, and the detail unless it only repeats the command shown
 * below the row (a terminal sign-in's message names the command it asks for).
 */
export function statusText(status: StatusDescription): string {
  const detail = statusDetail(status)
  return detail ? `${status.headline} · ${detail}` : status.headline
}

/** The detail after the headline, unless it only repeats the headline or the next step's command. */
function statusDetail(status: StatusDescription): string | null {
  const command = status.nextStep?.command
  return status.detail && status.detail !== status.headline && !(command && status.detail.includes(command)) ? status.detail : null
}

/** The headline alone, for the provider list: "Signed in", "Not found", "Checking". */
export function shortStatus(status: StatusDescription): string {
  const head = status.headline.split(' · ')[0] ?? status.headline
  return head === 'Checking status' ? 'Checking' : head
}

/** The list's status: a few words, and a dot when the provider needs attention; the editor says the rest. */
export function CompactStatus({ status }: { status: StatusDescription }) {
  return (
    <span className="prov-status is-compact" title={statusText(status)} aria-live="polite">
      {needsAttention(status) && <span className={`prov-dot is-${status.tone}`} aria-hidden="true" />}
      <span className="prov-status-text">{shortStatus(status)}</span>
    </span>
  )
}

/** The editor's Setup → Status: the headline in a badge of the tone's colour, the detail under it. */
export function StatusLine({ status, title }: { status: StatusDescription; title?: string }) {
  return (
    <span className={`prov-status-text is-${status.tone}`} title={title} aria-live="polite">
      <span className="prov-status-badge">{status.headline}</span>
      {statusDetail(status) && <span className="prov-status-detail">{statusDetail(status)}</span>}
    </span>
  )
}

/** A text field with its one icon action (browse, remove) inside its right end, like a select's chevron. */
export function FieldWithAction({ children, action }: { children: ReactNode; action: ReactNode }) {
  return (
    <span className="prov-field">
      {children}
      <span className="prov-field-action">{action}</span>
    </span>
  )
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
  // This computer's file picker cannot choose a path on another computer: its path is typed instead.
  const remote = Boolean(useContext(ProvidersComputerContext).node)
  if (remote) return null
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

/** A command to run in a terminal, with a copy button: the advisory update, a terminal sign-in. */
export function CommandBox({ command, label = 'Copy command', onCopy }: { command: string; label?: string; onCopy?: () => void }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1600)
    return () => clearTimeout(timer)
  }, [copied])
  return (
    <span className="prov-command">
      <code className="prov-command-text" title={command}>
        {command}
      </code>
      <button
        type="button"
        className="settings-icon-btn prov-micro"
        title={copied ? 'Copied' : label}
        aria-label={label}
        onClick={() => void navigator.clipboard.writeText(command).then(() => { setCopied(true); onCopy?.() })}
      >
        {copied ? <Check size={12} /> : <Copy size={12} />}
      </button>
    </span>
  )
}

/**
 * A provider in the list pane: logo, name and version, then the status
 * line; the enable switch on the right. Selection is a background fill only. Switched off, the row
 * is dimmed until hovered or selected.
 */
export function ProviderListRow({
  iconId,
  name,
  version,
  update,
  status,
  enabled,
  selected,
  onSelect,
  onToggle
}: {
  iconId: string
  name: string
  version?: string
  /** An update is available: a small button takes the version's place, off while it runs. */
  update?: { label: string; busy?: boolean; onClick: () => void }
  status: StatusDescription
  /** The provider is on for the computer the page shows. */
  enabled: boolean
  selected: boolean
  onSelect: () => void
  onToggle: (enabled: boolean) => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const run = (action: () => Promise<void>) => {
    setBusy(true)
    void action().finally(() => setBusy(false))
  }
  return (
    <div className={`prov-item${selected ? ' is-selected' : ''}${enabled ? '' : ' is-off'}`}>
      <div className="prov-item-main">
        <button type="button" className="prov-item-hit" onClick={onSelect} aria-label={`Select ${name}`} aria-pressed={selected} />
        <span className="prov-logo">
          <ProviderIcon providerId={iconId} size={16} />
        </span>
        <span className="prov-item-text">
          <span className="prov-item-title">
            <span className="prov-item-name">{name}</span>
            {/* An update takes the version's place, so the name keeps its room. */}
            {update ? (
              <button
                type="button"
                className="settings-icon-btn prov-micro prov-item-update"
                title={version ? `${update.label} (now ${version})` : update.label}
                aria-label={update.label}
                disabled={update.busy}
                aria-busy={update.busy}
                onClick={update.onClick}
              >
                <CircleArrowUp size={14} />
              </button>
            ) : (
              version && <code className="prov-version">{version}</code>
            )}
          </span>
          <CompactStatus status={status} />
        </span>
      </div>
      <span className="prov-item-controls">
        <Switch checked={enabled} label={`Enable ${name}`} disabled={busy} onChange={(next) => run(() => onToggle(next))} />
      </span>
    </div>
  )
}

/** An editor section: heading on the page, rows on one surface (Mousse's SettingsGroup), with an optional custom title. */
export function EditorSection({
  title,
  action,
  description,
  anchor,
  children
}: {
  title: ReactNode
  action?: ReactNode
  description?: ReactNode
  /** Where a settings search result lands (lib/settingsSearch.ts). */
  anchor?: string
  children: ReactNode
}) {
  return (
    <section className="settings-group prov-editor-section" data-settings-anchor={anchor}>
      <div className="settings-group-head">
        <div className="settings-group-head-text">
          <h3 className="settings-group-title">{title}</h3>
          {description && <p className="settings-group-desc">{description}</p>}
        </div>
        {action && <div className="settings-group-action">{action}</div>}
      </div>
      <div className="settings-group-rows">{children}</div>
    </section>
  )
}

/** "Checked 2 min ago", ticking. */
export function useRelativeTime(at: number | null): string | null {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000)
    return () => clearInterval(timer)
  }, [])
  if (at === null) return null
  const seconds = Math.max(0, Math.round((now - at) / 1000))
  if (seconds < 45) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  return `${Math.round(hours / 24)} d ago`
}
