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
/** The least contrast text has anywhere on the image, including the spots the percentile leaves out (WCAG AA for large text). */
export const LEAST_CONTRAST = 3
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

function readable(texts: readonly Rgba[], background: [number, number, number], needed: number): boolean {
  return texts.every((text) => contrastRatio(over(text, background), background) >= needed)
}

/**
 * The smallest scrim alpha at which every text colour reads against `pixel` (already flattened onto the base) under a
 * scrim of `base`; 1 when even a solid scrim does not make them read (the theme's own colours).
 */
export function scrimNeeded(pixel: [number, number, number], base: [number, number, number], texts: readonly Rgba[], needed = READABLE_CONTRAST): number {
  return leastScrim((alpha) => readable(texts, over({ r: base[0], g: base[1], b: base[2], a: alpha }, pixel), needed))
}

/** The smallest scrim alpha at which `reads` holds: 0 when none is needed, 1 when even a solid scrim does not do it. */
function leastScrim(reads: (alpha: number) => boolean): number {
  if (reads(0)) return 0
  if (!reads(1)) return 1
  let low = 0
  let high = 1
  for (let step = 0; step < 12; step++) {
    const middle = (low + high) / 2
    if (reads(middle)) high = middle
    else low = middle
  }
  return high
}

/**
 * A see-through layer: the wallpaper and its scrim drawn at `opacity` (0 to 1) with no solid colour under them, over
 * `backdrop` (what shows through, taken as opaque). Under acrylic the backdrop is the window's tint.
 */
export interface SeeThrough {
  opacity: number
  backdrop: Rgba
}

/**
 * What text sits on over one image sample (`pixel`, alpha 0 to 1) under a scrim of `base` at `alpha`, the two drawn at
 * `layer.opacity` over `layer.backdrop`. A transparent sample shows only the scrim there.
 */
function seenThrough(pixel: Rgba, base: [number, number, number], alpha: number, layer: SeeThrough): [number, number, number] {
  const image = [pixel.r, pixel.g, pixel.b]
  const backdrop = [layer.backdrop.r, layer.backdrop.g, layer.backdrop.b]
  // The layer's colour premultiplied by its coverage: the scrim over the image over nothing.
  const coverage = alpha + (1 - alpha) * pixel.a
  return [0, 1, 2].map((i) => layer.opacity * (base[i] * alpha + image[i] * pixel.a * (1 - alpha)) + (1 - layer.opacity * coverage) * backdrop[i]) as [number, number, number]
}

/**
 * The scrim alpha the image needs (0 to 1): the `FLOOR_PERCENTILE` of what each sample needs for 4.5:1, and at least
 * what every sample needs for 3:1, so no spot of the image leaves text unreadable. `samples` is RGBA, four bytes per
 * sample (an `ImageData`'s data). Without `layer` the image sits on the solid base (a transparent sample shows the base);
 * with it the layer is see-through, and the floor is measured against what shows through as well.
 */
export function contrastFloor(samples: Uint8ClampedArray, base: Rgba, texts: readonly Rgba[], layer?: SeeThrough): number {
  const solid: [number, number, number] = [base.r, base.g, base.b]
  const needs: number[] = []
  let least = 0
  for (let index = 0; index + 3 < samples.length; index += 4) {
    const sample: Rgba = { r: samples[index], g: samples[index + 1], b: samples[index + 2], a: samples[index + 3] / 255 }
    if (layer) {
      const at = (needed: number) => (alpha: number) => readable(texts, seenThrough(sample, solid, alpha, layer), needed)
      needs.push(leastScrim(at(READABLE_CONTRAST)))
      least = Math.max(least, leastScrim(at(LEAST_CONTRAST)))
      continue
    }
    const pixel = over(sample, solid)
    needs.push(scrimNeeded(pixel, solid, texts))
    least = Math.max(least, scrimNeeded(pixel, solid, texts, LEAST_CONTRAST))
  }
  if (!needs.length) return 0
  needs.sort((a, b) => a - b)
  return Math.max(least, needs[Math.min(needs.length - 1, Math.floor(FLOOR_PERCENTILE * needs.length))])
}
