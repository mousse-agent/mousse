import { afterEach, describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => ({
  setBadgeCount: vi.fn(),
  setOverlayIcon: vi.fn(),
  createFromBitmap: vi.fn(() => ({ kind: 'dot' }))
}))

vi.mock('electron', () => ({
  app: { setBadgeCount: electron.setBadgeCount },
  BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, setOverlayIcon: electron.setOverlayIcon }] },
  nativeImage: { createFromBitmap: electron.createFromBitmap }
}))

import { AttentionCounts, attentionDotBitmap, showAttentionCount } from '../src/main/attentionBadge'

const platform = process.platform
const onPlatform = (value: NodeJS.Platform) => Object.defineProperty(process, 'platform', { value, configurable: true })

afterEach(() => {
  onPlatform(platform)
  vi.clearAllMocks()
})

describe('AttentionCounts', () => {
  it('adds up the windows of different profiles', () => {
    const counts = new AttentionCounts()
    expect(counts.set(1, 'work', 2)).toBe(2)
    expect(counts.set(2, 'home', 1)).toBe(3)
  })

  it('counts a profile open in two windows once', () => {
    const counts = new AttentionCounts()
    counts.set(1, 'work', 2)
    expect(counts.set(2, 'work', 2)).toBe(2)
  })

  it('forgets a closed window and clears at zero', () => {
    const counts = new AttentionCounts()
    counts.set(1, 'work', 2)
    counts.set(2, 'home', 1)
    expect(counts.drop(1)).toBe(1)
    expect(counts.set(2, 'home', 0)).toBe(0)
    expect(counts.has(1)).toBe(false)
  })

  it('treats a negative or broken count as zero', () => {
    const counts = new AttentionCounts()
    expect(counts.set(1, 'work', -3)).toBe(0)
    expect(counts.set(1, 'work', Number.NaN)).toBe(0)
  })
})

describe('showAttentionCount', () => {
  it('sets the dock or launcher badge on macOS and Linux', () => {
    onPlatform('darwin')
    showAttentionCount(2)
    expect(electron.setBadgeCount).toHaveBeenCalledWith(2)
    onPlatform('linux')
    showAttentionCount(0)
    expect(electron.setBadgeCount).toHaveBeenLastCalledWith(0)
    expect(electron.setOverlayIcon).not.toHaveBeenCalled()
  })

  it('puts a dot over the taskbar button on Windows and takes it away at zero', () => {
    onPlatform('win32')
    showAttentionCount(3)
    expect(electron.setOverlayIcon).toHaveBeenCalledWith({ kind: 'dot' }, '3 threads need you')
    showAttentionCount(0)
    expect(electron.setOverlayIcon).toHaveBeenLastCalledWith(null, '')
    expect(electron.setBadgeCount).not.toHaveBeenCalled()
  })
})

describe('attentionDotBitmap', () => {
  it('draws an opaque centre and transparent corners', () => {
    const size = 16
    const pixels = attentionDotBitmap(size)
    expect(pixels.length).toBe(size * size * 4)
    const alphaAt = (x: number, y: number) => pixels[(y * size + x) * 4 + 3]
    expect(alphaAt(8, 8)).toBe(255)
    expect(alphaAt(0, 0)).toBe(0)
    expect(alphaAt(15, 15)).toBe(0)
  })
})
