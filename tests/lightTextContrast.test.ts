import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildAccentCssVars } from '../src/shared/accentPalette'
import { ACCENT_COLORS } from '../src/shared/settings'

/**
 * Secondary and faint text in the light theme, measured against every light
 * surface it is drawn on, for every accent, from the real token values (the
 * CSS files plus the light surfaces useTheme derives from the accent).
 * WCAG 2 contrast: 4.5:1 for ordinary text.
 */

const read = (path: string) =>
  readFileSync(resolve(process.cwd(), path), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

const lightCss = read('src/renderer/styles/themes/light.css')
const polishCss = read('src/renderer/styles/polish.css')
const sidebarCss = read('src/renderer/styles/threads-sidebar.css')
const paletteCss = read('src/renderer/styles/thread-search.css')

const LIGHT = "html[data-theme='light']"
const SYSTEM = "html[data-theme='system']"

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** A custom property or declaration in the first rule whose selector list holds `selector`. */
function token(source: string, selector: string, name: string): string | undefined {
  for (const match of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = match[1]!.split(/,(?![^(]*\))/).map((part) => part.trim())
    if (!selectors.includes(selector)) continue
    const value = match[2]!.match(new RegExp(`(?:^|[;\\s])${escape(name)}\\s*:\\s*([^;]+);`))
    if (value) return value[1]!.trim()
  }
  return undefined
}

function required(source: string, selector: string, name: string): string {
  const value = token(source, selector, name)
  if (value === undefined) throw new Error(`No ${name} in ${selector}`)
  return value
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

/** `color-mix(in srgb, c p%, transparent)`, or the colour at an opacity of p / 100. */
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

/** Percentage in `color-mix(in srgb, var(--name) N%, transparent)`. */
function mixPercent(value: string, name: string): number {
  const match = value.match(new RegExp(`var\\(${escape(name)}\\)\\s+([\\d.]+)%,\\s*transparent\\)`))
  if (!match) throw new Error(`No ${name} percentage in ${value}`)
  return +match[1]!
}

/** Alpha in `rgba(var(--name), A)`. */
function rgbaAlpha(value: string, name: string): number {
  const match = value.match(new RegExp(`rgba\\(var\\(${escape(name)}\\),\\s*([\\d.]+)\\)`))
  if (!match) throw new Error(`No rgba(var(${name}), …) in ${value}`)
  return +match[1]!
}

const primary = parseColor(required(lightCss, LIGHT, '--text-primary'))
const secondary = parseColor(required(lightCss, LIGHT, '--text-secondary'))
const faint = alpha(
  primary,
  mixPercent(
    token(polishCss, LIGHT, '--ui-faint') ?? required(polishCss, ':root', '--ui-faint'),
    '--text-primary'
  )
)

/** Every light surface secondary and faint text sits on, for one accent. */
function surfaces(accent: string): Record<string, Rgba> {
  const vars = buildAccentCssVars(accent)
  const accentColor = parseColor(vars['--accent']!)
  const page = parseColor(vars['--surface-light-base']!)
  // Sidebar, title bar and the command palette sit on the strong surface
  // (the sidebar at 72% over the page, which is lighter, so strong is the worst case).
  const strong = parseColor(vars['--surface-light-strong']!)
  const soft = parseColor(vars['--surface-light-soft']!)
  const raised = parseColor(required(polishCss, LIGHT, '--ui-raised'))
  const shareOf = (source: string, selector: string, name: string) =>
    mixPercent(required(source, selector, 'background'), name)
  const accentAlpha = (source: string, selector: string) =>
    rgbaAlpha(required(source, selector, 'background'), '--accent-rgb')
  return {
    page,
    'sidebar and palette': strong,
    'soft surface': soft,
    'raised group': raised,
    hover: over(alpha(primary, mixPercent(required(polishCss, ':root', '--ui-hover'), '--text-primary')), strong),
    'selected sidebar tab': over(
      alpha(secondary, shareOf(sidebarCss, '.threads-sidebar-tab.active', '--text-secondary')),
      strong
    ),
    'selected thread row': over(
      alpha(secondary, shareOf(sidebarCss, '.threads-sidebar-thread.active', '--text-secondary')),
      strong
    ),
    'hovered thread row': over(
      alpha(accentColor, 100 * accentAlpha(sidebarCss, '.threads-sidebar-thread:hover')),
      strong
    ),
    'palette active row': over(
      alpha(accentColor, 100 * accentAlpha(paletteCss, '.thread-search-result.active')),
      strong
    ),
    'selected item (--ui-selected)': over(
      alpha(accentColor, 100 * rgbaAlpha(required(polishCss, ':root', '--ui-selected'), '--accent-rgb')),
      page
    )
  }
}

const cases = ACCENT_COLORS.flatMap((accent) =>
  Object.entries(surfaces(accent.value)).map(([surface, background]) => ({
    label: `${accent.id} / ${surface}`,
    background
  }))
)

describe('light theme text contrast', () => {
  it('secondary text reaches 4.5:1 on every light surface', () => {
    for (const { label, background } of cases) {
      expect(contrast(secondary, background), label).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('faint text reaches 4.5:1 on every light surface', () => {
    for (const { label, background } of cases) {
      expect(contrast(faint, background), label).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('keeps a visible hierarchy: primary, then secondary, then faint', () => {
    for (const { label, background } of cases) {
      const [p, s, f] = [primary, secondary, faint].map((fg) => contrast(fg, background))
      expect(p! / s!, label).toBeGreaterThanOrEqual(1.5)
      expect(s! / f!, label).toBeGreaterThanOrEqual(1.25)
    }
  })

  it('disabled text (half opacity) stays visibly dimmer, under 3:1', () => {
    for (const { label, background } of cases) {
      expect(contrast(alpha(secondary, 50), background), label).toBeLessThan(3)
      expect(contrast(alpha(faint, 50), background), label).toBeLessThan(3)
    }
  })

  it('the system theme in light mode uses the same values', () => {
    const inSystem = (source: string, name: string) => {
      const media = source.match(/@media \(prefers-color-scheme: light\)\s*\{([\s\S]*?)\n\}/g) ?? []
      return media.map((block) => token(block, SYSTEM, name)).find(Boolean)
    }
    expect(inSystem(lightCss, '--text-secondary')).toBe(required(lightCss, LIGHT, '--text-secondary'))
    expect(inSystem(polishCss, '--ui-faint')).toBe(required(polishCss, LIGHT, '--ui-faint'))
  })
})
