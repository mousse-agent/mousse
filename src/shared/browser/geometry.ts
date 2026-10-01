import type { BrowserPoint, BrowserScreenshot, BrowserViewport } from './types'

function positive(value: number): boolean { return Number.isFinite(value) && value > 0 }

/** Image pixels -> viewport CSS pixels. Never infer scale from devicePixelRatio. */
export function imagePointToViewport(point: BrowserPoint, image: BrowserScreenshot, viewport: BrowserViewport): BrowserPoint {
  const origin = image.cropOriginCss ?? { x: 0, y: 0 }
  if (![image.pixelWidth, image.pixelHeight, image.cssToImageScaleX, image.cssToImageScaleY, viewport.cssWidth, viewport.cssHeight].every(positive) ||
    ![origin.x, origin.y, point.x, point.y].every(Number.isFinite) || origin.x < 0 || origin.y < 0 ||
    point.x < 0 || point.y < 0 || point.x >= image.pixelWidth || point.y >= image.pixelHeight) throw new Error('invalid_geometry')
  const mapped = { x: origin.x + point.x / image.cssToImageScaleX, y: origin.y + point.y / image.cssToImageScaleY }
  if (mapped.x >= viewport.cssWidth || mapped.y >= viewport.cssHeight) throw new Error('invalid_geometry')
  if (origin.x + image.pixelWidth / image.cssToImageScaleX > viewport.cssWidth + 0.5 ||
    origin.y + image.pixelHeight / image.cssToImageScaleY > viewport.cssHeight + 0.5) throw new Error('invalid_geometry')
  return mapped
}
