export interface Rgb {
  r: number
  g: number
  b: number
}

export function parseHex(hex: string): Rgb | null {
  const normalized = hex.replace('#', '')
  if (normalized.length !== 6) return null
  return {
    r: parseInt(normalized.slice(0, 2), 16),
    g: parseInt(normalized.slice(2, 4), 16),
    b: parseInt(normalized.slice(4, 6), 16)
  }
}

export function rgbToHex(r: number, g: number, b: number): string {
  return `#${[r, g, b]
    .map((channel) => Math.round(channel).toString(16).padStart(2, '0'))
    .join('')}`
}

export function mixHex(base: string, target: string, amount: number): string {
  const from = parseHex(base)
  const to = parseHex(target)
  if (!from || !to) return base
  const mix = (a: number, b: number) => Math.round(a + (b - a) * amount)
  return rgbToHex(mix(from.r, to.r), mix(from.g, to.g), mix(from.b, to.b))
}

export function lightenHex(hex: string, amount: number): string {
  return mixHex(hex, '#ffffff', amount)
}

export function darkenHex(hex: string, amount: number): string {
  return mixHex(hex, '#000000', amount)
}

export function rgbString(rgb: Rgb): string {
  return `${rgb.r}, ${rgb.g}, ${rgb.b}`
}

export function surfaceToWindowBackground(surfaceHex: string, alpha = 1): string {
  const rgb = parseHex(surfaceHex)
  if (!rgb) return '#1a1228'
  const toHex = (value: number) => value.toString(16).padStart(2, '0')
  const alphaHex = toHex(Math.round(Math.max(0, Math.min(1, alpha)) * 255))
  const rgbHex = `${toHex(rgb.r)}${toHex(rgb.g)}${toHex(rgb.b)}`
  return alpha >= 1 ? `#${rgbHex}` : `#${alphaHex}${rgbHex}`
}

export function buildAccentCssVars(accentColor: string): Record<string, string> {
  const softRgb = parseHex(accentColor)
  if (!softRgb) return {}

  const soft = accentColor
  const accent = darkenHex(soft, 0.18)
  const mid = darkenHex(soft, 0.08)
  const dark = darkenHex(soft, 0.38)
  const deep = darkenHex(soft, 0.52)
  const pale = lightenHex(soft, 0.18)

  const accentRgb = parseHex(accent)!
  const paleRgb = parseHex(pale)!
  const deepRgb = parseHex(deep)!

  const surfaceBase = darkenHex(deep, 0.68)
  const surfaceStrong = darkenHex(deep, 0.56)
  const surfaceSoft = darkenHex(deep, 0.43)
  const surfaceMuted = darkenHex(deep, 0.72)
  const surfaceElevated = darkenHex(deep, 0.38)

  const surfaceBaseRgb = parseHex(surfaceBase)!
  const surfaceStrongRgb = parseHex(surfaceStrong)!
  const surfaceSoftRgb = parseHex(surfaceSoft)!
  const surfaceMutedRgb = parseHex(surfaceMuted)!
  const surfaceElevatedRgb = parseHex(surfaceElevated)!

  const surfaceLightBase = mixHex(soft, '#ffffff', 0.92)
  const surfaceLightStrong = mixHex(soft, '#ffffff', 0.85)
  const surfaceLightSoft = mixHex(soft, '#ffffff', 0.78)

  const surfaceLightBaseRgb = parseHex(surfaceLightBase)!
  const surfaceLightStrongRgb = parseHex(surfaceLightStrong)!
  const surfaceLightSoftRgb = parseHex(surfaceLightSoft)!

  return {
    '--mousse-deep': deep,
    '--mousse-dark': dark,
    '--mousse-mid': mid,
    '--mousse-accent': accent,
    '--mousse-soft': soft,
    '--accent': soft,
    '--accent-hover': pale,
    '--accent-deep': accent,
    '--accent-rgb': rgbString(softRgb),
    '--accent-deep-rgb': rgbString(accentRgb),
    '--accent-pale-rgb': rgbString(paleRgb),
    '--accent-deep-dark-rgb': rgbString(deepRgb),
    '--surface-base': surfaceBase,
    '--surface-strong': surfaceStrong,
    '--surface-soft': surfaceSoft,
    '--surface-muted': surfaceMuted,
    '--surface-elevated': surfaceElevated,
    '--surface-base-rgb': rgbString(surfaceBaseRgb),
    '--surface-strong-rgb': rgbString(surfaceStrongRgb),
    '--surface-soft-rgb': rgbString(surfaceSoftRgb),
    '--surface-muted-rgb': rgbString(surfaceMutedRgb),
    '--surface-elevated-rgb': rgbString(surfaceElevatedRgb),
    '--surface-light-base': surfaceLightBase,
    '--surface-light-strong': surfaceLightStrong,
    '--surface-light-soft': surfaceLightSoft,
    '--surface-light-base-rgb': rgbString(surfaceLightBaseRgb),
    '--surface-light-strong-rgb': rgbString(surfaceLightStrongRgb),
    '--surface-light-soft-rgb': rgbString(surfaceLightSoftRgb),
    '--glass-bg': `rgba(${rgbString(surfaceBaseRgb)}, 0.58)`,
    '--glass-bg-strong': `rgba(${rgbString(surfaceStrongRgb)}, 0.68)`,
    '--glass-bg-soft': `rgba(${rgbString(surfaceSoftRgb)}, 0.52)`,
    '--terminal-bg': surfaceBase,
    '--gradient-accent': `linear-gradient(135deg, ${accent} 0%, ${pale} 100%)`,
    '--gradient-brand': `linear-gradient(135deg, ${deep} 0%, ${mid} 52%, ${pale} 100%)`,
    '--gradient-glow': `radial-gradient(ellipse at 20% 0%, rgba(${rgbString(accentRgb)}, 0.12) 0%, transparent 55%)`,
    '--gradient-surface': `linear-gradient(180deg, rgba(${rgbString(surfaceStrongRgb)}, 0.68) 0%, rgba(${rgbString(surfaceBaseRgb)}, 0.58) 100%)`,
    '--border': `rgba(${rgbString(paleRgb)}, 0.14)`
  }
}
