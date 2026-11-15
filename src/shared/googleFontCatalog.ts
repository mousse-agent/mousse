import { isSafeFontFamily, type FontRole } from './fontSettings'
import catalogRows from './googleFontsCatalog.json'

/**
 * The Google Fonts catalog: a bundled snapshot (regenerate with scripts/update-google-fonts-catalog.mjs). It is a
 * module of its own so the window's startup chunk leaves it out: only the font picker in Settings (a split-out chunk)
 * and the main process read it.
 */

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

/** Families Mousse ships; the picker offers them as the default instead of as downloads. */
const BUNDLED_FAMILIES = new Set(['geist', 'geist mono'])

/** Interface text offers sans serif and serif families; code offers monospace ones. */
export function googleFontsForRole(role: FontRole): GoogleFontFamily[] {
  return googleFontCatalog().filter(
    (entry) =>
      !BUNDLED_FAMILIES.has(entry.family.toLowerCase()) &&
      (role === 'code' ? entry.category === 'monospace' : entry.category !== 'monospace')
  )
}
