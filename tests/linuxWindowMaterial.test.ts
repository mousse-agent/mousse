import type { BrowserWindow } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../src/shared/settings'
import type { SettingsStore } from '../src/mms/settings/SettingsStore'
import { applyWindowMaterial, setWindowProfileSettings } from '../src/main/windowMaterial'

vi.mock('../src/main/windowsChrome', () => ({ reapplyWindowShadow: vi.fn() }))

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
afterEach(() => Object.defineProperty(process, 'platform', platform))

describe('Linux acrylic background synchronization', () => {
  it('clears with alpha for acrylic and opaque color for solid mode without Windows material calls', () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    const settings = getDefaultSettings()
    const store = { get: () => settings } as SettingsStore
    const setBackgroundColor = vi.fn()
    const setBackgroundMaterial = vi.fn()
    const win = { isDestroyed: () => false, setBackgroundColor, setBackgroundMaterial } as unknown as BrowserWindow
    expect(applyWindowMaterial(win, store)).toBe(true)
    expect(setBackgroundColor.mock.calls[0][0]).toMatch(/^#00[0-9a-f]{6}$/)
    settings.appearance.acrylic = false
    expect(applyWindowMaterial(win, store)).toBe(true)
    expect(setBackgroundColor.mock.calls[1][0]).toMatch(/^#[0-9a-f]{6}$/)
    expect(setBackgroundMaterial).not.toHaveBeenCalled()
    expect(applyWindowMaterial(win, store)).toBe(true)
    expect(setBackgroundColor).toHaveBeenCalledTimes(2)
  })

  it('keeps a window on its bound profile appearance during focus refresh', () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    const settings = getDefaultSettings()
    const profile = getDefaultSettings()
    profile.appearance.acrylic = false
    const setBackgroundColor = vi.fn()
    const win = { isDestroyed: () => false, setBackgroundColor } as unknown as BrowserWindow
    setWindowProfileSettings(win, profile)
    expect(applyWindowMaterial(win, { get: () => settings } as SettingsStore)).toBe(true)
    expect(setBackgroundColor.mock.calls[0][0]).toMatch(/^#[0-9a-f]{6}$/)
  })
})
