import { isSafeFontFamily } from '../../shared/fontSettings'

/**
 * Font families installed on this computer, from the Local Font Access API. Empty when the API is
 * missing or refused; the picker then offers the system default and Google Fonts only.
 */

interface LocalFontData {
  family: string
}

let families: Promise<string[]> | undefined
const monospace = new Map<string, boolean>()

export function listInstalledFontFamilies(): Promise<string[]> {
  const query = (window as unknown as { queryLocalFonts?: () => Promise<LocalFontData[]> }).queryLocalFonts
  if (typeof query !== 'function') return Promise.resolve([])
  families ??= query
    .call(window)
    .then((fonts) => uniqueFamilies(fonts.map((font) => font.family)))
    .catch(() => {
      families = undefined
      return []
    })
  return families
}

/** Sorted, de-duplicated families, without hidden system families (a leading dot) or unsafe names. */
export function uniqueFamilies(names: readonly string[]): string[] {
  const seen = new Map<string, string>()
  for (const name of names) {
    const family = typeof name === 'string' ? name.trim() : ''
    if (!family || family.startsWith('.') || !isSafeFontFamily(family)) continue
    const key = family.toLowerCase()
    if (!seen.has(key)) seen.set(key, family)
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
}

/**
 * Whether an installed family draws every character at the same width. Measured once per family:
 * narrow and wide letters take the same width only in a monospace font. The fallback is a serif,
 * so a family that cannot be found never looks monospace.
 */
export function isMonospaceFamily(family: string, context = measuringContext()): boolean {
  const known = monospace.get(family)
  if (known !== undefined) return known
  if (!context) return false
  context.font = `32px "${family}", serif`
  const narrow = context.measureText('iiiiiiiiii').width
  const wide = context.measureText('WWWWWWWWWW').width
  const result = narrow > 0 && Math.abs(narrow - wide) < 0.5
  monospace.set(family, result)
  return result
}

let canvasContext: CanvasRenderingContext2D | null | undefined

function measuringContext(): CanvasRenderingContext2D | null {
  if (canvasContext === undefined) {
    canvasContext = typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d')
  }
  return canvasContext
}
