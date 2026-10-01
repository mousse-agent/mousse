import type { BrowserWindow, Point, Rectangle } from 'electron'
import { isWindowResizeEdge, type WindowResizeEdge } from '../shared/windowResize'

interface ResizeGesture {
  pointerId: number
  edge: WindowResizeEdge
  cursor: Point
  bounds: Rectangle
}

/** Transparent Linux windows need client-side resize handles. Keep each gesture
 * in its own native window and use main-process cursor coordinates in DIP. */
export class LinuxWindowResizeController {
  private gestures = new WeakMap<BrowserWindow, ResizeGesture>()
  private watched = new WeakSet<BrowserWindow>()

  constructor(private cursor: () => Point, private platform: NodeJS.Platform = process.platform) {}

  begin(win: BrowserWindow, edge: unknown, pointerId: unknown): boolean {
    if (!this.canResize(win) || !isWindowResizeEdge(edge) || !this.validPointer(pointerId)) return false
    const cursor = this.cursor()
    if (!Number.isFinite(cursor.x) || !Number.isFinite(cursor.y)) return false
    this.gestures.set(win, { pointerId, edge, cursor, bounds: win.getBounds() })
    if (!this.watched.has(win)) {
      this.watched.add(win)
      const cancel = () => this.gestures.delete(win)
      win.on('blur', cancel)
      win.on('closed', cancel)
      win.on('maximize', cancel)
      win.on('enter-full-screen', cancel)
      win.webContents.on('did-start-loading', cancel)
    }
    return true
  }

  move(win: BrowserWindow, pointerId: unknown): void {
    const gesture = this.gestures.get(win)
    if (!gesture || !this.validPointer(pointerId) || gesture.pointerId !== pointerId) return
    if (!this.canResize(win)) { this.gestures.delete(win); return }
    const cursor = this.cursor()
    if (!Number.isFinite(cursor.x) || !Number.isFinite(cursor.y)) return
    const dx = cursor.x - gesture.cursor.x, dy = cursor.y - gesture.cursor.y
    const { bounds, edge } = gesture
    const [minWidth, minHeight] = win.getMinimumSize()
    const [maxWidth, maxHeight] = win.getMaximumSize()
    const clampSize = (value: number, min: number, max: number) => Math.round(Math.min(Math.max(value, Math.max(1, min)), max > 0 ? Math.max(min, max) : Infinity))
    const width = edge.includes('e') || edge.includes('w') ? clampSize(bounds.width + (edge.includes('w') ? -dx : dx), minWidth, maxWidth) : bounds.width
    const height = edge.includes('n') || edge.includes('s') ? clampSize(bounds.height + (edge.includes('n') ? -dy : dy), minHeight, maxHeight) : bounds.height
    win.setBounds({ x: edge.includes('w') ? bounds.x + bounds.width - width : bounds.x,
      y: edge.includes('n') ? bounds.y + bounds.height - height : bounds.y, width, height }, false)
  }

  end(win: BrowserWindow, pointerId: unknown): void {
    if (this.gestures.get(win)?.pointerId !== pointerId) return
    this.move(win, pointerId)
    this.gestures.delete(win)
  }

  private canResize(win: BrowserWindow): boolean {
    return this.platform === 'linux' && !win.isDestroyed() && win.isResizable() && !win.isMaximized() && !win.isFullScreen()
  }
  private validPointer(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
  }
}
