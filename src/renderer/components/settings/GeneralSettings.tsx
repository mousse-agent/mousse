import { useEffect, useState, type ReactNode } from 'react'
import type { MousseSettings, MousseSettingsUpdate } from '../../../shared/settings'
import type { UpdateState } from '../../../shared/updates'
import { subscribeToUpdates, updateActions, useUpdateStore } from '../../stores/updateStore'
import { InstallConfirm } from '../updates/InstallConfirm'
import { UpdateErrorNotice } from '../updates/UpdateErrorNotice'
import { Download, Info, Loader2, RefreshCw, RotateCcw, ShieldCheck } from '../../lib/icons'
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
    </section>
  )
}

function updateStatus(state: UpdateState): string | undefined {
  switch (state.phase) {
    case 'disabled': return state.disabledReason ?? 'Updates are not available in this build.'
    case 'checking': return 'Checking for updates…'
    case 'up-to-date': return 'Up to date'
    case 'available': return `Version ${state.availableVersion} is available`
    case 'downloading': return `Downloading ${state.availableVersion}… ${state.downloadPercent ?? 0}%`
    case 'downloaded': return state.error ? `${state.availableVersion} is downloaded but not installed` : `${state.availableVersion} is ready to install`
    case 'installing': return `Installing ${state.availableVersion}…`
    case 'error': return state.availableVersion ? `Version ${state.availableVersion} is available` : 'The last update check failed.'
    default: return undefined
  }
}

/** Colours only outcomes: up to date, or an update ready to install. A failure shows in UpdateErrorNotice. */
function updateStatusClass(state: UpdateState): string | undefined {
  if (state.phase === 'error' || state.error) return undefined
  if (state.phase === 'up-to-date' || state.phase === 'downloaded') return 'settings-status-ok'
  return undefined
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
        description={status && <span role="status" className={updateStatusClass(state)}>{status}</span>}
        control={control}
      >
        {state.error && <UpdateErrorNotice error={state.error} />}
      </SettingsRow>
      <InstallConfirm open={confirming} version={state.availableVersion ?? ''} onClose={() => setConfirming(false)} />
    </>
  )
}
