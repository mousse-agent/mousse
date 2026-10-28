import { EventEmitter } from 'node:events'
import type { BrowserWindow } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BLUR_BEHIND_PROPERTY,
  blurRegionCardinals,
  linuxUsesX11,
  setLinuxBlurBehind,
  x11WindowId,
  xpropBlurArgs
} from '../src/main/linuxBlurBehind'
import { roundedWindowShape } from '../src/main/linuxWindowShape'

afterEach(() => vi.useRealTimers())

function fakeWindow(xid = 0x4a00007) {
  const handle = Buffer.alloc(4)
  handle.writeUInt32LE(xid)
  const state = { width: 900, height: 600, maximized: false }
  const win = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    isFullScreen: () => false,
    isMaximized: () => state.maximized,
    getBounds: () => ({ x: 0, y: 0, width: state.width, height: state.height }),
    getNativeWindowHandle: () => handle
  })
  return { win: win as unknown as BrowserWindow & EventEmitter, state }
}

describe('KDE blur behind', () => {
  it('only targets X11 windows, including Xwayland', () => {
    expect(linuxUsesX11('linux', { DISPLAY: ':0' }, ['electron', '--ozone-platform=x11'])).toBe(true)
    expect(linuxUsesX11('linux', { DISPLAY: ':0', WAYLAND_DISPLAY: 'wayland-0' }, [])).toBe(true)
    expect(linuxUsesX11('linux', { DISPLAY: ':0' }, ['--ozone-platform=wayland'])).toBe(false)
    expect(linuxUsesX11('linux', { DISPLAY: ':0' }, ['--ozone-platform', 'wayland'])).toBe(false)
    expect(linuxUsesX11('linux', { WAYLAND_DISPLAY: 'wayland-0' }, [])).toBe(false)
    expect(linuxUsesX11('darwin', { DISPLAY: ':0' }, [])).toBe(false)
  })

  it('reads the X11 window id from 4- and 8-byte native handles', () => {
    const short = Buffer.alloc(4)
    short.writeUInt32LE(0x4a00007)
    const long = Buffer.alloc(8)
    long.writeBigUInt64LE(0x4a00007n)
    expect(x11WindowId(short)).toBe('0x4a00007')
    expect(x11WindowId(long)).toBe('0x4a00007')
    expect(x11WindowId(Buffer.alloc(8))).toBeNull()
    expect(x11WindowId(Buffer.alloc(0))).toBeNull()
  })

  it('scales the rounded shape into whole physical pixels that cover each row', () => {
    expect(blurRegionCardinals([{ x: 0, y: 12, width: 900, height: 576 }], 1)).toEqual([0, 12, 900, 576])
    expect(blurRegionCardinals([{ x: 3, y: 1, width: 5, height: 1 }], 1.5)).toEqual([4, 1, 8, 2])
  })

  it('sets and removes the property with xprop', () => {
    expect(xpropBlurArgs('0x1', [0, 0, 10, 10])).toEqual(['-id', '0x1', '-f', BLUR_BEHIND_PROPERTY, '32c', '-set', BLUR_BEHIND_PROPERTY, '0,0,10,10'])
    expect(xpropBlurArgs('0x1', null)).toEqual(['-id', '0x1', '-remove', BLUR_BEHIND_PROPERTY])
  })

  it('blurs the rounded shape, follows resizes once they settle, and clears when acrylic is off', () => {
    vi.useFakeTimers()
    const run = vi.fn()
    const { win, state } = fakeWindow()
    setLinuxBlurBehind(win, true, run, () => 1)
    expect(run).toHaveBeenCalledTimes(1)
    expect(run.mock.lastCall![0]).toEqual(xpropBlurArgs('0x4a00007', blurRegionCardinals(roundedWindowShape(900, 600), 1)))

    // Unchanged state sends nothing; a resize burst sends one update.
    setLinuxBlurBehind(win, true, run, () => 1)
    state.width = 1000; win.emit('resize')
    state.width = 1100; win.emit('resize')
    expect(run).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(150)
    expect(run).toHaveBeenCalledTimes(2)
    expect(run.mock.lastCall![0]).toEqual(xpropBlurArgs('0x4a00007', blurRegionCardinals(roundedWindowShape(1100, 600), 1)))

    state.maximized = true; win.emit('maximize')
    vi.advanceTimersByTime(150)
    expect(run.mock.lastCall![0]).toEqual(xpropBlurArgs('0x4a00007', [0, 0, 1100, 600]))

    setLinuxBlurBehind(win, false, run, () => 1)
    expect(run.mock.lastCall![0]).toEqual(xpropBlurArgs('0x4a00007', null))
    const calls = run.mock.calls.length
    win.emit('resize')
    vi.advanceTimersByTime(150)
    setLinuxBlurBehind(win, false, run, () => 1)
    expect(run).toHaveBeenCalledTimes(calls)
  })

  it('does not clear a hint it never set', () => {
    const run = vi.fn()
    setLinuxBlurBehind(fakeWindow().win, false, run, () => 1)
    expect(run).not.toHaveBeenCalled()
  })
})
