/**
 * How much of the theme's background covers a wallpaper so text stays readable (4.5:1): measured per sample of the image
 * as the browser blends it, in both directions (light text over bright spots, dark text over dark ones), with
 * semi-transparent secondary text composited, and a solid surface when nothing less will do. Under acrylic the layer is
 * see-through (drawn at an opacity over the window's tint), and the floor is measured for what text then sits on.
 */
import { describe, expect, it } from 'vitest'
import { contrastFloor, contrastRatio, READABLE_CONTRAST, scrimNeeded, type Rgba } from '../src/renderer/lib/wallpaperContrast'

const rgba = (r: number, g: number, b: number, a = 1): Rgba => ({ r, g, b, a })
const DARK = { base: rgba(16, 20, 24), texts: [rgba(230, 230, 230), rgba(230, 230, 230, 0.68)] }
const LIGHT = { base: rgba(250, 250, 250), texts: [rgba(20, 20, 20), rgba(20, 20, 20, 0.62)] }

/** `count` samples of one colour, RGBA. */
function fill(count: number, [r, g, b, a = 255]: number[]): Uint8ClampedArray {
  const data = new Uint8ClampedArray(count * 4)
  for (let index = 0; index < count; index++) data.set([r, g, b, a], index * 4)
  return data
}

/** A checkerboard of two colours. */
function checker(count: number, one: number[], two: number[]): Uint8ClampedArray {
  const data = new Uint8ClampedArray(count * 4)
  for (let index = 0; index < count; index++) data.set([...(index % 2 ? one : two), 255].slice(0, 4), index * 4)
  return data
}

function textReads(pixel: [number, number, number], theme: typeof DARK, scrim: number): boolean {
  const bg: [number, number, number] = [0, 1, 2].map((i) => [theme.base.r, theme.base.g, theme.base.b][i] * scrim + pixel[i] * (1 - scrim)) as [number, number, number]
  return theme.texts.every((text) => {
    const shown: [number, number, number] = [0, 1, 2].map((i) => [text.r, text.g, text.b][i] * text.a + bg[i] * (1 - text.a)) as [number, number, number]
    return contrastRatio(shown, bg) >= READABLE_CONTRAST - 1e-6
  })
}

describe('contrastFloor', () => {
  it.each([
    ['a dark image under a dark theme needs no scrim', DARK, [0, 0, 0], 0, 0.01],
    ['a white image under a dark theme needs most of the base', DARK, [255, 255, 255], 0.5, 0.95],
    ['a black image under a light theme needs most of the base (dark text, dark image)', LIGHT, [0, 0, 0], 0.5, 0.95],
    ['a white image under a light theme needs none', LIGHT, [255, 255, 255], 0, 0.01]
  ])('%s', (_name, theme, colour, low, high) => {
    const floor = contrastFloor(fill(100, colour), theme.base, theme.texts)
    expect(floor).toBeGreaterThanOrEqual(low)
    expect(floor).toBeLessThanOrEqual(high)
    expect(textReads(colour as [number, number, number], theme, floor)).toBe(true)
  })

  it('measures both extremes of a black-and-white checkerboard: light theme and dark theme each need a scrim', () => {
    const board = checker(1000, [0, 0, 0], [255, 255, 255])
    expect(contrastFloor(board, DARK.base, DARK.texts)).toBeGreaterThan(0.5)
    expect(contrastFloor(board, LIGHT.base, LIGHT.texts)).toBeGreaterThan(0.5)
  })

  it('a transparent image shows the base colour, which needs no scrim', () => {
    expect(contrastFloor(fill(100, [255, 255, 255, 0]), DARK.base, DARK.texts)).toBe(0)
  })

  it('a highlight under 2% of the image is held to 3:1, not 4.5:1; one over 2% is held to 4.5:1', () => {
    const small = fill(1000, [0, 0, 0])
    for (let index = 0; index < 15; index++) small.set([255, 255, 255, 255], index * 4)
    const smallFloor = contrastFloor(small, DARK.base, DARK.texts)
    const large = fill(1000, [0, 0, 0])
    for (let index = 0; index < 30; index++) large.set([255, 255, 255, 255], index * 4)
    const largeFloor = contrastFloor(large, DARK.base, DARK.texts)
    expect(smallFloor).toBeGreaterThan(0)
    expect(smallFloor).toBeLessThan(largeFloor)
    // Text over the small highlight still reads at 3:1 at least; over the large one at 4.5:1.
    expect(smallFloor).toBeCloseTo(scrimNeeded([255, 255, 255], [16, 20, 24], DARK.texts, 3), 3)
    expect(textReads([255, 255, 255], DARK, largeFloor)).toBe(true)
  })

  it('a theme whose own text does not read on its own base gets a solid surface (1)', () => {
    const grey = rgba(128, 128, 128)
    expect(scrimNeeded([255, 255, 255], [120, 120, 120], [grey])).toBe(1)
    expect(contrastFloor(fill(10, [255, 255, 255]), rgba(120, 120, 120), [grey])).toBe(1)
  })

  it('counts secondary text with its alpha: fainter text needs more scrim', () => {
    const pixel: [number, number, number] = [180, 180, 180]
    const solidOnly = scrimNeeded(pixel, [16, 20, 24], [rgba(230, 230, 230)])
    const withFaint = scrimNeeded(pixel, [16, 20, 24], [rgba(230, 230, 230), rgba(230, 230, 230, 0.6)])
    expect(withFaint).toBeGreaterThan(solidOnly)
  })
})

/** What text sits on over an opaque `pixel` when the layer (scrim over image) is drawn at `opacity` over `backdrop`. */
function seen(pixel: number[], theme: typeof DARK, scrim: number, opacity: number, backdrop: Rgba): [number, number, number] {
  const base = [theme.base.r, theme.base.g, theme.base.b]
  const under = [backdrop.r, backdrop.g, backdrop.b]
  return [0, 1, 2].map((i) => opacity * (base[i] * scrim + pixel[i] * (1 - scrim)) + (1 - opacity) * under[i]) as [number, number, number]
}

function readsOn(background: [number, number, number], theme: typeof DARK): boolean {
  return theme.texts.every((text) => {
    const shown: [number, number, number] = [0, 1, 2].map((i) => [text.r, text.g, text.b][i] * text.a + background[i] * (1 - text.a)) as [number, number, number]
    return contrastRatio(shown, background) >= READABLE_CONTRAST - 1e-6
  })
}

describe('contrastFloor for a see-through layer (acrylic)', () => {
  const OPACITY = 0.55

  it.each([
    ['dark theme, white image, tint like the base', DARK, [255, 255, 255], DARK.base],
    ['dark theme, white image, a lighter tint', DARK, [255, 255, 255], rgba(60, 64, 70)],
    ['light theme, black image, tint like the base', LIGHT, [0, 0, 0], LIGHT.base],
    ['dark theme, mid-grey image', DARK, [150, 150, 150], DARK.base]
  ])('%s: text reads at the floor and not clearly below it', (_name, theme, colour, backdrop) => {
    const layer = { opacity: OPACITY, backdrop }
    const floor = contrastFloor(fill(100, colour), theme.base, theme.texts, layer)
    expect(floor).toBeGreaterThan(0)
    expect(floor).toBeLessThan(1)
    expect(readsOn(seen(colour, theme, floor, OPACITY, backdrop), theme)).toBe(true)
    expect(readsOn(seen(colour, theme, floor - 0.02, OPACITY, backdrop), theme)).toBe(false)
  })

  it('a lighter tint behind the layer needs more scrim than one like the base, under a dark theme', () => {
    const white = fill(100, [255, 255, 255])
    const likeBase = contrastFloor(white, DARK.base, DARK.texts, { opacity: OPACITY, backdrop: DARK.base })
    const lighter = contrastFloor(white, DARK.base, DARK.texts, { opacity: OPACITY, backdrop: rgba(60, 64, 70) })
    expect(lighter).toBeGreaterThan(likeBase)
  })

  it('a dark image under a dark theme over its own tint needs no scrim', () => {
    expect(contrastFloor(fill(100, [0, 0, 0]), DARK.base, DARK.texts, { opacity: OPACITY, backdrop: DARK.base })).toBe(0)
  })

  it('a tint that text does not read on even under a solid scrim gets a solid scrim (1)', () => {
    expect(contrastFloor(fill(10, [255, 255, 255]), DARK.base, DARK.texts, { opacity: OPACITY, backdrop: rgba(255, 255, 255) })).toBe(1)
  })
})
