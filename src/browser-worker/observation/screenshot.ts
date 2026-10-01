import type { BrowserPoint, BrowserScreenshot, BrowserViewport } from '../../shared/browser/types'
import type { CdpTransport } from '../cdp/transport'
import { fail } from '../errors'
import { pngDimensions } from './png'

export interface ScreenshotCapture {
  bytes: Uint8Array
  screenshot: Omit<BrowserScreenshot, 'artifactId'>
}

export async function captureViewportScreenshot(
  cdp: CdpTransport,
  cdpSessionId: string,
  viewport: BrowserViewport,
  clip?: { x: number; y: number; width: number; height: number },
  options: { fromSurface?: boolean; timeoutMs?: number } = {}
): Promise<ScreenshotCapture> {
  const region = clip ?? { x: 0, y: 0, width: viewport.cssWidth, height: viewport.cssHeight }
  if (![region.x, region.y, region.width, region.height].every((value) => Number.isFinite(value)) || region.width < 1 || region.height < 1) {
    fail('invalid_geometry', 'Screenshot clip is invalid')
  }
  if (region.x < 0 || region.y < 0 || region.x + region.width > viewport.cssWidth + 0.5 || region.y + region.height > viewport.cssHeight + 0.5) {
    fail('invalid_geometry', 'Screenshot clip is outside the current viewport')
  }
  const result = await cdp.send<{ data: string }>('Page.captureScreenshot', {
    format: 'png',
    fromSurface: options.fromSurface !== false,
    captureBeyondViewport: false,
    clip: { x: region.x, y: region.y, width: region.width, height: region.height, scale: 1 }
  }, { sessionId: cdpSessionId, timeoutMs: options.timeoutMs ?? 15_000 })
  const bytes = Buffer.from(result.data, 'base64')
  const { width, height } = pngDimensions(bytes)
  const cssToImageScaleX = width / region.width
  const cssToImageScaleY = height / region.height
  if (!(cssToImageScaleX > 0) || !(cssToImageScaleY > 0)) fail('invalid_geometry', 'Screenshot scale is invalid')
  const cropOriginCss: BrowserPoint | undefined = region.x === 0 && region.y === 0 ? undefined : { x: region.x, y: region.y }
  return {
    bytes,
    screenshot: {
      pixelWidth: width,
      pixelHeight: height,
      cssToImageScaleX,
      cssToImageScaleY,
      ...(cropOriginCss ? { cropOriginCss } : {})
    }
  }
}
