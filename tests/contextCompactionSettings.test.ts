import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { MousseConfigStore } from '../src/mms/config/MousseConfigStore'
import { SettingsStore } from '../src/mms/settings/SettingsStore'
import {
  contextCompactionPoint,
  DEFAULT_COMPACTION_RESERVE_TOKENS,
  formatContextCompactionSize,
  normalizeContextSettings,
  parseContextCompactionSize,
  resolveContextCompactionTokens
} from '../src/shared/settings'

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
  it('keeps any whole size from 32k to 2M and drops the rest', () => {
    for (const size of [32_000, 300_000, 384_000, 1_024_000, 2_000_000])
      expect(normalizeContextSettings({ compactionTokens: size }).compactionTokens).toBe(size)
    for (const size of [31_999, 2_000_001, 300_000.5, Number.NaN, Infinity, -128_000, '300000'])
      expect(normalizeContextSettings({ compactionTokens: size as never }).compactionTokens).toBe('model-max')
  })
  it('reads a typed size', () => {
    expect(parseContextCompactionSize('300k')).toBe(300_000)
    expect(parseContextCompactionSize('300000')).toBe(300_000)
    expect(parseContextCompactionSize('300,000')).toBe(300_000)
    expect(parseContextCompactionSize(' 0.3 M ')).toBe(300_000)
    expect(parseContextCompactionSize('1m')).toBe(1_000_000)
    expect(parseContextCompactionSize('300K tokens')).toBe(300_000)
    expect(parseContextCompactionSize('32k')).toBe(32_000)
    expect(parseContextCompactionSize('2M')).toBe(2_000_000)
    for (const text of ['', 'abc', '31k', '2.1m', '300.5', '1.0000005m', '-300k', '300kk', '3e5'])
      expect(parseContextCompactionSize(text)).toBeUndefined()
  })
  it('writes a size the way it is typed', () => {
    expect(formatContextCompactionSize(300_000)).toBe('300k')
    expect(formatContextCompactionSize(1_000_000)).toBe('1M')
    expect(formatContextCompactionSize(1_500_000)).toBe('1.5M')
    expect(formatContextCompactionSize(1_024_000)).toBe('1024k')
    expect(formatContextCompactionSize(300_500)).toBe('300,500')
  })
  it('compacts where the daemon does: the size, else the window less its reserve', () => {
    expect(contextCompactionPoint(1_000_000, 300_000)).toBe(300_000)
    expect(contextCompactionPoint(1_000_000)).toBe(950_000)
    expect(contextCompactionPoint(200_000, 300_000)).toBe(200_000 - DEFAULT_COMPACTION_RESERVE_TOKENS)
    expect(contextCompactionPoint(0, 300_000)).toBe(Infinity)
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
  it('keeps a typed size through reload, and falls back from one out of range', () => withHome((home) => {
    const settings = new SettingsStore(MousseConfigStore.load(home))
    settings.set({ context: { compactionEnabled: true, compactionTokens: 300_000 } })
    expect(new SettingsStore(MousseConfigStore.load(home)).get().context.compactionTokens).toBe(300_000)
    settings.set({ context: { compactionEnabled: true, compactionTokens: 5_000_000 } })
    expect(new SettingsStore(MousseConfigStore.load(home)).get().context.compactionTokens).toBe('model-max')
  }))
})
