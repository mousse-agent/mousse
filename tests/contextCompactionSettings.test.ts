import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { MousseConfigStore } from '../src/mms/config/MousseConfigStore'
import { SettingsStore } from '../src/mms/settings/SettingsStore'
import { normalizeContextSettings, resolveContextCompactionTokens } from '../src/shared/settings'

function withHome(run: (home: string) => void): void {
  const home = mkdtempSync(join(tmpdir(), 'mousse-context-settings-'))
  try { run(home) } finally { rmSync(home, { recursive: true, force: true }) }
}

/** A mousse.conf written by an earlier build, with the given stored context section. */
function writeStoredContext(home: string, context: Record<string, unknown>): void {
  writeFileSync(join(home, 'mousse.conf'), JSON.stringify({ version: 1, settings: { context } }), 'utf-8')
}

describe('context compaction configuration', () => {
  it('defaults to the model maximum and respects opt-out', () => {
    expect(normalizeContextSettings()).toEqual({ compactionEnabled: true, compactionTokens: 'model-max' })
    expect(normalizeContextSettings({ compactionEnabled: false }).compactionEnabled).toBe(false)
    expect(normalizeContextSettings({ compactionTokens: 123 as never }).compactionTokens).toBe('model-max')
  })
  it('caps selected thresholds to model capacity', () => {
    expect(resolveContextCompactionTokens(1024000, 256000)).toBe(256000)
    expect(resolveContextCompactionTokens(128000, 272000)).toBe(128000)
    expect(resolveContextCompactionTokens('model-max', 272000)).toBe(272000)
  })
  it('persists the opt-out and threshold through configuration reload', () => withHome((home) => {
    const settings = new SettingsStore(MousseConfigStore.load(home))
    expect(settings.get().context.compactionTokens).toBe('model-max')
    settings.set({ context: { compactionEnabled: false, compactionTokens: 512000 } })
    const reloaded = new SettingsStore(MousseConfigStore.load(home))
    expect(reloaded.get().context).toEqual({ compactionEnabled: false, compactionTokens: 512000 })
  }))
  it('moves the old stored 128k default to the model maximum once', () => withHome((home) => {
    writeStoredContext(home, { compactionEnabled: false, compactionTokens: 128000 })
    const settings = new SettingsStore(MousseConfigStore.load(home))
    expect(settings.get().context).toEqual({ compactionEnabled: false, compactionTokens: 'model-max' })
    // 128k chosen after the move stays chosen.
    settings.set({ context: { compactionEnabled: true, compactionTokens: 128000 } })
    expect(new SettingsStore(MousseConfigStore.load(home)).get().context.compactionTokens).toBe(128000)
  }))
  it('keeps any other stored size', () => withHome((home) => {
    writeStoredContext(home, { compactionEnabled: true, compactionTokens: 512000 })
    expect(new SettingsStore(MousseConfigStore.load(home)).get().context.compactionTokens).toBe(512000)
  }))
})
