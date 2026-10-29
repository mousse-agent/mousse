import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import type { MousseSettings, MousseSettingsUpdate, SettingsOptions, ThemeId } from '../../../shared/settings'
import type { UpdateState } from '../../../shared/updates'
import { subscribeToUpdates, updateActions, useUpdateStore } from '../../stores/updateStore'
import { InstallConfirm } from '../updates/InstallConfirm'
import { UpdateErrorNotice } from '../updates/UpdateErrorNotice'
import { Bell, Download, Info, Loader2, Palette, RefreshCw, RotateCcw, ShieldCheck } from '../../lib/icons'
import { describePermissionMode, PERMISSION_MODES } from '../../../shared/permissionMode'
import { PermissionModeLabel } from '../../lib/permissionModeIcon'
import { Select } from '../ui/Select'
import { SettingsGroup, SettingsRow, Switch } from './SettingsRow'
import { RunSettingsGroup } from './RunSettingsGroup'

/** Set at build time from package.json (electron.vite.config.ts). */
declare const __MOUSSE_VERSION__: string | undefined
const BUILD_VERSION = typeof __MOUSSE_VERSION__ === 'string' ? __MOUSSE_VERSION__ : ''

function themePreviewClass(themeId: ThemeId): string {
  switch (themeId) {
    case 'light':
      return 'preview-light'
    case 'system':
      return 'preview-system'
    case 'blacksphere-plus':
      return 'preview-blacksphere-plus'
    case 'dark-modern':
      return 'preview-dark-modern'
    case 'one-dark':
      return 'preview-one-dark'
    case 'monokai':
      return 'preview-monokai'
    case 'solarized-dark':
      return 'preview-solarized-dark'
    case 'github-dark':
      return 'preview-github-dark'
    case 'high-contrast':
      return 'preview-high-contrast'
    case 'dark':
    default:
      return 'preview-dark'
  }
}

/** A thumbnail in the theme's own fixed swatches (settings.css), whatever theme is active. */
function ThemePreview({ themeId }: { themeId: ThemeId }) {
  return (
    <div className={`theme-preview ${themePreviewClass(themeId)}`} aria-hidden="true">
      <div className="theme-preview-titlebar" />
      <div className="theme-preview-body">
        <div className="theme-preview-sidebar" />
        <div className="theme-preview-main" />
      </div>
    </div>
  )
}

export interface GeneralSettingsProps {
  settings: MousseSettings
  options: SettingsOptions
  onUpdate: (partial: MousseSettingsUpdate) => Promise<void>
  /** Windows refused a live acrylic change; offer a restart. */
  restartRequired: boolean
  onRestart: () => void
  /** Applies a glass intensity locally while the slider moves. */
  onPreviewAcrylicIntensity: (value: number) => void
  /** Saves a glass intensity (debounced by the caller). */
  onCommitAcrylicIntensity: (value: number) => void
}

/** Settings → General: appearance, permissions, runs, notifications, privacy and the installed version. */
export function GeneralSettings({
  settings,
  options,
  onUpdate,
  restartRequired,
  onRestart,
  onPreviewAcrylicIntensity,
  onCommitAcrylicIntensity
}: GeneralSettingsProps) {
  const appearance = settings.appearance
  const setTheme = (theme: ThemeId) => void onUpdate({ appearance: { ...appearance, theme } })

  return (
    <section id="general" className="settings-section">
      <SettingsGroup title="Appearance" icon={Palette}>
        <SettingsRow title="Color theme">
          <div className="theme-carousel" role="radiogroup" aria-label="Color theme">
            {options.themes.map((theme) => {
              const selected = appearance.theme === theme.id
              return (
                <div
                  key={theme.id}
                  className={`theme-card${selected ? ' selected' : ''}`}
                  onClick={() => setTheme(theme.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') setTheme(theme.id)
                  }}
                  role="radio"
                  aria-checked={selected}
                  tabIndex={0}
                >
                  <ThemePreview themeId={theme.id} />
                  <span className="theme-card-label">{theme.label}</span>
                </div>
              )
            })}
          </div>
        </SettingsRow>
        <SettingsRow
          title="Accent color"
          control={
            <div className="accent-grid">
              {options.accentColors.map((color) => (
                <button
                  key={color.id}
                  type="button"
                  className={`accent-swatch${appearance.accentColor === color.value ? ' selected' : ''}`}
                  style={{ backgroundColor: color.value }}
                  title={color.label}
                  aria-label={color.label}
                  aria-pressed={appearance.accentColor === color.value}
                  onClick={() => void onUpdate({ appearance: { ...appearance, accentColor: color.value } })}
                />
              ))}
            </div>
          }
        />
        <SettingsRow
          title="Acrylic glass"
          description={<>
            Translucent window material on every theme. The desktop shows blurred through it on Windows, macOS and KDE Plasma.
            {restartRequired && (
              <>
                {' '}
                <button type="button" className="theme-restart-link" onClick={onRestart}>
                  Restart to apply
                </button>
              </>
            )}
          </>}
          control={
            <Switch
              label="Acrylic glass"
              checked={appearance.acrylic}
              onChange={(acrylic) => void onUpdate({ appearance: { ...appearance, acrylic } })}
            />
          }
        />
        <SettingsRow
          title="Glass intensity"
          htmlFor="acrylic-intensity"
          description="Blur and opacity of the glass layers, from solid to glassy."
          disabled={!appearance.acrylic}
          control={
            <>
              <input
                id="acrylic-intensity"
                type="range"
                className="acrylic-intensity-dial"
                min={0}
                max={100}
                step={1}
                disabled={!appearance.acrylic}
                value={appearance.acrylicIntensity}
                style={{ '--fill': `${appearance.acrylicIntensity}%` } as CSSProperties}
                onInput={(e) => {
                  // React maps range onChange → continuous input; use only onInput so we
                  // do not double-fire IPC and snap the controlled thumb backward.
                  const acrylicIntensity = Number(e.currentTarget.value)
                  onPreviewAcrylicIntensity(acrylicIntensity)
                  onCommitAcrylicIntensity(acrylicIntensity)
                }}
              />
              <span className="acrylic-intensity-value">{appearance.acrylicIntensity}</span>
            </>
          }
        />
        <SettingsRow
          title="Render math"
          description="Show LaTeX in replies and Markdown previews as formatted equations."
          control={
            <Switch
              label="Render math"
              checked={appearance.renderMath}
              onChange={(renderMath) => void onUpdate({ appearance: { ...appearance, renderMath } })}
            />
          }
        />
      </SettingsGroup>

      <SettingsGroup title="Permissions" icon={ShieldCheck}>
        <SettingsRow
          title="Default permission mode"
          description={<span title="What an agent may do in a new chat without asking. Each chat can change it from the composer.">What an agent may do without asking in new chats.</span>}
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

      <SettingsGroup title="Notifications" icon={Bell}>
        <SettingsRow
          title="Completion sound"
          description="Play the system sound when an agent finishes."
          control={
            <Switch
              label="Completion sound"
              checked={settings.notifications.threadCompletionSound}
              onChange={(threadCompletionSound) => void onUpdate({ notifications: { ...settings.notifications, threadCompletionSound } })}
            />
          }
        />
        <SettingsRow
          title="All threads on my other computers"
          description={<span title="Off: only threads you started or sent a message in from this computer, or opened here in the last 7 days.">Notify when any thread on another computer needs you or finishes.</span>}
          control={
            <Switch
              label="Notify for all threads on my other computers"
              checked={settings.notifications.allRemoteThreads === true}
              onChange={(allRemoteThreads) => void onUpdate({ notifications: { ...settings.notifications, allRemoteThreads } })}
            />
          }
        />
      </SettingsGroup>

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
    default:
      control = <button type="button" className="settings-btn" disabled={state.phase === 'disabled' || state.phase === 'checking'}
        onClick={() => void updateActions.check()}>
        <RefreshCw size={14} className={state.phase === 'checking' ? 'spin' : undefined} />
        {state.phase === 'checking' ? 'Checking…' : 'Check for updates'}
      </button>
  }

  return (
    <>
      <SettingsRow
        title={version ? `Mousse ${version}` : 'Mousse'}
        description={status && <span role="status" className={updateStatusClass(state)}>{status}</span>}
        control={control}
      >
        {state.error && <UpdateErrorNotice error={state.error} />}
      </SettingsRow>
      <InstallConfirm open={confirming} version={state.availableVersion ?? ''} onClose={() => setConfirming(false)} />
    </>
  )
}
