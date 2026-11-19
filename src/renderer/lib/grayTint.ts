import { parseHex } from '../../shared/accentPalette'

/**
 * Mousse Dark's grays lean very slightly toward the accent: each dark neutral gray moves up by at most
 * `GRAY_TINT_MAX` units on the accent's strongest channel and proportionally less on the others (#111111 becomes
 * #121113 under the default purple accent). One fixed offset for every gray, so the steps between them stay as they are.
 */
export const GRAY_TINT_MAX = 2
/** Grays brighter than this are text or light fills, not surfaces: they stay neutral. */
const DARK_GRAY_LIMIT = 0x40
/** A gray: its channels this close together. */
const NEUTRAL_SPREAD = 2
/** An accent this close to gray gives no direction to lean toward. */
const MIN_ACCENT_SPREAD = 16

export type GrayTint = readonly [r: number, g: number, b: number]

/** The offset each gray takes from the accent, or null when the accent is not a color (or is a gray). */
export function accentGrayTint(accent: string): GrayTint | null {
  const rgb = parseHex(accent.trim())
  if (!rgb) return null
  const channels = [rgb.r, rgb.g, rgb.b]
  const low = Math.min(...channels)
  const spread = Math.max(...channels) - low
  if (spread < MIN_ACCENT_SPREAD) return null
  const [r, g, b] = channels.map((value) => Math.round(((value - low) / spread) * GRAY_TINT_MAX))
  return [r!, g!, b!]
}

function darkNeutral(channels: readonly number[]): boolean {
  return Math.max(...channels) <= DARK_GRAY_LIMIT && Math.max(...channels) - Math.min(...channels) <= NEUTRAL_SPREAD
}

const hex2 = (value: number) => Math.min(255, value).toString(16).padStart(2, '0')

/**
 * A dark neutral gray (#rrggbb, #rrggbbaa, or an "r, g, b" triple) moved by the tint; anything else (colors, light
 * grays, fully transparent values, expressions) as it is.
 */
export function tintGray(value: string, tint: GrayTint): string {
  const hex = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(value.trim())
  if (hex) {
    if (hex[2]?.toLowerCase() === '00') return value
    const channels = [0, 2, 4].map((at) => parseInt(hex[1]!.slice(at, at + 2), 16))
    if (!darkNeutral(channels)) return value
    return `#${channels.map((channel, i) => hex2(channel + tint[i]!)).join('')}${hex[2] ?? ''}`
  }
  const triple = /^(\d{1,3}),\s*(\d{1,3}),\s*(\d{1,3})$/.exec(value.trim())
  if (triple) {
    const channels = triple.slice(1).map(Number)
    if (!darkNeutral(channels)) return value
    return channels.map((channel, i) => Math.min(255, channel + tint[i]!)).join(', ')
  }
  return value
}
