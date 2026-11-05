import catalogRows from './googleFontsCatalog.json'

/** Interface text, or monospace text (code, diffs, the file editor and terminals). */
export type FontRole = 'interface' | 'code'

/**
 * Where a font comes from. `default` is the font Mousse ships (Geist / Geist Mono), `system` is
 * the operating system's own font, `installed` a font on this computer, `google` a Google Fonts
 * family that is downloaded once and then loaded from the local cache.
 */
export type FontSource = 'default' | 'system' | 'installed' | 'google'

export interface FontChoice {
  source: FontSource
  /** The family name; only for `installed` and `google`. */
  family?: string
}

export const DEFAULT_FONT_CHOICE: Readonly<FontChoice> = Object.freeze({ source: 'default' })

/** The stacks Mousse used before fonts could be chosen; `--font-sans` / `--font-mono` default to these. */
export const DEFAULT_FONT_STACKS: Readonly<Record<FontRole, string>> = Object.freeze({
  interface: "'Geist', 'Segoe UI', system-ui, -apple-system, sans-serif",
  code: "'Geist Mono', Consolas, 'Courier New', monospace"
})

/** The operating system's fonts. A chosen family falls back to these when it cannot load. */
export const SYSTEM_FONT_STACKS: Readonly<Record<FontRole, string>> = Object.freeze({
  interface: "-apple-system, BlinkMacSystemFont, system-ui, 'Segoe UI', Roboto, sans-serif",
  code: "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace"
})

/** The weights the UI draws with; only these are downloaded. */
export const FONT_ROLE_WEIGHTS: Readonly<Record<FontRole, readonly number[]>> = Object.freeze({
  interface: Object.freeze([400, 500, 600]),
  code: Object.freeze([400, 700])
})

const MAX_FAMILY_LENGTH = 100

/**
 * A family name that is safe to quote inside a CSS font-family list and to put in a URL query:
 * letters (any script), digits, spaces and a little punctuation. No quotes, backslashes,
 * semicolons, braces, angle brackets or control characters.
 */
export function isSafeFontFamily(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const family = value.trim()
  if (!family || family.length > MAX_FAMILY_LENGTH || family !== value) return false
  return /^[\p{L}\p{N}\p{M} ._&+()-]+$/u.test(family)
}

export function normalizeFontChoice(raw: unknown): FontChoice {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...DEFAULT_FONT_CHOICE }
  const { source, family } = raw as { source?: unknown; family?: unknown }
  if (source === 'system') return { source: 'system' }
  if (source === 'installed' || source === 'google') {
    const trimmed = typeof family === 'string' ? family.trim() : family
    if (isSafeFontFamily(trimmed)) return { source, family: trimmed }
  }
  return { ...DEFAULT_FONT_CHOICE }
}

export function sameFontChoice(a: FontChoice, b: FontChoice): boolean {
  return a.source === b.source && (a.family ?? '') === (b.family ?? '')
}

/** The CSS font-family list for a role. A chosen family is followed by the system fonts. */
export function fontStack(role: FontRole, choice: FontChoice): string {
  const normalized = normalizeFontChoice(choice)
  if (normalized.source === 'default') return DEFAULT_FONT_STACKS[role]
  if (normalized.source === 'system') return SYSTEM_FONT_STACKS[role]
  return `"${normalized.family}", ${SYSTEM_FONT_STACKS[role]}`
}

/** A short name for a choice, for the picker's trigger. */
export function fontChoiceLabel(role: FontRole, choice: FontChoice): string {
  const normalized = normalizeFontChoice(choice)
  if (normalized.source === 'default') return role === 'code' ? 'Geist Mono' : 'Geist'
  if (normalized.source === 'system') return 'System font'
  return normalized.family ?? ''
}

/**
 * For each weight the UI uses, the nearest weight the family has (the lighter one on a tie).
 * Never empty when the family has any weight.
 */
export function pickFontWeights(wanted: readonly number[], available: readonly number[]): number[] {
  if (available.length === 0) return []
  const picked = new Set<number>()
  for (const weight of wanted) {
    let best = available[0]
    for (const candidate of available) {
      const distance = Math.abs(candidate - weight)
      const bestDistance = Math.abs(best - weight)
      if (distance < bestDistance || (distance === bestDistance && candidate < best)) best = candidate
    }
    picked.add(best)
  }
  return [...picked].sort((a, b) => a - b)
}

// ---------------------------------------------------------------------------
// Google Fonts catalog (bundled snapshot; regenerate with scripts/update-google-fonts-catalog.mjs)
// ---------------------------------------------------------------------------

export type GoogleFontCategory = 'sans-serif' | 'serif' | 'monospace'

export interface GoogleFontFamily {
  family: string
  category: GoogleFontCategory
  /** Upright weights the family offers. */
  weights: readonly number[]
}

const CATEGORY_CODES: Record<string, GoogleFontCategory> = { s: 'sans-serif', r: 'serif', m: 'monospace' }

let catalog: readonly GoogleFontFamily[] | undefined
let catalogIndex: Map<string, GoogleFontFamily> | undefined

/** All families in the bundled catalog, most popular first. */
export function googleFontCatalog(): readonly GoogleFontFamily[] {
  if (!catalog) {
    catalog = Object.freeze(
      (catalogRows as unknown as [string, string, number[]][])
        .filter(([family, code, weights]) => isSafeFontFamily(family) && CATEGORY_CODES[code] && weights.length > 0)
        .map(([family, code, weights]) => Object.freeze({ family, category: CATEGORY_CODES[code], weights: Object.freeze([...weights]) }))
    )
  }
  return catalog
}

export function findGoogleFont(family: string): GoogleFontFamily | undefined {
  if (!catalogIndex) catalogIndex = new Map(googleFontCatalog().map((entry) => [entry.family.toLowerCase(), entry]))
  return catalogIndex.get(family.toLowerCase())
}

/** Interface text offers sans serif and serif families; code offers monospace ones. */
export function googleFontsForRole(role: FontRole): GoogleFontFamily[] {
  return googleFontCatalog().filter((entry) =>
    role === 'code' ? entry.category === 'monospace' : entry.category !== 'monospace'
  )
}

/**
 * Names matching a search, best first: an exact name, then names starting with the query, then
 * names with a word starting with it, then any other match. Keeps the input order within a rank.
 */
export function searchFontNames<T>(items: readonly T[], query: string, name: (item: T) => string): T[] {
  const needle = query.trim().toLowerCase().replace(/\s+/g, ' ')
  if (!needle) return [...items]
  const ranked: T[][] = [[], [], [], []]
  for (const item of items) {
    const text = name(item).toLowerCase()
    if (text === needle) ranked[0].push(item)
    else if (text.startsWith(needle)) ranked[1].push(item)
    else if (text.includes(` ${needle}`)) ranked[2].push(item)
    else if (text.includes(needle) || text.replace(/ /g, '').includes(needle.replace(/ /g, ''))) ranked[3].push(item)
  }
  return ranked.flat()
}

// ---------------------------------------------------------------------------
// Google Fonts download (used by the main process)
// ---------------------------------------------------------------------------

export interface GoogleFontFaceSource {
  weight: number
  style: 'normal' | 'italic'
  /** CSS unicode-range, when the face covers part of the character set. */
  unicodeRange?: string
  url: string
}

/** The Google Fonts CSS that lists a family's font files for the given weights. */
export function googleFontCssUrl(family: string, weights: readonly number[]): string {
  const name = encodeURIComponent(family).replace(/%20/g, '+')
  const axis = weights.length > 0 ? `:wght@${[...weights].sort((a, b) => a - b).join(';')}` : ''
  return `https://fonts.googleapis.com/css2?family=${name}${axis}&display=swap`
}

const FONT_FILE_HOST = 'fonts.gstatic.com'
const UNICODE_RANGE = /^[\sU+0-9A-Fa-f?,-]+$/

/** The @font-face blocks of a Google Fonts stylesheet. Files must be HTTPS on fonts.gstatic.com. */
export function parseGoogleFontCss(css: string): GoogleFontFaceSource[] {
  const faces: GoogleFontFaceSource[] = []
  for (const match of css.matchAll(/@font-face\s*\{([^}]*)\}/g)) {
    const body = match[1]
    const url = /src:\s*url\(\s*['"]?([^'")\s]+)['"]?\s*\)/.exec(body)?.[1]
    const weightText = /font-weight:\s*(\d{3})(?:\s+\d{3})?\s*;/.exec(body)?.[1]
    const style = /font-style:\s*(normal|italic)\s*;/.exec(body)?.[1] as 'normal' | 'italic' | undefined
    const unicodeRange = /unicode-range:\s*([^;]+);/.exec(body)?.[1]?.trim()
    if (!url || !weightText) continue
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      continue
    }
    if (parsed.protocol !== 'https:' || parsed.hostname !== FONT_FILE_HOST) continue
    faces.push({
      weight: Number(weightText),
      style: style ?? 'normal',
      ...(unicodeRange && UNICODE_RANGE.test(unicodeRange) ? { unicodeRange } : {}),
      url: parsed.toString()
    })
  }
  return faces
}

/** A folder name for a family's cached files. */
export function fontCacheSlug(family: string): string {
  const slug = family
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'font'
}

/** One cached face as the renderer receives it. */
export interface LoadedFontFace {
  weight: number
  style: 'normal' | 'italic'
  unicodeRange?: string
  data: Uint8Array
}

export interface LoadedGoogleFont {
  family: string
  faces: LoadedFontFace[]
}
