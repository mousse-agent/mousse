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

// Bot quiet hours were removed: what an older version stored, or an older window still sends, is ignored.
it('ignores bot quiet hours an older version stored or an older window sends', () => {
  const home = mkdtempSync(join(tmpdir(), 'mousse-quiet-settings-'))
  try {
    MousseConfigStore.load(home).applySettingsPatch({ notifications: { quietHours: { from: '22:00', to: '08:00' } } } as never)
    let settings = new SettingsStore(MousseConfigStore.load(home))
    expect(settings.get().notifications).not.toHaveProperty('quietHours')
    settings.set({ notifications: { quietHours: { from: '25:00', to: '08:00' }, memoryNotices: false } } as never)
    settings = new SettingsStore(MousseConfigStore.load(home))
    expect(settings.get().notifications.memoryNotices).toBe(false)
    expect(settings.get().notifications).not.toHaveProperty('quietHours')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

it('keeps Notify for bot threads off until it is turned on, and keeps it across a restart', () => {
  const home = mkdtempSync(join(tmpdir(), 'mousse-bot-threads-'))
  try {
    let settings = new SettingsStore(MousseConfigStore.load(home))
    expect(settings.get().notifications.botThreads === true).toBe(false)
    settings.set({ notifications: { botThreads: true } })
    settings = new SettingsStore(MousseConfigStore.load(home))
    expect(settings.get().notifications.botThreads).toBe(true)
    expect(settings.get().notifications.allRemoteThreads).toBe(false)
  } finally { rmSync(home, { recursive: true, force: true }) }
})
