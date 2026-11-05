import type { CSSProperties } from 'react'
import type { MousseSettings, MousseSettingsUpdate, SettingsOptions, ThemeId } from '../../../shared/settings'
import { Palette } from '../../lib/icons'
import { SettingsGroup, SettingsRow, Switch } from './SettingsRow'

function themePreviewClass(themeId: ThemeId): string {
  switch (themeId) {
    case 'light':
      return 'preview-light'
    case 'system':
      return 'preview-system'
    case 'blacksphere-plus':
      return 'preview-blacksphere-plus'
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

export interface AppearanceSettingsProps {
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

/** Settings → Appearance: theme, accent, glass, math and thread colors. */
export function AppearanceSettings({
  settings,
  options,
  onUpdate,
  restartRequired,
  onRestart,
  onPreviewAcrylicIntensity,
  onCommitAcrylicIntensity
}: AppearanceSettingsProps) {
  const appearance = settings.appearance
  const setTheme = (theme: ThemeId) => void onUpdate({ appearance: { ...appearance, theme } })

  return (
    <section id="appearance" className="settings-section">
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
        <SettingsRow
          title="Project colors on threads"
          description="Tint threads with their project's color."
          control={
            <Switch
              label="Project colors on threads"
              checked={appearance.threadProjectColors}
              onChange={(threadProjectColors) => void onUpdate({ appearance: { ...appearance, threadProjectColors } })}
            />
          }
        />
      </SettingsGroup>
    </section>
  )
}
