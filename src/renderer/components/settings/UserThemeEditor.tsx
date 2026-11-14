import { useEffect, useMemo, useRef, useState } from 'react'
import { THEME_OPTIONS, type AppearanceSettings } from '../../../shared/settings'
import { USER_THEME_BASES, USER_THEME_LIMITS, isUserThemeBase, type UserTheme } from '../../../shared/themes/userThemes'
import { applyAppearance } from '../../hooks/useTheme'
import { sanitizeThemeCss } from '../../lib/themeCss'
import { Download, Trash2 } from '../../lib/icons'
import { Select } from '../ui/Select'
import { SettingsRow } from './SettingsRow'

/** The colors the editor offers as swatches: the theme's accent and the tokens most themes change. */
const SWATCHES: ReadonlyArray<{ key: 'accent' | string; label: string }> = [
  { key: 'accent', label: 'Accent' },
  { key: '--surface-base', label: 'Background' },
  { key: '--surface-strong', label: 'Sidebar and panels' },
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

export interface UserThemeEditorProps {
  /** The saved theme being edited (the one in use). */
  theme: UserTheme
  appearance: AppearanceSettings
  onSave: (theme: UserTheme) => void
  onDelete: (id: string) => void
  onExport: (theme: UserTheme) => void
}

/**
 * Edits the user theme in use: name, base, a few colors and its CSS. Every change shows at once on the whole window
 * (the page's own theme pipeline, `applyAppearance`, with the draft in place of the saved theme); Save keeps it, and
 * leaving or Discard puts the saved theme back.
 */
export function UserThemeEditor({ theme, appearance, onSave, onDelete, onExport }: UserThemeEditorProps) {
  const [draft, setDraft] = useState<UserTheme>(theme)
  const dirty = !sameTheme(draft, theme)
  const saved = useRef(appearance)
  saved.current = appearance

  // A theme saved here or elsewhere (an agent, another window) replaces the draft; other settings changes do not.
  const savedKey = JSON.stringify(theme)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setDraft(theme) }, [savedKey])

  // Live preview: the draft over the saved settings, a moment after the last keystroke.
  useEffect(() => {
    if (!dirty) return
    const timer = window.setTimeout(() => {
      applyAppearance({ ...saved.current, userThemes: saved.current.userThemes.map((entry) => (entry.id === draft.id ? draft : entry)), userTheme: draft.id })
    }, 120)
    return () => window.clearTimeout(timer)
  }, [draft, dirty])

  // Leaving with an unsaved draft shows the saved theme again.
  useEffect(() => () => applyAppearance(saved.current), [])

  const dropped = useMemo(() => sanitizeThemeCss(draft.css).dropped, [draft.css])
  const update = (patch: Partial<UserTheme>): void => setDraft((current) => ({ ...current, ...patch }))
  const setSwatch = (key: string, value: string): void =>
    setDraft((current) => (key === 'accent' ? { ...current, accent: value } : { ...current, colors: { ...current.colors, [key]: value } }))
  const discard = (): void => {
    setDraft(theme)
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
      <SettingsRow
        title="Custom CSS"
        anchor="appearance-custom-css"
        htmlFor="user-theme-css"
        description={dropped.length
          ? <span className="user-theme-dropped" title={dropped.map((entry) => `${entry.text}: ${entry.reason}`).join('\n')}>{dropped.length === 1 ? '1 rule skipped' : `${dropped.length} rules skipped`}: themes can't load files or links.</span>
          : <span title="Applies as you type. Selectors and tokens: ask an agent for the theme guide, or see [data-mousse] attributes. Nothing can load from outside Mousse.">Applies as you type.</span>}
        className="user-theme-css-row"
      >
        <textarea
          id="user-theme-css"
          className="user-theme-css"
          spellCheck={false}
          value={draft.css}
          maxLength={USER_THEME_LIMITS.css}
          placeholder={'[data-mousse="sidebar"] {\n  font-family: ui-monospace, monospace;\n}'}
          onChange={(event) => update({ css: event.currentTarget.value })}
        />
      </SettingsRow>
      <div className="user-theme-actions">
        <button type="button" className="settings-btn" disabled={!dirty || !draft.name.trim()} onClick={() => onSave({ ...draft, name: draft.name.trim() })}>Save</button>
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
