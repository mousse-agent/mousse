import { app, BrowserWindow, nativeImage, type NativeImage } from 'electron'

import { needsMeLabel } from '../shared/threadAttention'

/**
 * How many threads need the person, from the counts each window reports. A profile open in two
 * windows reports the same threads twice, so it counts once; different profiles add up.
 */
export class AttentionCounts {
  private readonly byWindow = new Map<number, { profile: string; count: number }>()

  has(windowId: number): boolean {
    return this.byWindow.has(windowId)
  }

  /** Records one window's count and returns the total. */
  set(windowId: number, profile: string, count: number): number {
    this.byWindow.set(windowId, { profile, count: Math.max(0, Math.floor(count)) || 0 })
    return this.total()
  }

  /** Forgets a closed window and returns the total. */
  drop(windowId: number): number {
    this.byWindow.delete(windowId)
    return this.total()
  }

  total(): number {
    const byProfile = new Map<string, number>()
    for (const { profile, count } of this.byWindow.values()) byProfile.set(profile, Math.max(byProfile.get(profile) ?? 0, count))
    let total = 0
    for (const count of byProfile.values()) total += count
    return total
  }
}

/** The status colour of "needs you" (indigo), as the taskbar overlay draws it. */
const DOT_RGB = [0x63, 0x66, 0xf1] as const

/** A `size`×`size` BGRA bitmap of a filled, softly edged dot: the Windows taskbar overlay. */
export function attentionDotBitmap(size = 16): Buffer {
  const pixels = Buffer.alloc(size * size * 4)
  const centre = (size - 1) / 2
  const radius = size / 2 - 1
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const distance = Math.hypot(x - centre, y - centre)
      const alpha = Math.max(0, Math.min(1, radius - distance + 0.5))
      const offset = (y * size + x) * 4
      pixels[offset] = DOT_RGB[2]
      pixels[offset + 1] = DOT_RGB[1]
      pixels[offset + 2] = DOT_RGB[0]
      pixels[offset + 3] = Math.round(alpha * 255)
    }
  }
  return pixels
}

let overlayDot: NativeImage | null = null

/**
 * Shows the count on the app icon: the dock badge on macOS, the launcher badge on Linux desktops
 * that have one, and a dot over the taskbar button on Windows (its tooltip says the count). 0 clears it.
 */
export function showAttentionCount(total: number): void {
  if (process.platform === 'win32') {
    overlayDot ??= nativeImage.createFromBitmap(attentionDotBitmap(), { width: 16, height: 16 })
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.setOverlayIcon(total > 0 ? overlayDot : null, total > 0 ? needsMeLabel(total) : '')
    }
    return
  }
  app.setBadgeCount(total)
}
