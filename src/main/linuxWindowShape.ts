import type { BrowserWindow, Rectangle } from 'electron'

/** Enforce the boundary even when the compositor does not round frameless windows. */
export function roundedWindowShape(width: number, height: number, radius = 12): Rectangle[] {
  const r = Math.min(radius, Math.floor(width / 2), Math.floor(height / 2))
  if (r <= 0) return [{ x: 0, y: 0, width, height }]
  const rows: Rectangle[] = [{ x: 0, y: r, width, height: height - 2 * r }]
  for (let y = 0; y < r; y++) {
    const inset = Math.ceil(r - Math.sqrt(r * r - (r - y - 0.5) ** 2))
    rows.push({ x: inset, y, width: width - 2 * inset, height: 1 })
    rows.push({ x: inset, y: height - y - 1, width: width - 2 * inset, height: 1 })
  }
  return rows.filter((row) => row.width > 0 && row.height > 0)
}

/** The window's current shape in DIPs, plus a key that changes whenever the shape does. */
export function currentLinuxWindowShape(win: BrowserWindow): { key: string; rects: Rectangle[] } {
  const { width, height } = win.getBounds()
  const square = win.isMaximized() || win.isFullScreen()
  // On X11 an empty shape is an empty drawable/input region, not a reset.
  // Keep maximized and fullscreen windows visible with their complete bounds.
  return {
    key: `${width}:${height}:${square}`,
    rects: square ? [{ x: 0, y: 0, width, height }] : roundedWindowShape(width, height)
  }
}

export const LINUX_SHAPE_EVENTS = ['resize', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen', 'show'] as const

export function attachLinuxWindowShape(win: BrowserWindow, platform: NodeJS.Platform = process.platform): void {
  if (platform !== 'linux') return
  let previous = ''
  const update = () => {
    if (win.isDestroyed()) return
    const shape = currentLinuxWindowShape(win)
    if (shape.key === previous) return
    win.setShape(shape.rects)
    previous = shape.key
  }
  for (const event of LINUX_SHAPE_EVENTS) win.on(event as 'resize', update)
  update()
}
