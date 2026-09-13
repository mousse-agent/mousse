import { afterEach, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import type { SettingsStore } from '../src/mms/settings/SettingsStore'
import { getDefaultSettings } from '../src/shared/settings'
import { applyWindowMaterial, setWindowProfileSettings } from '../src/main/windowMaterial'

vi.mock('../src/main/windowsChrome', () => ({ reapplyWindowShadow: vi.fn() }))
afterEach(() => vi.restoreAllMocks())

it('preserves each window profile appearance through focus/resume refreshes', () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  const shared = getDefaultSettings()
  const personal = getDefaultSettings()
  shared.appearance.accentColor = '#a855f7'
  personal.appearance.accentColor = '#3b82f6'
  const store = { get: () => shared } as SettingsStore
  const windowA = { isDestroyed: () => false, setBackgroundColor: vi.fn(), setBackgroundMaterial: vi.fn() }
  const windowB = { isDestroyed: () => false, setBackgroundColor: vi.fn(), setBackgroundMaterial: vi.fn() }
  const a = windowA as unknown as BrowserWindow
  const b = windowB as unknown as BrowserWindow
  setWindowProfileSettings(b, personal)
  applyWindowMaterial(a, store)
  applyWindowMaterial(b, store)
  expect(windowA.setBackgroundColor.mock.calls[0]).not.toEqual(windowB.setBackgroundColor.mock.calls[0])
  applyWindowMaterial(b, store)
  expect(windowB.setBackgroundColor).toHaveBeenCalledTimes(1)
  setWindowProfileSettings(b, shared)
  applyWindowMaterial(b, store)
  expect(windowB.setBackgroundColor.mock.lastCall).toEqual(windowA.setBackgroundColor.mock.lastCall)
})
