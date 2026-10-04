import { EventEmitter } from 'node:events'
import type { BrowserWindow } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { LinuxWindowResizeController } from '../src/main/linuxWindowResize'

function windowFixture() {
  const window = Object.assign(new EventEmitter(), {
    webContents: new EventEmitter(),
    getBounds: () => ({ x: 200, y: 100, width: 1000, height: 700 }),
    getMinimumSize: () => [900, 600], getMaximumSize: () => [0, 0],
    isDestroyed: () => false, isResizable: () => true, isMaximized: () => false, isFullScreen: () => false,
    setBounds: vi.fn()
  })
  return { window, win: window as unknown as BrowserWindow }
}

describe('Linux transparent window resizing', () => {
  it.each([
    ['n', { x: 200, y: 150, width: 1000, height: 650 }],
    ['ne', { x: 200, y: 150, width: 1080, height: 650 }],
    ['e', { x: 200, y: 100, width: 1080, height: 700 }],
    ['se', { x: 200, y: 100, width: 1080, height: 750 }],
    ['s', { x: 200, y: 100, width: 1000, height: 750 }],
    ['sw', { x: 280, y: 100, width: 920, height: 750 }],
    ['w', { x: 280, y: 100, width: 920, height: 700 }],
    ['nw', { x: 280, y: 150, width: 920, height: 650 }]
  ])('moves %s while anchoring the opposite edges', (edge, bounds) => {
    const { window, win } = windowFixture()
    let cursor = { x: 500, y: 300 }
    const resize = new LinuxWindowResizeController(() => cursor, 'linux')
    expect(resize.begin(win, edge, 1)).toBe(true)
    cursor = { x: 580, y: 350 }; resize.move(win, 1)
    expect(window.setBounds).toHaveBeenLastCalledWith(bounds, false)
    // Bounds and origin stay locked at gesture admission rather than accumulating.
    resize.move(win, 1)
    expect(window.setBounds).toHaveBeenLastCalledWith(bounds, false)
  })
  it('clamps west/north edges at minimum and maximum sizes without shifting their anchors', () => {
    const { window, win } = windowFixture()
    window.getMaximumSize = () => [1200, 900]
    let cursor = { x: 500, y: 300 }
    const resize = new LinuxWindowResizeController(() => cursor, 'linux')
    resize.begin(win, 'nw', 1)
    cursor = { x: 1500, y: 1300 }; resize.move(win, 1)
    expect(window.setBounds).toHaveBeenLastCalledWith({ x: 300, y: 200, width: 900, height: 600 }, false)
    cursor = { x: -500, y: -700 }; resize.end(win, 1)
    expect(window.setBounds).toHaveBeenLastCalledWith({ x: 0, y: -100, width: 1200, height: 900 }, false)
    window.setBounds.mockClear(); resize.move(win, 1); expect(window.setBounds).not.toHaveBeenCalled()
  })
  it('keeps the main and auxiliary window gestures independent and rejects mismatched pointers', () => {
    const main = windowFixture(), auxiliary = windowFixture()
    let cursor = { x: 500, y: 300 }
    const resize = new LinuxWindowResizeController(() => cursor, 'linux')
    resize.begin(main.win, 'e', 1); resize.begin(auxiliary.win, 's', 2)
    cursor = { x: 520, y: 320 }
    resize.end(main.win, 2); resize.move(main.win, 2)
    expect(main.window.setBounds).not.toHaveBeenCalled()
    resize.move(main.win, 1); resize.move(auxiliary.win, 2)
    expect(main.window.setBounds).toHaveBeenLastCalledWith({ x: 200, y: 100, width: 1020, height: 700 }, false)
    expect(auxiliary.window.setBounds).toHaveBeenLastCalledWith({ x: 200, y: 100, width: 1000, height: 720 }, false)
  })
  it.each(['blur', 'closed', 'maximize', 'enter-full-screen', 'reload'])('cancels an admitted gesture on %s', (event) => {
    const { window, win } = windowFixture()
    const resize = new LinuxWindowResizeController(() => ({ x: 500, y: 300 }), 'linux')
    resize.begin(win, 'e', 1)
    if (event === 'reload') window.webContents.emit('did-start-loading')
    else window.emit(event)
    resize.move(win, 1); expect(window.setBounds).not.toHaveBeenCalled()
  })
  it('rejects invalid edges and pointers, maximized/fullscreen/fixed windows and other platforms', () => {
    const { window, win } = windowFixture()
    const resize = new LinuxWindowResizeController(() => ({ x: 500, y: 300 }), 'linux')
    expect(resize.begin(win, 'invalid', 1)).toBe(false)
    expect(resize.begin(win, 'e', NaN)).toBe(false)
    expect(resize.begin(win, 'e', -1)).toBe(false)
    window.isMaximized = () => true; expect(resize.begin(win, 'e', 1)).toBe(false)
    window.isMaximized = () => false; window.isFullScreen = () => true; expect(resize.begin(win, 'e', 1)).toBe(false)
    window.isFullScreen = () => false; window.isResizable = () => false; expect(resize.begin(win, 'e', 1)).toBe(false)
    window.isResizable = () => true
    for (const platform of ['win32', 'darwin'] as const) expect(new LinuxWindowResizeController(() => ({ x: 500, y: 300 }), platform).begin(win, 'e', 1)).toBe(false)
    expect(window.setBounds).not.toHaveBeenCalled()
  })
})
