import type { BrowserPoint } from '../../shared/browser/types'
import { fail } from '../errors'

/** Where a viewport point falls on an `<iframe>`: in the frame it shows (at that frame's own point), or on its border or padding. */
export type FramePoint = { kind: 'inside'; point: BrowserPoint } | { kind: 'outside' }

/**
 * Maps a point in the viewport of the document holding an `<iframe>` into the viewport of the frame
 * it shows. `contentQuad` is the `<iframe>`'s content box as Chromium gives it (four corners, top-left
 * first, in that document's viewport, after any CSS transform); `size` is the frame's own viewport in
 * its CSS pixels. A scaled, rotated or skewed `<iframe>` maps through its corners, never by subtracting
 * its origin. A box that is flat (its corners on one line) or not a parallelogram (a perspective
 * transform) cannot be mapped reliably and is refused.
 */
export function pointInFrame(contentQuad: readonly number[], size: { width: number; height: number }, point: BrowserPoint): FramePoint {
  if (contentQuad.length < 8 || !contentQuad.slice(0, 8).every(Number.isFinite) || !(size.width > 0) || !(size.height > 0)
    || !Number.isFinite(size.width) || !Number.isFinite(size.height) || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    fail('invalid_geometry', 'The frame at the image point has no usable geometry')
  }
  const [x0, y0, x1, y1, x2, y2, x3, y3] = contentQuad
  // The frame's own x axis runs from its top-left corner to its top-right, its y axis to its bottom-left.
  const ex = { x: x1 - x0, y: y1 - y0 }
  const ey = { x: x3 - x0, y: y3 - y0 }
  const lengthX = Math.hypot(ex.x, ex.y)
  const lengthY = Math.hypot(ey.x, ey.y)
  const det = ex.x * ey.y - ex.y * ey.x
  if (lengthX < 1e-6 || lengthY < 1e-6 || Math.abs(det) < 1e-6 * lengthX * lengthY) {
    fail('invalid_geometry', 'The frame at the image point is flattened and cannot be mapped')
  }
  // An affine transform keeps the box a parallelogram: its fourth corner is where the other three say.
  const tolerance = Math.max(0.5, 0.005 * (lengthX + lengthY))
  if (Math.hypot(x2 - (x0 + ex.x + ey.x), y2 - (y0 + ex.y + ey.y)) > tolerance) {
    fail('invalid_geometry', 'The frame at the image point is in perspective and cannot be mapped')
  }
  const vx = point.x - x0
  const vy = point.y - y0
  // The point as fractions of the frame's two axes.
  const u = (vx * ey.y - vy * ey.x) / det
  const v = (ex.x * vy - ex.y * vx) / det
  if (u < 0 || u >= 1 || v < 0 || v >= 1) return { kind: 'outside' }
  return { kind: 'inside', point: { x: u * size.width, y: v * size.height } }
}

/** What an image point on an `<iframe>` does next: enter the attached frame it shows, act on the `<iframe>` itself, or stop. */
export type FrameStep<T> = { kind: 'enter'; frame: T } | { kind: 'stay' } | { kind: 'refuse' }

/**
 * Decides which attached frame an `<iframe>` hit at an image point shows. Only the attached frame whose
 * id is the one the `<iframe>` shows is entered: never one picked by its parent, its address or its
 * position, as a frame behind it may share all three. A frame of the hit document's own process
 * (`inProcessFrameIds`, a same-site overlay) is acted on as the `<iframe>` element. Anything else (an
 * unattached frame, two claiming one id, or a process whose frames could not be listed) is refused:
 * input sent there could reach the wrong frame.
 */
export function frameStepAt<T extends { frameId: string }>(contentFrameId: string, attached: readonly T[], inProcessFrameIds: ReadonlySet<string> | undefined): FrameStep<T> {
  const exact = attached.filter((frame) => frame.frameId === contentFrameId)
  if (exact.length === 1) return { kind: 'enter', frame: exact[0] }
  if (exact.length === 0 && inProcessFrameIds?.has(contentFrameId)) return { kind: 'stay' }
  return { kind: 'refuse' }
}
