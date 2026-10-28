import { execFile } from 'node:child_process'
import { screen } from 'electron'
import type { BrowserWindow, Rectangle } from 'electron'
import { currentLinuxWindowShape, LINUX_SHAPE_EVENTS } from './linuxWindowShape'

/**
 * KWin's blur-behind hint. KDE Plasma blurs whatever sits behind the listed
 * window-local rectangles (physical pixels). Mousse runs on X11 or Xwayland, so
 * the hint works in Plasma's X11 and Wayland sessions. Other compositors ignore it.
 */
export const BLUR_BEHIND_PROPERTY = '_KDE_NET_WM_BLUR_BEHIND_REGION'

/** The hint is an X11 window property; a native Wayland surface has no XID. */
export function linuxUsesX11(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  argv: readonly string[] = process.argv
): boolean {
  if (platform !== 'linux' || !env.DISPLAY) return false
  const ozoneIndex = argv.indexOf('--ozone-platform')
  return !argv.includes('--ozone-platform=wayland') &&
    !(ozoneIndex >= 0 && argv[ozoneIndex + 1] === 'wayland')
}

/** Flatten DIP shape rows into x,y,width,height cardinals in physical pixels. */
export function blurRegionCardinals(rects: readonly Rectangle[], scale: number): number[] {
  return rects.flatMap((rect) => {
    const x = Math.floor(rect.x * scale)
    const y = Math.floor(rect.y * scale)
    return [x, y, Math.ceil((rect.x + rect.width) * scale) - x, Math.ceil((rect.y + rect.height) * scale) - y]
  })
}

/** Electron returns the X11 window id as a native-endian unsigned integer. */
export function x11WindowId(handle: Buffer): string | null {
  if (handle.length < 4) return null
  const id = handle.length >= 8 ? Number(handle.readBigUInt64LE(0)) : handle.readUInt32LE(0)
  return id > 0 ? `0x${id.toString(16)}` : null
}

export function xpropBlurArgs(windowId: string, cardinals: readonly number[] | null): string[] {
  return cardinals
    ? ['-id', windowId, '-f', BLUR_BEHIND_PROPERTY, '32c', '-set', BLUR_BEHIND_PROPERTY, cardinals.join(',')]
    : ['-id', windowId, '-remove', BLUR_BEHIND_PROPERTY]
}

type RunXprop = (args: string[]) => void

let xpropMissing = false
const runXprop: RunXprop = (args) => {
  if (xpropMissing) return
  execFile('xprop', args, { timeout: 2000 }, (error) => {
    if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') return
    xpropMissing = true
    console.info('[window] xprop is not installed; Linux blur behind is unavailable')
  })
}

interface BlurState { enabled: boolean; applied: string; timer: ReturnType<typeof setTimeout> | null }
const blurStates = new WeakMap<BrowserWindow, BlurState>()

/**
 * Ask the compositor to blur behind the window's rounded shape while acrylic
 * is on, and clear the hint when it is off. Resizes re-send the region once the
 * gesture settles, since every call starts an xprop process.
 */
export function setLinuxBlurBehind(
  win: BrowserWindow,
  enabled: boolean,
  run: RunXprop = runXprop,
  scaleFor: (win: BrowserWindow) => number = (w) => screen.getDisplayMatching(w.getBounds()).scaleFactor
): void {
  let state = blurStates.get(win)
  if (!state) {
    const created: BlurState = { enabled, applied: '', timer: null }
    state = created
    blurStates.set(win, created)
    const schedule = () => {
      if (!created.enabled) return
      if (created.timer) clearTimeout(created.timer)
      created.timer = setTimeout(() => {
        created.timer = null
        sync(win, created, run, scaleFor)
      }, 150)
    }
    for (const event of LINUX_SHAPE_EVENTS) win.on(event as 'resize', schedule)
    win.on('closed', () => {
      if (created.timer) clearTimeout(created.timer)
    })
  }
  state.enabled = enabled
  sync(win, state, run, scaleFor)
}

function sync(win: BrowserWindow, state: BlurState, run: RunXprop, scaleFor: (win: BrowserWindow) => number): void {
  if (win.isDestroyed()) return
  const windowId = x11WindowId(win.getNativeWindowHandle())
  if (!windowId) return
  const shape = state.enabled ? currentLinuxWindowShape(win) : null
  const scale = shape ? scaleFor(win) : 1
  const key = shape ? `${shape.key}@${scale}` : 'off'
  // Nothing was ever set, so there is nothing to clear.
  if (key === state.applied || (key === 'off' && !state.applied)) return
  run(xpropBlurArgs(windowId, shape ? blurRegionCardinals(shape.rects, scale) : null))
  state.applied = key
}
