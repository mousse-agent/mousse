import type { CSSProperties } from 'react'
import { ANIMATION_SPEEDS, type AnimationSpeed, type AppearanceSettings as AppearanceValues, type MousseSettings, type MousseSettingsUpdate, type SettingsOptions, type ThemeId } from '../../../shared/settings'
import { Palette } from '../../lib/icons'
import { Select } from '../ui/Select'
import { SettingsAdvanced, SettingsGroup, SettingsRow, Switch } from './SettingsRow'
import { FontPicker } from './FontPicker'
import { onRadioGroupKeyDown, radioTabIndex } from '../../lib/radioGroupKeys'

const ANIMATION_SPEED_LABELS: Record<AnimationSpeed, string> = {
  off: 'Off',
  fast: 'Fast',
  normal: 'Normal',
  slow: 'Slow'
}

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

/**
 * A patch that sets one font and nothing else. The daemon merges it into the current settings, so
 * a font that finishes downloading later cannot restore other appearance values from an older
 * render. DeepPartial does not reach into interfaces, hence the cast.
 */
function fontPatch(font: Pick<AppearanceValues, 'interfaceFont'> | Pick<AppearanceValues, 'codeFont'>): MousseSettingsUpdate {
  return { appearance: font } as MousseSettingsUpdate
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

/** Settings → Appearance: theme, accent, fonts, glass, math, thread colors and animation speed. */
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
  const setTheme = (theme: ThemeId) => { if (theme !== appearance.theme) void onUpdate({ appearance: { ...appearance, theme } }) }
  const themeChosen = options.themes.some((theme) => theme.id === appearance.theme)
  const accentChosen = options.accentColors.some((color) => color.value === appearance.accentColor)

  return (
    <section id="appearance" className="settings-section">
      <SettingsGroup title="Appearance" icon={Palette}>
        <SettingsRow title="Color theme" anchor="appearance-theme">
          <div className="theme-carousel" role="radiogroup" aria-label="Color theme" onKeyDown={onRadioGroupKeyDown}>
            {options.themes.map((theme, index) => {
              const selected = appearance.theme === theme.id
              return (
                <div
                  key={theme.id}
                  className={`theme-card${selected ? ' selected' : ''}`}
                  onClick={() => setTheme(theme.id)}
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter' && e.key !== ' ') return
                    e.preventDefault()
                    setTheme(theme.id)
                  }}
                  role="radio"
                  aria-checked={selected}
                  tabIndex={radioTabIndex(selected, index, themeChosen)}
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
          anchor="appearance-accent"
          control={
            <div className="accent-grid" role="radiogroup" aria-label="Accent color" onKeyDown={onRadioGroupKeyDown}>
              {options.accentColors.map((color, index) => {
                const selected = appearance.accentColor === color.value
                return (
                  <button
                    key={color.id}
                    type="button"
                    role="radio"
                    className={`accent-swatch${selected ? ' selected' : ''}`}
                    style={{ backgroundColor: color.value }}
                    title={color.label}
                    aria-label={color.label}
                    aria-checked={selected}
                    tabIndex={radioTabIndex(selected, index, accentChosen)}
                    onClick={() => { if (!selected) void onUpdate({ appearance: { ...appearance, accentColor: color.value } }) }}
                  />
                )
              })}
            </div>
          }
        />
        <SettingsRow
          title="Interface font"
          anchor="appearance-interface-font"
          description={<span title="Menus, chat, settings and other text. A Google font downloads once when chosen and then works offline.">Menus, chat and settings.</span>}
          control={
            <FontPicker
              role="interface"
              ariaLabel="Interface font"
              value={appearance.interfaceFont}
              onChange={(interfaceFont) => onUpdate(fontPatch({ interfaceFont }))}
            />
          }
        />
        <SettingsRow
          title="Code font"
          anchor="appearance-code-font"
          description={<span title="Code blocks in chat, diffs and review, the file editor, terminals and command output. Lists monospace fonts. A Google font downloads once when chosen and then works offline.">Code, diffs, editor and terminals.</span>}
          control={
            <FontPicker
              role="code"
              ariaLabel="Code font"
              value={appearance.codeFont}
              onChange={(codeFont) => onUpdate(fontPatch({ codeFont }))}
            />
          }
        />
        <SettingsRow
          title="Acrylic glass"
          anchor="appearance-acrylic"
          description={<>
            <span title="The desktop shows blurred through the window on Windows, macOS and KDE Plasma.">Translucent window</span>
            {restartRequired && (
              <>
                {' · '}
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
          anchor="appearance-glass-intensity"
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
          anchor="appearance-render-math"
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
          anchor="appearance-project-colors"
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

      <SettingsAdvanced>
        <SettingsRow
          title="Animation speed"
          description={<span title="Off whenever your system is set to reduce motion.">How fast panels, menus and lists move.</span>}
          control={
            <Select
              ariaLabel="Animation speed"
              value={appearance.animationSpeed}
              onChange={(animationSpeed) => void onUpdate({ appearance: { ...appearance, animationSpeed } })}
              options={ANIMATION_SPEEDS.map((speed) => ({ value: speed, label: ANIMATION_SPEED_LABELS[speed] }))}
            />
          }
        />
      </SettingsAdvanced>
    </section>
  )
}
