export const ORB_PALETTES = [
  { id: 'aurora', name: 'Aurora', colors: ['#82efe0', '#8ca9ff', '#d8a4ff', '#ffe6ad'] },
  { id: 'lagoon', name: 'Lagoon', colors: ['#43ddce', '#5cbded', '#126d99', '#c3ffe9'] },
  { id: 'ember', name: 'Ember', colors: ['#ffc286', '#ff7893', '#af80ed', '#fff0c2'] },
  { id: 'pearl', name: 'Pearl', colors: ['#e8edf7', '#aecfe2', '#eccfe4', '#fff4dd'] },
  { id: 'violet', name: 'Violet', colors: ['#ac8dff', '#ec9ce5', '#819fff', '#e4dcff'] },
  { id: 'graphite', name: 'Graphite', colors: ['#a0b4ce', '#6b7c9d', '#d2d9e7', '#8795aa'] }
] as const

export type OrbPaletteId = typeof ORB_PALETTES[number]['id'] | 'custom'

/** Visual metadata: does not grant capabilities or change an execution revision. */
export interface OrbAppearance {
  version: 1
  palette: OrbPaletteId
  colors: string[]
  luminance: number
  translucency: number
  motion: number
  parallax: boolean
  seed: number
}

export const DEFAULT_ORB_APPEARANCE: Readonly<OrbAppearance> = Object.freeze({
  version: 1,
  palette: 'aurora',
  colors: [...ORB_PALETTES[0].colors],
  luminance: 0.65,
  translucency: 0.6,
  motion: 0.35,
  parallax: true,
  seed: 0
})

function unit(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : fallback
}

/** Old/imported visual metadata is untrusted and must never become arbitrary CSS. */
export function normalizeOrbAppearance(value?: unknown): OrbAppearance {
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const named = ORB_PALETTES.find((palette) => palette.id === input.palette)
  const colors = Array.isArray(input.colors)
    ? input.colors.filter((color): color is string => typeof color === 'string' && /^#[\da-f]{6}$/i.test(color)).slice(0, 4)
    : []
  const custom = input.palette === 'custom' && colors.length >= 2
  const palette = named ?? ORB_PALETTES[0]
  return {
    version: 1,
    palette: custom ? 'custom' : palette.id,
    colors: custom ? colors : [...palette.colors],
    luminance: unit(input.luminance, DEFAULT_ORB_APPEARANCE.luminance),
    translucency: unit(input.translucency, DEFAULT_ORB_APPEARANCE.translucency),
    motion: unit(input.motion, DEFAULT_ORB_APPEARANCE.motion),
    parallax: typeof input.parallax === 'boolean' ? input.parallax : true,
    seed: typeof input.seed === 'number' && Number.isFinite(input.seed) ? Math.abs(Math.trunc(input.seed)) % 360 : 0
  }
}

export function selectOrbPalette(value: OrbAppearance, id: Exclude<OrbPaletteId, 'custom'>): OrbAppearance {
  return normalizeOrbAppearance({ ...value, palette: id })
}

export function stepOrbPalette(value: OrbAppearance, direction: -1 | 1): OrbAppearance {
  const current = ORB_PALETTES.findIndex((palette) => palette.id === value.palette)
  const next = current < 0 ? (direction === 1 ? 0 : ORB_PALETTES.length - 1)
    : (current + direction + ORB_PALETTES.length) % ORB_PALETTES.length
  return selectOrbPalette(value, ORB_PALETTES[next].id)
}

export function orbPaletteName(value: OrbAppearance): string {
  return ORB_PALETTES.find((palette) => palette.id === value.palette)?.name ?? 'Custom'
}
