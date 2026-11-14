import { useRef, useState, type CSSProperties } from 'react'
import { ANIMATION_SPEEDS, type AnimationSpeed, type AppearanceSettings as AppearanceValues, type MousseSettings, type MousseSettingsUpdate, type SettingsOptions, type ThemeId } from '../../../shared/settings'
import { activeUserTheme, isUserThemeBase, parseUserThemeFile, USER_THEME_LIMITS, userThemeFile, userThemeIdFor, type UserTheme } from '../../../shared/themes/userThemes'
import { Select } from '../ui/Select'
import { SettingsGroup, SettingsRow, Switch } from './SettingsRow'
import { FontPicker } from './FontPicker'
import { UserThemeEditor } from './UserThemeEditor'
import { downloadJson } from '../agentDefinitions/importBundle'
import { onRadioGroupKeyDown, radioTabIndex } from '../../lib/radioGroupKeys'
import { AppWindow, Code2, Palette, Plus, TextFont, Upload } from '../../lib/icons'

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

/** A user theme's thumbnail: its base's swatches with its own colors over them. */
function userThemePreviewStyle(theme: UserTheme): CSSProperties {
  const bar = theme.colors['--surface-strong'] ?? theme.colors['--surface-base']
  const side = theme.colors['--surface-strong'] ?? theme.colors['--surface-base']
  const main = theme.colors['--surface-base']
  return {
    ...(bar ? { '--preview-bar': bar } : {}),
    ...(side ? { '--preview-side': side } : {}),
    ...(main ? { '--preview-main': main } : {}),
    ...(theme.accent ? { '--preview-accent': theme.accent } : {})
  } as CSSProperties
}

/** A thumbnail in the theme's own fixed swatches (settings.css), whatever theme is active. */
function ThemePreview({ themeId, style }: { themeId: ThemeId; style?: CSSProperties }) {
  return (
    <div className={`theme-preview ${themePreviewClass(themeId)}`} style={style} aria-hidden="true">
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

/**
 * Settings → Appearance in three groups: Colors (theme, accent, project colors), Text (the two fonts) and Window
 * (the title-bar path, glass and animation speed). How the chat reads and the composer are on Settings → Chat.
 */
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
  const userTheme = activeUserTheme(appearance)
  const userThemes = appearance.userThemes ?? []
  const [importError, setImportError] = useState('')
  const importInput = useRef<HTMLInputElement>(null)
  /** A patch of appearance fields only; the daemon merges it into what is saved now. */
  const patch = (fields: Partial<AppearanceValues>): Promise<void> => onUpdate({ appearance: fields } as MousseSettingsUpdate)
  const setTheme = (theme: ThemeId) => { if (theme !== appearance.theme || userTheme) void patch({ theme, userTheme: '' }) }
  const pickUserTheme = (id: string) => { if (id !== appearance.userTheme) void patch({ userTheme: id }) }
  const saveUserTheme = (theme: UserTheme) => void patch({ userThemes: userThemes.map((entry) => (entry.id === theme.id ? theme : entry)), userTheme: theme.id })
  const addUserTheme = (theme: UserTheme) => void patch({ userThemes: [...userThemes, theme], userTheme: theme.id })
  const newUserTheme = () => {
    const base = isUserThemeBase(appearance.theme) ? appearance.theme : 'dark'
    const name = `My theme${userThemes.length ? ` ${userThemes.length + 1}` : ''}`
    addUserTheme({ id: userThemeIdFor(name, userThemes.map((theme) => theme.id)), name, base, accent: '', colors: {}, css: '' })
  }
  const deleteUserTheme = (id: string) => void patch({ userThemes: userThemes.filter((theme) => theme.id !== id), userTheme: '' })
  const exportUserTheme = (theme: UserTheme) => downloadJson(`${theme.id.replace(/^user-/, '')}.mousse-theme.json`, userThemeFile(theme))
  const importUserTheme = async (file: File | undefined) => {
    if (!file) return
    const read = parseUserThemeFile(await file.text(), userThemes.map((theme) => theme.id))
    if ('error' in read) { setImportError(read.error); return }
    setImportError('')
    addUserTheme(read.theme)
  }
  const atLimit = userThemes.length >= USER_THEME_LIMITS.themes
  const themeChosen = Boolean(userTheme) || options.themes.some((theme) => theme.id === appearance.theme)
  // A user theme with its own accent shows and changes that accent; otherwise the profile's.
  const themeAccent = userTheme?.accent || ''
  const shownAccent = themeAccent || appearance.accentColor
  const pickAccent = (accentColor: string) => {
    if (userTheme && themeAccent) saveUserTheme({ ...userTheme, accent: accentColor.toLowerCase() })
    else void onUpdate({ appearance: { ...appearance, accentColor } })
  }
  const accentChosen = options.accentColors.some((color) => color.value.toLowerCase() === shownAccent.toLowerCase())

  return (
    <section id="appearance" className="settings-section">
      <SettingsGroup title="Colors" icon={Palette}>
        <SettingsRow
          title="Color theme"
          anchor="appearance-theme"
          titleAction={
            <button type="button" className="settings-title-icon-btn" title="Import a theme file" aria-label="Import theme" disabled={atLimit} onClick={() => importInput.current?.click()}>
              <Upload size={14} aria-hidden="true" />
            </button>
          }
          description={importError ? <span role="alert" className="user-theme-dropped">{importError}</span> : undefined}
        >
          <input
            ref={importInput}
            type="file"
            accept=".json,application/json"
            hidden
            onChange={(event) => { void importUserTheme(event.currentTarget.files?.[0]); event.currentTarget.value = '' }}
          />
          <div className="theme-carousel" role="radiogroup" aria-label="Color theme" onKeyDown={onRadioGroupKeyDown}>
            {options.themes.map((theme, index) => {
              const selected = !userTheme && appearance.theme === theme.id
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
            {userThemes.map((theme, index) => {
              const selected = userTheme?.id === theme.id
              return (
                <div
                  key={theme.id}
                  className={`theme-card${selected ? ' selected' : ''}`}
                  onClick={() => pickUserTheme(theme.id)}
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter' && e.key !== ' ') return
                    e.preventDefault()
                    pickUserTheme(theme.id)
                  }}
                  role="radio"
                  aria-checked={selected}
                  tabIndex={radioTabIndex(selected, options.themes.length + index, themeChosen)}
                  title={`Based on ${options.themes.find((option) => option.id === theme.base)?.label ?? theme.base}`}
                >
                  <ThemePreview themeId={theme.base} style={userThemePreviewStyle(theme)} />
                  <span className="theme-card-label">{theme.name}</span>
                </div>
              )
            })}
            <button type="button" className="theme-card theme-card-new" disabled={atLimit} onClick={newUserTheme} title="A theme of your own: colors and CSS over a built-in theme">
              <span className="theme-preview theme-preview-new" aria-hidden="true"><Plus size={16} /></span>
              <span className="theme-card-label">New</span>
            </button>
          </div>
        </SettingsRow>
        <SettingsRow
          title="Accent color"
          anchor="appearance-accent"
          control={
            <div className="accent-grid" role="radiogroup" aria-label="Accent color" onKeyDown={onRadioGroupKeyDown}>
              {options.accentColors.map((color, index) => {
                const selected = shownAccent.toLowerCase() === color.value.toLowerCase()
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
                    onClick={() => { if (!selected) pickAccent(color.value) }}
                  />
                )
              })}
            </div>
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

      {userTheme && (
        <SettingsGroup title={userTheme.name} icon={Code2} anchor="appearance-custom-theme" className="user-theme-group">
          <UserThemeEditor
            theme={userTheme}
            appearance={appearance}
            onSave={saveUserTheme}
            onDelete={deleteUserTheme}
            onExport={exportUserTheme}
          />
        </SettingsGroup>
      )}

      <SettingsGroup title="Text" icon={TextFont}>
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
      </SettingsGroup>

      <SettingsGroup title="Window" icon={AppWindow}>
        <SettingsRow
          title="Thread path in title bar"
          anchor="appearance-thread-path"
          description="Project, thread and subagents, with back and forward."
          control={
            <Switch
              label="Thread path in title bar"
              checked={appearance.threadPathInTitleBar}
              onChange={(threadPathInTitleBar) => void onUpdate({ appearance: { ...appearance, threadPathInTitleBar } })}
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
          title="Animation speed"
          anchor="appearance-animation-speed"
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
      </SettingsGroup>
    </section>
  )
}
