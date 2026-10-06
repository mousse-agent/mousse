import { EventEmitter } from 'node:events'
import type { BrowserWindow } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { attachLinuxWindowShape, roundedWindowShape } from '../src/main/linuxWindowShape'

describe('Linux window boundary', () => {
  it('excludes corner pixels while preserving edge centers and the interior', () => {
    const rows = roundedWindowShape(900, 600)
    const contains = (x: number, y: number) => rows.some(r => x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height)
    for (const [x, y] of [[0, 0], [899, 0], [0, 599], [899, 599]]) expect(contains(x, y)).toBe(false)
    for (const [x, y] of [[450, 0], [0, 300], [899, 300], [450, 599], [450, 300]]) expect(contains(x, y)).toBe(true)
  })
  it('updates with size, uses the full boundary on maximize, and restores it on unmaximize', () => {
    const win = Object.assign(new EventEmitter(), {
      isDestroyed: () => false, isFullScreen: () => false,
      isMaximized: () => maximized, getBounds: () => ({ width, height: 600 }), setShape: vi.fn()
    })
    let width = 900, maximized = false
    attachLinuxWindowShape(win as unknown as BrowserWindow, 'linux')
    width = 1100; win.emit('resize')
    expect(win.setShape).toHaveBeenLastCalledWith(roundedWindowShape(1100, 600))
    maximized = true; win.emit('maximize')
    expect(win.setShape).toHaveBeenLastCalledWith([{ x: 0, y: 0, width: 1100, height: 600 }])
    maximized = false; win.emit('unmaximize')
    expect(win.setShape).toHaveBeenLastCalledWith(roundedWindowShape(1100, 600))
  })
  it('keeps the complete boundary across fullscreen resizing and restores rounded corners', () => {
    let fullScreen = false, width = 900, height = 600
    const win = Object.assign(new EventEmitter(), {
      isDestroyed: () => false, isFullScreen: () => fullScreen,
      isMaximized: () => false, getBounds: () => ({ width, height }), setShape: vi.fn()
    })
    attachLinuxWindowShape(win as unknown as BrowserWindow, 'linux')
    fullScreen = true; win.emit('enter-full-screen')
    width = 1920; height = 1080; win.emit('resize')
    expect(win.setShape).toHaveBeenLastCalledWith([{ x: 0, y: 0, width, height }])
    fullScreen = false; width = 900; height = 600; win.emit('leave-full-screen')
    expect(win.setShape).toHaveBeenLastCalledWith(roundedWindowShape(width, height))
  })
  it.each(['win32', 'darwin'] as const)('leaves %s native decoration unchanged', platform => {
    const setShape = vi.fn()
    attachLinuxWindowShape({ setShape } as unknown as BrowserWindow, platform)
    expect(setShape).not.toHaveBeenCalled()
  })
})
