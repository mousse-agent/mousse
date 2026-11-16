import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MousseConfigStore } from '../src/mms/config/MousseConfigStore'
import { dispatchMethod, type HandlerContext } from '../src/mms/protocol/handlers'
import { SettingsStore } from '../src/mms/settings/SettingsStore'
import type { MousseSettingsUpdate } from '../src/shared/settings'

describe('General settings through the daemon protocol', () => {
  it('saves permission and run settings independently, notifies clients, and keeps them after reload', async () => {
    const home = mkdtempSync(join(tmpdir(), 'mousse-general-settings-'))
    try {
      const emitEvent = vi.fn()
      let settings = new SettingsStore(MousseConfigStore.load(home))
      const patches: MousseSettingsUpdate[] = [
        { permissions: { defaultMode: 'full' } },
        { runs: { resumeAfterUsageLimit: false } },
        { runs: { usageLimitPauseCap: 7 } }
      ]
      for (const partial of patches) {
        const ctx = { mms: { settings }, globalSequence: () => 1, emitEvent } as unknown as HandlerContext
        const result = await dispatchMethod(ctx, 'settings.set', { partial })
        expect(result).toEqual({ settings: settings.get() })
        expect(emitEvent).toHaveBeenLastCalledWith('settings.changed', { settings: settings.get() })
        settings = new SettingsStore(MousseConfigStore.load(home))
        expect(settings.get()).toMatchObject(partial)
      }
      expect(settings.get()).toMatchObject({
        permissions: { defaultMode: 'full' },
        runs: { resumeAfterUsageLimit: false, usageLimitPauseCap: 7 }
      })
      expect(emitEvent).toHaveBeenCalledTimes(3)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

it('validates quiet hours, preserves them on unrelated saves, and clears them across reload', () => {
  const home = mkdtempSync(join(tmpdir(), 'mousse-quiet-settings-'))
  try {
    let settings = new SettingsStore(MousseConfigStore.load(home))
    for (const quietHours of [{ from: '25:00', to: '08:00' }, { from: '22:00', to: '22:00' }, { from: '9:00', to: '10:00' }])
      expect(() => settings.set({ notifications: { quietHours } })).toThrow('HH:MM')
    settings.set({ notifications: { quietHours: { from: '22:00', to: '08:00' } } })
    settings.set({ notifications: { threadCompletionSound: false } })
    settings = new SettingsStore(MousseConfigStore.load(home))
    expect(settings.get().notifications.quietHours).toEqual({ from: '22:00', to: '08:00' })
    settings.set({ notifications: { quietHours: null } })
    settings = new SettingsStore(MousseConfigStore.load(home))
    expect(settings.get().notifications.quietHours).toBeUndefined()
  } finally { rmSync(home, { recursive: true, force: true }) }
})

it('treats an omitted or undefined quiet-hours key as no change, and only null clears it over JSON', () => {
  const home = mkdtempSync(join(tmpdir(), 'mousse-quiet-patch-'))
  try {
    const settings = new SettingsStore(MousseConfigStore.load(home))
    const range = { from: '22:00', to: '08:00' }
    settings.set({ notifications: { quietHours: range } })
    settings.set({ notifications: { quietHours: undefined, allRemoteThreads: true } })
    expect(settings.get().notifications.quietHours).toEqual(range)
    settings.set(JSON.parse(JSON.stringify({ notifications: { quietHours: null } })))
    settings.set({ notifications: { memoryNotices: false } })
    expect(settings.get().notifications.quietHours).toBeUndefined()
  } finally { rmSync(home, { recursive: true, force: true }) }
})
