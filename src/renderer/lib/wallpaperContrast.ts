/**
 * How much a wallpaper must be covered by the theme's background (the scrim) for text on it to stay readable. The
 * browser blends the scrim over the image in sRGB, and text over both, so the same blend is done here per sample of the
 * image, and the WCAG contrast of the text against the result is measured.
 */

export interface Rgba {
  r: number
  g: number
  b: number
  /** 0 to 1. */
  a: number
}

/** The contrast text needs against its background (WCAG AA for normal text). */
export const READABLE_CONTRAST = 4.5
/**
 * The share of the image's samples that set the floor: the 98th percentile, so a highlight covering less than about 2%
 * of the image does not force a nearly solid scrim. Text over such a spot may read below 4.5:1.
 */
export const FLOOR_PERCENTILE = 0.98

function channel(value: number): number {
  const c = value / 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

function luminance(r: number, g: number, b: number): number {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

export function contrastRatio(a: [number, number, number], b: [number, number, number]): number {
  const la = luminance(a[0], a[1], a[2])
  const lb = luminance(b[0], b[1], b[2])
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/** `top` (with its alpha) over the opaque `under`. */
function over(top: Rgba, under: [number, number, number]): [number, number, number] {
  return [top.r * top.a + under[0] * (1 - top.a), top.g * top.a + under[1] * (1 - top.a), top.b * top.a + under[2] * (1 - top.a)]
}

function readable(texts: readonly Rgba[], background: [number, number, number]): boolean {
  return texts.every((text) => contrastRatio(over(text, background), background) >= READABLE_CONTRAST)
}

/**
 * The smallest scrim alpha at which every text colour reads against `pixel` (already flattened onto the base) under a
 * scrim of `base`; 1 when even a solid scrim does not make them read (the theme's own colours).
 */
export function scrimNeeded(pixel: [number, number, number], base: [number, number, number], texts: readonly Rgba[]): number {
  const at = (alpha: number) => readable(texts, over({ r: base[0], g: base[1], b: base[2], a: alpha }, pixel))
  if (at(0)) return 0
  if (!at(1)) return 1
  let low = 0
  let high = 1
  for (let step = 0; step < 12; step++) {
    const middle = (low + high) / 2
    if (at(middle)) high = middle
    else low = middle
  }
  return high
}

/**
 * The scrim alpha the image needs (0 to 1): the `FLOOR_PERCENTILE` of what each sample needs. `samples` is RGBA, four
 * bytes per sample (an `ImageData`'s data); a transparent sample is flattened onto the base first, as the layer shows it.
 */
export function contrastFloor(samples: Uint8ClampedArray, base: Rgba, texts: readonly Rgba[]): number {
  const solid: [number, number, number] = [base.r, base.g, base.b]
  const needs: number[] = []
  for (let index = 0; index + 3 < samples.length; index += 4) {
    const pixel = over({ r: samples[index], g: samples[index + 1], b: samples[index + 2], a: samples[index + 3] / 255 }, solid)
    needs.push(scrimNeeded(pixel, solid, texts))
  }
  if (!needs.length) return 0
  needs.sort((a, b) => a - b)
  return needs[Math.min(needs.length - 1, Math.floor(FLOOR_PERCENTILE * needs.length))]
}
