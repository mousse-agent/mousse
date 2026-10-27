import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MousseConfigStore } from '../src/mms/config/MousseConfigStore'
import { SettingsStore } from '../src/mms/settings/SettingsStore'
import { DEFAULT_USAGE_LIMIT_PAUSE_CAP, getDefaultSettings, normalizeRunSettings } from '../src/shared/settings'

describe('the run settings after a usage limit', () => {
  let originalHome: string | undefined
  let tempHome: string

  beforeEach(() => {
    originalHome = process.env.MOUSSE_HOME
    tempHome = mkdtempSync(join(tmpdir(), 'mousse-run-settings-'))
    process.env.MOUSSE_HOME = tempHome
  })

  afterEach(() => {
    if (originalHome === undefined) delete process.env.MOUSSE_HOME
    else process.env.MOUSSE_HOME = originalHome
    rmSync(tempHome, { recursive: true, force: true })
  })

  it('default to off with a cap of three, and a cap that is not a small whole number falls back to it', () => {
    expect(getDefaultSettings().runs).toEqual({ resumeAfterUsageLimit: false, usageLimitPauseCap: 3 })
    expect(new SettingsStore(MousseConfigStore.load(tempHome)).get().runs).toEqual({ resumeAfterUsageLimit: false, usageLimitPauseCap: DEFAULT_USAGE_LIMIT_PAUSE_CAP })
    for (const cap of [0, -1, 2.5, 11, '3', null, Number.NaN, Infinity]) expect(normalizeRunSettings({ usageLimitPauseCap: cap as never }).usageLimitPauseCap).toBe(3)
    // Only an explicit `true` turns it on.
    for (const value of ['yes', 1, null]) expect(normalizeRunSettings({ resumeAfterUsageLimit: value as never }).resumeAfterUsageLimit).toBe(false)
    expect(normalizeRunSettings({ resumeAfterUsageLimit: true, usageLimitPauseCap: 5 })).toEqual({ resumeAfterUsageLimit: true, usageLimitPauseCap: 5 })
  })

  it('persist in mousse.conf and survive a reload', () => {
    const settings = new SettingsStore(MousseConfigStore.load(tempHome))
    settings.set({ runs: { resumeAfterUsageLimit: true, usageLimitPauseCap: 5 } })

    const reloaded = new SettingsStore(MousseConfigStore.load(tempHome))
    expect(reloaded.get().runs).toEqual({ resumeAfterUsageLimit: true, usageLimitPauseCap: 5 })
    // Another section's change leaves them alone.
    reloaded.set({ notifications: { threadCompletionSound: false } })
    expect(new SettingsStore(MousseConfigStore.load(tempHome)).get().runs).toEqual({ resumeAfterUsageLimit: true, usageLimitPauseCap: 5 })
  })
})
