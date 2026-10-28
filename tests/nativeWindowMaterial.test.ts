import type { BrowserWindow } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SettingsStore } from '../src/mms/settings/SettingsStore'
import { getDefaultSettings } from '../src/shared/settings'
import { applyWindowMaterial, MAC_VIBRANCY } from '../src/main/windowMaterial'
import { setLinuxBlurBehind } from '../src/main/linuxBlurBehind'

vi.mock('../src/main/windowsChrome', () => ({ reapplyWindowShadow: vi.fn() }))
vi.mock('../src/main/linuxBlurBehind', () => ({
  linuxUsesX11: (platform: string, env: NodeJS.ProcessEnv) => platform === 'linux' && Boolean(env.DISPLAY),
  setLinuxBlurBehind: vi.fn()
}))

const display = process.env.DISPLAY
afterEach(() => {
  vi.restoreAllMocks()
  vi.mocked(setLinuxBlurBehind).mockClear()
  if (display === undefined) delete process.env.DISPLAY
  else process.env.DISPLAY = display
})

function fakeWindow() {
  return {
    isDestroyed: () => false,
    setBackgroundColor: vi.fn(),
    setBackgroundMaterial: vi.fn(),
    setVibrancy: vi.fn()
  }
}

describe('native window material', () => {
  it('turns macOS vibrancy on and off with acrylic, over a clear background', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    const settings = getDefaultSettings()
    const store = { get: () => settings } as SettingsStore
    const win = fakeWindow()

    settings.appearance.acrylic = true
    expect(applyWindowMaterial(win as unknown as BrowserWindow, store)).toBe(true)
    expect(win.setVibrancy).toHaveBeenLastCalledWith(MAC_VIBRANCY)
    expect(win.setBackgroundColor.mock.lastCall![0]).toMatch(/^#00[0-9a-f]{6}$/)

    settings.appearance.acrylic = false
    expect(applyWindowMaterial(win as unknown as BrowserWindow, store)).toBe(true)
    expect(win.setVibrancy).toHaveBeenLastCalledWith(null)
    expect(win.setBackgroundColor.mock.lastCall![0]).toMatch(/^#[0-9a-f]{6}$/)

    // Focus churn re-applies nothing when the material is unchanged.
    applyWindowMaterial(win as unknown as BrowserWindow, store)
    expect(win.setVibrancy).toHaveBeenCalledTimes(2)
    expect(win.setBackgroundMaterial).not.toHaveBeenCalled()
  })

  it('asks KDE for blur behind on X11 and leaves other platforms alone', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    process.env.DISPLAY = ':0'
    const settings = getDefaultSettings()
    const store = { get: () => settings } as SettingsStore
    const win = fakeWindow()

    settings.appearance.acrylic = true
    applyWindowMaterial(win as unknown as BrowserWindow, store)
    expect(setLinuxBlurBehind).toHaveBeenLastCalledWith(win, true)
    settings.appearance.acrylic = false
    applyWindowMaterial(win as unknown as BrowserWindow, store)
    expect(setLinuxBlurBehind).toHaveBeenLastCalledWith(win, false)
    expect(win.setVibrancy).not.toHaveBeenCalled()

    delete process.env.DISPLAY
    vi.mocked(setLinuxBlurBehind).mockClear()
    settings.appearance.acrylic = true
    applyWindowMaterial(fakeWindow() as unknown as BrowserWindow, store)
    expect(setLinuxBlurBehind).not.toHaveBeenCalled()
  })
})
