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
