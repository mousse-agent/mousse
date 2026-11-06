import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildAccentCssVars } from '../src/shared/accentPalette'
import { FIXED_SURFACE_THEMES } from '../src/shared/themeSurfaces'
import { ACCENT_COLORS, type ThemeId } from '../src/shared/settings'

/**
 * Settings text and selection measured against the backgrounds they are drawn
 * on, per theme and accent, from the real token values (CSS files plus the
 * palettes useTheme sets inline). WCAG 2 contrast: 4.5:1 for text, 3:1 for
 * control glyphs and focus indicators.
 */

const read = (path: string) =>
  readFileSync(resolve(process.cwd(), path), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

const settingsCss = read('src/renderer/styles/settings.css')
const polishCss = read('src/renderer/styles/polish.css')
const darkCss = read('src/renderer/styles/themes/dark.css')
const lightCss = read('src/renderer/styles/themes/light.css')

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** A custom property declared in the first rule whose selector list holds `selector`. */
function token(
  source: string,
  selector: string | ((part: string) => boolean),
  name: string
): string | undefined {
  const matches = typeof selector === 'string' ? (part: string) => part === selector : selector
  for (const match of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = match[1]!.split(/,(?![^(]*\))/).map((part) => part.trim())
    if (!selectors.some(matches)) continue
    const value = match[2]!.match(new RegExp(`${escape(name)}\\s*:\\s*([^;]+);`))
    if (value) return value[1]!.trim()
  }
  return undefined
}

type Rgba = { r: number; g: number; b: number; a: number }

function parseColor(value: string): Rgba {
  const hex = value.match(/^#([0-9a-f]{6})$/i)
  if (hex) {
    const n = parseInt(hex[1]!, 16)
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 }
  }
  const rgba = value.match(
    /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/
  )
  if (rgba)
    return { r: +rgba[1]!, g: +rgba[2]!, b: +rgba[3]!, a: rgba[4] === undefined ? 1 : +rgba[4] }
  throw new Error(`Unparsed colour: ${value}`)
}

/** Paints `top` over an opaque `bottom`. */
const over = (top: Rgba, bottom: Rgba): Rgba => ({
  r: top.r * top.a + bottom.r * (1 - top.a),
  g: top.g * top.a + bottom.g * (1 - top.a),
  b: top.b * top.a + bottom.b * (1 - top.a),
  a: 1
})

/** `color-mix(in srgb, a p%, b)` for opaque colours. */
const mix = (a: Rgba, p: number, b: Rgba): Rgba => over({ ...a, a: p / 100 }, b)

/** `color-mix(in srgb, c p%, transparent)`. */
const alpha = (c: Rgba, p: number): Rgba => ({ ...c, a: (c.a * p) / 100 })

function luminance({ r, g, b }: Rgba): number {
  const channel = (v: number) => {
    const s = v / 255
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

function contrast(fg: Rgba, bg: Rgba): number {
  const top = fg.a < 1 ? over(fg, bg) : fg
  const [hi, lo] = [luminance(top), luminance(bg)].sort((x, y) => y - x)
  return (hi! + 0.05) / (lo! + 0.05)
}

/** Percentage in `color-mix(in srgb, var(--name) N%, ...)`. */
function mixPercent(value: string | undefined, name: string): number {
  const match = value?.match(new RegExp(`var\\(${escape(name)}\\)\\s+([\\d.]+)%`))
  if (!match) throw new Error(`No ${name} percentage in ${value}`)
  return +match[1]!
}

type Palette = {
  theme: ThemeId
  accent: string
  page: Rgba
  raised: Rgba
  text: Rgba
  secondary: Rgba
  accentColor: Rgba
}

const THEMES = [
  'dark',
  'light',
  'blacksphere-plus',
  'solarized-dark',
  'github-dark',
  'high-contrast'
] as const

function palette(theme: (typeof THEMES)[number], accent: string): Palette {
  const vars = buildAccentCssVars(accent)
  const fixed = FIXED_SURFACE_THEMES[theme]
  const page =
    theme === 'light'
      ? vars['--surface-light-base']!
      : (fixed?.['--surface-base'] ?? vars['--surface-base']!)
  const soft =
    theme === 'light'
      ? vars['--surface-light-soft']!
      : (fixed?.['--surface-soft'] ?? vars['--surface-soft']!)
  const themeCss = theme === 'light' ? lightCss : darkCss
  const themeSelector = `html[data-theme='${theme === 'light' ? 'light' : 'dark'}']`
  const text = fixed?.['--text-primary'] ?? token(themeCss, themeSelector, '--text-primary')!
  const secondary =
    fixed?.['--text-secondary'] ?? token(themeCss, themeSelector, '--text-secondary')!
  const raised = token(polishCss, `html[data-theme='${theme}']`, '--ui-raised') ?? soft
  return {
    theme,
    accent,
    page: parseColor(page),
    raised: parseColor(raised),
    text: parseColor(text),
    secondary: parseColor(secondary),
    accentColor: parseColor(vars['--accent']!)
  }
}

const palettes = THEMES.flatMap((theme) =>
  ACCENT_COLORS.map((accent) => palette(theme, accent.value))
)
const label = (p: Palette) => `${p.theme} / ${p.accent}`

/** `.settings-page` for the default theme, else that theme's settings-scoped rule. */
const settingsSelector = (theme: string) =>
  theme === 'dark'
    ? '.settings-page'
    : (part: string) =>
        part.startsWith(`html[data-theme='${theme}'] `) && part.includes('.settings-page')

/** The group surface (rule 1) composited over the page. */
function groupSurface(p: Palette): Rgba {
  const value =
    token(settingsCss, settingsSelector(p.theme), '--settings-surface') ??
    token(settingsCss, '.settings-page', '--settings-surface')!
  if (value === 'transparent') return p.page
  return over(alpha(p.text, mixPercent(value, '--text-primary')), p.page)
}

/** A Settings text token: the secondary colour or a share of the primary one. */
function settingsText(p: Palette, name: string, fallback: string | undefined): Rgba {
  const value =
    token(settingsCss, settingsSelector(p.theme), name) ??
    token(settingsCss, '.settings-page', name) ??
    fallback
  if (value === 'var(--text-secondary)') return p.secondary
  return alpha(p.text, mixPercent(value, '--text-primary'))
}

/** Faint text (nav group labels, search placeholder and icon) inside Settings. */
const faint = (p: Palette) => settingsText(p, '--ui-faint', token(polishCss, ':root', '--ui-faint'))

/** Keyboard focus outlines on Settings controls. */
const focus = (p: Palette) => settingsText(p, '--settings-focus', undefined)

/**
 * The selection fill (--ui-selected-fill) as painted on the page: an accent
 * share over the raised material or over the page shaded by the text colour,
 * or (high contrast) the translucent --ui-selected.
 */
function selectedFill(p: Palette): Rgba {
  const fill =
    token(polishCss, `html[data-theme='${p.theme}']`, '--ui-selected-fill') ??
    token(polishCss, ':root', '--ui-selected-fill')!
  if (fill === 'var(--ui-selected)') {
    const value = token(polishCss, `html[data-theme='${p.theme}']`, '--ui-selected')!
    const a = +value.match(/,\s*([\d.]+)\)$/)![1]!
    return over({ ...p.accentColor, a }, p.page)
  }
  const base = fill.includes('var(--ui-raised)') ? p.raised : p.page
  const shade = fill.match(/var\(--text-primary\)\s+([\d.]+)%/)
  const under = shade ? over(alpha(p.text, +shade[1]!), base) : base
  const accent = fill.match(/var\(--accent\)\s+([\d.]+)%/)
  return accent ? mix(p.accentColor, +accent[1]!, under) : under
}

/**
 * Selection has no WCAG minimum for a fill that sits beside other cues (the
 * label turns brighter and heavier). These steps keep it visible at a glance:
 * the former 9% tint measured 1.01:1 against the light nav.
 */
const SELECTED_STEP_ON_PAGE = 1.2
const SELECTED_STEP_ON_GROUP = 1.15

describe('settings contrast', () => {
  it('row descriptions and subtitles reach 4.5:1 on the page and on group surfaces', () => {
    for (const p of palettes) {
      expect(contrast(p.secondary, p.page), label(p)).toBeGreaterThanOrEqual(4.5)
      expect(contrast(p.secondary, groupSurface(p)), label(p)).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('row titles reach 4.5:1 on group surfaces', () => {
    for (const p of palettes) {
      expect(contrast(p.text, groupSurface(p)), label(p)).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('faint nav labels and search text reach 4.5:1 on the page and the search fill', () => {
    const hover = mixPercent(token(polishCss, ':root', '--ui-hover'), '--text-primary')
    for (const p of palettes) {
      expect(contrast(faint(p), p.page), label(p)).toBeGreaterThanOrEqual(4.5)
      expect(
        contrast(faint(p), over(alpha(p.text, hover), p.page)),
        label(p)
      ).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('the selected page row is a fill clearly lighter or darker than the nav, with readable text', () => {
    for (const p of palettes) {
      const fill = selectedFill(p)
      expect(contrast(fill, p.page), label(p)).toBeGreaterThanOrEqual(SELECTED_STEP_ON_PAGE)
      expect(contrast(p.text, fill), label(p)).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('the selected theme fill stands out from the group surface it sits on', () => {
    for (const p of palettes) {
      const fill = selectedFill(p)
      expect(contrast(fill, groupSurface(p)), label(p)).toBeGreaterThanOrEqual(
        SELECTED_STEP_ON_GROUP
      )
      expect(contrast(p.text, fill), label(p)).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('selection is a fill, never a border or edge bar', () => {
    const rules = (selector: string) =>
      [...(settingsCss + polishCss).matchAll(/([^{}]+)\{([^{}]*)\}/g)]
        .filter((m) => m[1]!.split(',').some((s) => s.trim().endsWith(selector)))
        .map((m) => m[2]!)
    for (const selector of ['.settings-nav-item.active', '.theme-card.selected']) {
      const bodies = rules(selector)
      expect(
        bodies.some((body) => /background:\s*var\(--ui-selected-fill\)/.test(body)),
        selector
      ).toBe(true)
      for (const body of bodies) {
        expect(body, selector).not.toMatch(
          /border(-left|-right)?(-color)?\s*:\s*(?!0|transparent|none)/
        )
        expect(body, selector).not.toMatch(/outline\s*:/)
      }
    }
  })

  it('keyboard focus outlines reach 3:1 on the page and on group surfaces', () => {
    const focusRules = [...settingsCss.matchAll(/([^{}]+:focus-visible[^{}]*)\{([^{}]*)\}/g)]
    expect(focusRules.length).toBeGreaterThan(0)
    for (const [, selector, body] of focusRules) {
      expect(body, selector!.trim()).toMatch(/var\(--settings-focus\)/)
    }
    for (const p of palettes) {
      expect(contrast(focus(p), p.page), label(p)).toBeGreaterThanOrEqual(3)
      expect(contrast(focus(p), groupSurface(p)), label(p)).toBeGreaterThanOrEqual(3)
      expect(contrast(focus(p), selectedFill(p)), label(p)).toBeGreaterThanOrEqual(3)
    }
  })

  it('disabled rows stay visibly dimmer than active rows', () => {
    const disabled = settingsCss.match(
      /\.settings-item\.disabled \.settings-item-text\s*\{[^}]*opacity:\s*([\d.]+)/
    )
    expect(Number(disabled?.[1])).toBeLessThanOrEqual(0.5)
  })
})

describe('settings column', () => {
  it('ordinary pages use one ~720px column; Providers keeps a wider one for its list and editor', () => {
    expect(token(settingsCss, '.settings-page', '--settings-content-w')).toBe('720px')
    expect(settingsCss).toMatch(
      /\.settings-content:has\(> #providers\)\s*\{[^}]*--settings-content-w:\s*var\(--settings-content-wide-w\)/
    )
  })

  it('theme choices wrap inside the column instead of scrolling sideways', () => {
    const carousel = settingsCss.match(/\.theme-carousel\s*\{([^}]*)\}/)?.[1] ?? ''
    expect(carousel).toMatch(/display:\s*grid/)
    expect(carousel).toMatch(/grid-template-columns:\s*repeat\(auto-fill/)
    expect(carousel).not.toMatch(/overflow-x/)
  })
})
