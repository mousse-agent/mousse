import { useEffect, useMemo, useRef, useState } from 'react'
import { THEME_OPTIONS, type AppearanceSettings } from '../../../shared/settings'
import { USER_THEME_BASES, USER_THEME_LIMITS, isUserThemeBase, type ThemeWallpaper, type UserTheme } from '../../../shared/themes/userThemes'
import { applyAppearance } from '../../hooks/useTheme'
import { sanitizeThemeCss } from '../../lib/themeCss'
import { themeCssTooLong } from '../../../shared/themes/cssSafety'
import { Download, Trash2 } from '../../lib/icons'
import { Select } from '../ui/Select'
import { SettingsRow } from './SettingsRow'
import { WallpaperRows } from './WallpaperRows'

/** The colors the editor offers as swatches: the theme's accent and the tokens most themes change. */
const SWATCHES: ReadonlyArray<{ key: 'accent' | string; label: string }> = [
  { key: 'accent', label: 'Accent' },
  { key: '--surface-base', label: 'Background' },
  { key: '--surface-strong', label: 'Panels' },
  { key: '--text-primary', label: 'Text' },
  { key: '--text-secondary', label: 'Secondary text' }
]

const BASE_LABELS: Record<string, string> = Object.fromEntries(THEME_OPTIONS.map((option) => [option.id, option.label]))

/** The value a swatch shows: the theme's own, else what the page uses now, as `#rrggbb` (a color input takes no other). */
function swatchValue(theme: UserTheme, key: string): string {
  const own = key === 'accent' ? theme.accent : theme.colors[key]
  if (own && /^#[0-9a-f]{6}$/i.test(own)) return own
  const token = key === 'accent' ? '--accent' : key
  const used = getComputedStyle(document.documentElement).getPropertyValue(token).trim()
  if (/^#[0-9a-f]{6}$/i.test(used)) return used
  const rgb = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/i.exec(used)
  if (!rgb) return '#808080'
  return `#${rgb.slice(1, 4).map((part) => Number(part).toString(16).padStart(2, '0')).join('')}`
}

function sameTheme(a: UserTheme, b: UserTheme): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** How long the wallpaper settings rest before they are saved, so a dragged dim slider saves once. */
export const WALLPAPER_SAVE_DELAY_MS = 250

/**
 * The draft after the saved theme changed from `previous` to `next`: the fields edited here and not saved yet stay, the
 * others take the saved value. Another theme replaces the draft.
 */
function rebaseDraft(draft: UserTheme, previous: UserTheme, next: UserTheme): UserTheme {
  if (draft.id !== next.id || previous.id !== next.id) return next
  const keys = new Set([...Object.keys(draft), ...Object.keys(previous), ...Object.keys(next)]) as Set<keyof UserTheme>
  const rebased: Record<string, unknown> = {}
  for (const key of keys) {
    const edited = JSON.stringify(draft[key]) !== JSON.stringify(previous[key])
    const value = edited ? draft[key] : next[key]
    if (value !== undefined) rebased[key] = value
  }
  return rebased as unknown as UserTheme
}

/** `theme` with `wallpaper`, or without one when it is undefined. */
function withWallpaper(theme: UserTheme, wallpaper: ThemeWallpaper | undefined): UserTheme {
  const next: UserTheme = { ...theme }
  if (wallpaper) next.wallpaper = wallpaper
  else delete next.wallpaper
  return next
}

export interface UserThemeEditorProps {
  /** The saved theme being edited (the one in use). */
  theme: UserTheme
  appearance: AppearanceSettings
  onSave: (theme: UserTheme) => void | Promise<void>
  onDelete: (id: string) => void
  onExport: (theme: UserTheme) => void
}

/**
 * Edits the user theme in use: name, base, a few colors and its CSS. Every change shows at once on the whole window
 * (the page's own theme pipeline, `applyAppearance`, with the draft in place of the saved theme); Save keeps it, and
 * leaving or Discard puts what is saved back. The wallpaper rows are settings like the rest of the page: they save on
 * their own, a moment after the last change, and never save the other edits with them.
 */
export function UserThemeEditor({ theme, appearance, onSave, onDelete, onExport }: UserThemeEditorProps) {
  const [draft, setDraft] = useState<UserTheme>(theme)
  const dirty = !sameTheme(draft, theme)
  const saved = useRef(appearance)
  saved.current = appearance
  const latest = useRef({ theme, onSave })
  latest.current = { theme, onSave }

  // A theme saved here or elsewhere (an agent, another window) updates the draft, keeping the fields edited here and not
  // saved yet; other settings changes do not.
  const savedKey = JSON.stringify(theme)
  const savedTheme = useRef(theme)
  useEffect(() => {
    const previous = savedTheme.current
    savedTheme.current = theme
    setDraft((current) => rebaseDraft(current, previous, theme))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedKey])

  // The wallpaper waiting to be saved, and its timer.
  const pendingWallpaper = useRef<{ wallpaper: ThemeWallpaper | undefined } | null>(null)
  const wallpaperTimer = useRef<number | undefined>(undefined)
  const saveWallpaper = (): void | Promise<void> => {
    window.clearTimeout(wallpaperTimer.current)
    const pending = pendingWallpaper.current
    pendingWallpaper.current = null
    if (!pending) return
    const { theme: current, onSave: save } = latest.current
    if (JSON.stringify(current.wallpaper) === JSON.stringify(pending.wallpaper)) return
    return save(withWallpaper(current, pending.wallpaper))
  }
  const setWallpaper = (wallpaper: ThemeWallpaper | undefined): void => {
    setDraft((current) => withWallpaper(current, wallpaper))
    pendingWallpaper.current = { wallpaper }
    window.clearTimeout(wallpaperTimer.current)
    wallpaperTimer.current = window.setTimeout(() => void saveWallpaper(), WALLPAPER_SAVE_DELAY_MS)
  }

  // Live preview: the draft over the saved settings, a moment after the last keystroke.
  const previewed = useRef(false)
  useEffect(() => {
    if (!dirty) return
    const timer = window.setTimeout(() => {
      previewed.current = true
      applyAppearance({ ...saved.current, userThemes: saved.current.userThemes.map((entry) => (entry.id === draft.id ? draft : entry)), userTheme: draft.id })
    }, 120)
    return () => window.clearTimeout(timer)
  }, [draft, dirty])

  // Leaving after a preview shows what is saved now, read again: the editor also closes because the theme was turned
  // off (View → Turn off custom theme, an agent), and its last props would put that theme back.
  // A wallpaper change still waiting is saved first.
  useEffect(() => () => {
    const saving = saveWallpaper()
    if (!previewed.current) return
    void Promise.resolve(saving).catch(() => {}).then(() => window.mousse.settings.get()).then((settings) => applyAppearance(settings.appearance)).catch(() => {})
  }, [])

  const tooLong = draft.css.length > USER_THEME_LIMITS.css
  const dropped = useMemo(() => (tooLong ? [] : sanitizeThemeCss(draft.css).dropped), [draft.css, tooLong])
  const update = (patch: Partial<UserTheme>): void => setDraft((current) => ({ ...current, ...patch }))
  const setSwatch = (key: string, value: string): void =>
    setDraft((current) => (key === 'accent' ? { ...current, accent: value } : { ...current, colors: { ...current.colors, [key]: value } }))
  // The wallpaper is not part of the draft: Discard keeps it.
  const discard = (): void => {
    void saveWallpaper()
    setDraft((current) => withWallpaper(theme, current.wallpaper))
    previewed.current = false
    applyAppearance(saved.current)
  }

  return (
    <>
      <SettingsRow
        title="Name"
        htmlFor="user-theme-name"
        control={
          <input
            id="user-theme-name"
            className="settings-input"
            value={draft.name}
            maxLength={USER_THEME_LIMITS.name}
            onChange={(event) => update({ name: event.currentTarget.value })}
          />
        }
      />
      <SettingsRow
        title="Based on"
        control={
          <Select
            ariaLabel="Based on"
            value={draft.base}
            onChange={(base) => { if (isUserThemeBase(base)) update({ base }) }}
            options={USER_THEME_BASES.map((base) => ({ value: base, label: BASE_LABELS[base] ?? base }))}
          />
        }
      />
      <SettingsRow
        title="Colors"
        description={<span title="Empty swatches show the base theme's color. More tokens can be set in CSS or by an agent.">Over the base theme.</span>}
        control={
          <div className="user-theme-swatches">
            {SWATCHES.map((swatch) => (
              <input
                key={swatch.key}
                type="color"
                className="user-theme-swatch"
                title={swatch.label}
                aria-label={swatch.label}
                value={swatchValue(draft, swatch.key)}
                onChange={(event) => setSwatch(swatch.key, event.currentTarget.value)}
              />
            ))}
          </div>
        }
      />
      <WallpaperRows wallpaper={draft.wallpaper} onChange={setWallpaper} />
      <SettingsRow
        title="Custom CSS"
        anchor="appearance-custom-css"
        htmlFor="user-theme-css"
        description={tooLong
          ? <span role="alert" className="user-theme-dropped">{themeCssTooLong(draft.css.length)} Shorten it to save.</span>
          : dropped.length
          ? <span className="user-theme-dropped" title={dropped.map((entry) => `${entry.text}: ${entry.reason}`).join('\n')}>{dropped.length === 1 ? '1 rule skipped' : `${dropped.length} rules skipped`}: themes can't load files or links.</span>
          : <span title="Applies as you type. Selectors and tokens: ask an agent for the theme guide, or see [data-mousse] attributes. Nothing can load from outside Mousse.">Applies as you type.</span>}
        className="user-theme-css-row"
      >
        <textarea
          id="user-theme-css"
          className="user-theme-css"
          spellCheck={false}
          value={draft.css}
          placeholder={'[data-mousse="sidebar"] {\n  font-family: ui-monospace, monospace;\n}'}
          onChange={(event) => update({ css: event.currentTarget.value })}
        />
      </SettingsRow>
      <div className="user-theme-actions">
        <button type="button" className="settings-btn" disabled={!dirty || !draft.name.trim() || tooLong} onClick={() => { if (!tooLong) void onSave({ ...draft, name: draft.name.trim() }) }}>Save</button>
        {dirty && <button type="button" className="settings-btn" onClick={discard}>Discard</button>}
        <span className="user-theme-actions-spacer" />
        <button type="button" className="settings-icon-btn" title="Export as a file" aria-label="Export theme" onClick={() => onExport(theme)}>
          <Download size={16} aria-hidden="true" />
        </button>
        <button type="button" className="settings-icon-btn" title="Delete theme" aria-label="Delete theme" onClick={() => onDelete(theme.id)}>
          <Trash2 size={16} aria-hidden="true" />
        </button>
      </div>
    </>
  )
}
