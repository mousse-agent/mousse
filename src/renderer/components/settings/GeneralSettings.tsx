import { useEffect, useState, type ReactNode } from 'react'
import type { MousseSettings, MousseSettingsUpdate } from '../../../shared/settings'
import type { UpdateState } from '../../../shared/updates'
import { subscribeToUpdates, updateActions, useUpdateStore } from '../../stores/updateStore'
import { InstallConfirm } from '../updates/InstallConfirm'
import { UpdateErrorNotice } from '../updates/UpdateErrorNotice'
import { AlertTriangle, Check, Copy, Download, Info, Loader2, RefreshCw, RotateCcw, ShieldCheck } from '../../lib/icons'
import { normalizeErrorReportSettings } from '../../../shared/bugReports'
import { FiledReportsList } from '../bugReports/FiledReports'
import { describePermissionMode, PERMISSION_MODES } from '../../../shared/permissionMode'
import { PermissionModeLabel } from '../../lib/permissionModeIcon'
import { Select } from '../ui/Select'
import { SettingsGroup, SettingsRow, Switch } from './SettingsRow'
import { RunSettingsGroup } from './RunSettingsGroup'
import { NotificationSettingsGroup } from './NotificationSettingsGroup'

/** Set at build time from package.json (electron.vite.config.ts). */
declare const __MOUSSE_VERSION__: string | undefined
const BUILD_VERSION = typeof __MOUSSE_VERSION__ === 'string' ? __MOUSSE_VERSION__ : ''

export interface GeneralSettingsProps {
  settings: MousseSettings
  onUpdate: (partial: MousseSettingsUpdate) => Promise<void>
}

/** Settings → General: permissions, runs, notifications and the installed version. */
export function GeneralSettings({ settings, onUpdate }: GeneralSettingsProps) {
  return (
    <section id="general" className="settings-section">
      <SettingsGroup title="Permissions" icon={ShieldCheck}>
        <SettingsRow
          title="Default permission mode"
          anchor="general-permission-mode"
          description={<span title="What an agent may do in a new thread without asking. Each thread can change it from the composer.">What an agent may do without asking in new threads.</span>}
          control={
            <Select
              ariaLabel="Default permission mode"
              value={settings.permissions.defaultMode}
              onChange={(defaultMode) => void onUpdate({ permissions: { defaultMode } })}
              options={PERMISSION_MODES.map((mode) => ({ value: mode, label: <PermissionModeLabel mode={mode}>{describePermissionMode(mode)}</PermissionModeLabel>, textValue: describePermissionMode(mode) }))}
            />
          }
        />
      </SettingsGroup>

      <RunSettingsGroup runs={settings.runs} onUpdate={onUpdate} />

      <NotificationSettingsGroup notifications={settings.notifications} onUpdate={onUpdate} />

      <SettingsGroup title="About" icon={Info}>
        <AboutRow />
      </SettingsGroup>

      <ErrorReportsGroup settings={settings} onUpdate={onUpdate} />
    </section>
  )
}

/** Error reports: the Report button on errors (and agents' `report_bug`), who files them, and the reports filed here. */
function ErrorReportsGroup({ settings, onUpdate }: GeneralSettingsProps) {
  const reports = normalizeErrorReportSettings(settings.errorReports)
  const [listOpen, setListOpen] = useState(false)
  return (
    <SettingsGroup title="Error reports" icon={AlertTriangle} anchor="general-error-reports">
      <SettingsRow
        title="Report button"
        anchor="general-report-button"
        description={<span title="Errors show Report, which drafts a public GitHub issue you see first. It is filed from your GitHub account. Agents may ask to file bugs the same way.">Errors offer a public GitHub issue you see first.</span>}
        control={<Switch checked={reports.enabled} label="Report button" onChange={(enabled) => void onUpdate({ errorReports: { ...reports, enabled } })} />}
      />
      {/* The stored `anonymous` flag picks a Mousse relay account that is not running yet; until it does, on means the
          report opens on GitHub, so the switch shows its opposite: filing straight away with gh. */}
      <SettingsRow
        indent
        disabled={!reports.enabled}
        title="File with gh"
        anchor="general-report-with-gh"
        description={<span title="Off: the report opens on GitHub and you submit it there. On: Mousse files it with your gh sign-in. Either way it is a public issue under your GitHub account.">{reports.anonymous ? 'Opens GitHub. Filed from your account (public).' : 'Filed from your GitHub account (public).'}</span>}
        control={<Switch checked={!reports.anonymous} disabled={!reports.enabled} label="File with gh" onChange={(withGh) => void onUpdate({ errorReports: { ...reports, anonymous: !withGh } })} />}
      />
      <SettingsRow
        title="Your reports"
        anchor="general-your-reports"
        description="Reports sent from this computer. Revoke closes the issue."
        control={<button type="button" className="settings-btn" aria-expanded={listOpen} onClick={() => setListOpen((open) => !open)}>{listOpen ? 'Hide' : 'Show'}</button>}
      >
        {listOpen && <FiledReportsList />}
      </SettingsRow>
    </SettingsGroup>
  )
}

function updateStatus(state: UpdateState): string | undefined {
  switch (state.phase) {
    case 'disabled': return state.disabledReason ?? 'Updates are not available in this build.'
    case 'checking': return 'Checking for updates…'
    case 'up-to-date': return 'Up to date'
    case 'available': return `Version ${state.availableVersion} is available`
    case 'downloading': return `Downloading ${state.availableVersion}… ${state.downloadPercent ?? 0}%`
    case 'downloaded':
      if (state.error) return `${state.availableVersion} is downloaded but not installed`
      return state.notAppliedVersion === state.availableVersion ? `${state.availableVersion} did not install last time` : `${state.availableVersion} is ready to install`
    case 'installing': return `Installing ${state.availableVersion}…`
    case 'error': return state.availableVersion ? `Version ${state.availableVersion} is available` : 'The last update check failed.'
    default: return undefined
  }
}

/** Colours only an update ready to install; up to date stays quiet. A failure shows in UpdateErrorNotice. */
function updateStatusClass(state: UpdateState): string | undefined {
  if (state.phase === 'error' || state.error) return undefined
  if (state.notAppliedVersion && state.notAppliedVersion === state.availableVersion) return undefined
  if (state.phase === 'downloaded') return 'settings-status-ok'
  return undefined
}

/** Copies the installed version, for a bug report or a message; a check says it was copied. */
function CopyVersionButton({ version }: { version: string }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])
  const label = copied ? 'Copied' : 'Copy version'
  return (
    <button type="button" className="settings-title-icon-btn" title={label} aria-label={label}
      onClick={() => void navigator.clipboard?.writeText(version).then(() => setCopied(true), () => undefined)}>
      {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
    </button>
  )
}

/** The installed version, with the update check and its progress in the same row. */
function AboutRow() {
  useEffect(() => subscribeToUpdates(), [])
  const state = useUpdateStore()
  const [confirming, setConfirming] = useState(false)
  const version = state.currentVersion || BUILD_VERSION
  const status = updateStatus(state)

  let control: ReactNode
  switch (state.phase) {
    case 'available': {
      const label = `Download ${state.availableVersion}`
      control = <button type="button" className="settings-icon-btn primary" title={label} aria-label={label}
        onClick={() => void updateActions.download()}>
        <Download size={14} />
      </button>
      break
    }
    case 'downloading': {
      // The row description already shows the percentage.
      const label = `Downloading ${state.downloadPercent ?? 0}%`
      control = <button type="button" className="settings-icon-btn primary" title={label} aria-label={label} disabled>
        <Loader2 size={14} className="spin" />
      </button>
      break
    }
    case 'downloaded':
      control = <button type="button" className="settings-btn" onClick={() => setConfirming(true)}>
        <RotateCcw size={14} />Restart to update
      </button>
      break
    case 'installing':
      control = <button type="button" className="settings-btn" disabled><Loader2 size={14} className="spin" />Installing…</button>
      break
    case 'disabled':
      // Updates are off in this build: the version and the reason, no button that cannot work.
      control = undefined
      break
    default:
      control = <button type="button" className="settings-btn" disabled={state.phase === 'checking'}
        onClick={() => void updateActions.check()}>
        <RefreshCw size={14} className={state.phase === 'checking' ? 'spin' : undefined} />
        {state.phase === 'checking' ? 'Checking…' : 'Check for updates'}
      </button>
  }

  return (
    <>
      <SettingsRow
        title={version ? `Mousse ${version}` : 'Mousse'}
        anchor="general-updates"
        titleAction={version ? <CopyVersionButton version={version} /> : undefined}
        description={status && <span role="status" className={updateStatusClass(state)}>{status}</span>}
        control={control}
      >
        {state.error && <UpdateErrorNotice error={state.error} />}
      </SettingsRow>
      <InstallConfirm open={confirming} version={state.availableVersion ?? ''} onClose={() => setConfirming(false)} />
    </>
  )
}
