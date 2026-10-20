import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { MousseConfigStore } from '../src/mms/config/MousseConfigStore'
import { SettingsStore } from '../src/mms/settings/SettingsStore'
import { normalizeContextSettings, resolveContextCompactionTokens } from '../src/shared/settings'

describe('context compaction configuration', () => {
  it('defaults periodic maintenance to 128k and respects opt-out', () => {
    expect(normalizeContextSettings()).toEqual({ compactionEnabled: true, compactionTokens: 128000 })
    expect(normalizeContextSettings({ compactionEnabled: false }).compactionEnabled).toBe(false)
    expect(normalizeContextSettings({ compactionTokens: 123 as never }).compactionTokens).toBe(128000)
  })
  it('caps selected thresholds to model capacity', () => {
    expect(resolveContextCompactionTokens(1024000, 256000)).toBe(256000)
    expect(resolveContextCompactionTokens(128000, 272000)).toBe(128000)
    expect(resolveContextCompactionTokens('model-max', 272000)).toBe(272000)
  })
  it('persists the opt-out and threshold through configuration reload', () => {
    const home = mkdtempSync(join(tmpdir(), 'mousse-context-settings-'))
    try {
      const settings = new SettingsStore(MousseConfigStore.load(home))
      expect(settings.get().context.compactionTokens).toBe(128000)
      settings.set({ context: { compactionEnabled: false, compactionTokens: 512000 } })
      const reloaded = new SettingsStore(MousseConfigStore.load(home))
      expect(reloaded.get().context).toEqual({ compactionEnabled: false, compactionTokens: 512000 })
    } finally { rmSync(home, { recursive: true, force: true }) }
  })
})
