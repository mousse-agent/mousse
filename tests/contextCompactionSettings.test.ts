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
  resolveContextCompactionTokens,
  settingCompactionPoint,
  type ContextSettings
} from '../src/shared/settings'
import { shouldCompactNativeContext } from '../src/mms/orchestrator/nativeContext'

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
    expect(normalizeContextSettings()).toEqual({ compactionEnabled: true, compactionTokens: 'model-max', idleCompaction: 'suggest' })
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
  it('compacts a thread where its setting says, for any size', () => {
    const on = (compactionTokens: ContextSettings['compactionTokens']): ContextSettings => ({ compactionEnabled: true, compactionTokens })
    expect(settingCompactionPoint(on(300_000), 1_000_000)).toBe(300_000)
    expect(settingCompactionPoint(on(150_500), 1_000_000)).toBe(150_500)
    expect(settingCompactionPoint(on(300_000), 200_000)).toBe(183_616)
    // Before the window is known, a size is measured against itself.
    expect(settingCompactionPoint(on(300_000))).toBe(283_616)
    expect(settingCompactionPoint(on('model-max'), 1_000_000)).toBe(950_000)
    expect(settingCompactionPoint(on('model-max'))).toBeUndefined()
    expect(settingCompactionPoint({ compactionEnabled: false, compactionTokens: 300_000 }, 1_000_000)).toBeUndefined()
  })
  it('keeps the daemon compacting exactly where it did before the setting point was shared', () => {
    // The rule `prepareNativeContext` applied inline before it called `settingCompactionPoint`.
    const compactedBefore = (context: ContextSettings, activeTokens: number, knownLimit?: number) => {
      const threshold = typeof context.compactionTokens === 'number' ? context.compactionTokens : knownLimit
      return context.compactionEnabled && threshold !== undefined &&
        shouldCompactNativeContext(activeTokens, knownLimit ?? threshold, DEFAULT_COMPACTION_RESERVE_TOKENS, threshold)
    }
    const compactsNow = (context: ContextSettings, activeTokens: number, knownLimit?: number) => {
      const point = settingCompactionPoint(context, knownLimit)
      return point !== undefined && Number.isFinite(activeTokens) && activeTokens >= point
    }
    for (const compactionEnabled of [true, false])
      for (const compactionTokens of [32_000, 128_000, 300_000, 1_000_000, 2_000_000, 'model-max'] as const)
        for (const knownLimit of [undefined, 0, 32_768, 200_000, 272_000, 1_000_000]) {
          const context = { compactionEnabled, compactionTokens }
          const point = settingCompactionPoint(context, knownLimit) ?? 500_000
          for (const activeTokens of [0, point - 1, point, point + 1, 3_000_000, Number.NaN])
            expect(compactsNow(context, activeTokens, knownLimit), JSON.stringify({ context, knownLimit, activeTokens }))
              .toBe(compactedBefore(context, activeTokens, knownLimit))
        }
  })
  it('suggests compacting an idle thread unless that is turned off', () => {
    expect(normalizeContextSettings({ idleCompaction: 'off' }).idleCompaction).toBe('off')
    expect(normalizeContextSettings({ idleCompaction: 'suggest' }).idleCompaction).toBe('suggest')
    // An older file without it, or a value this build does not know (a later "prepare"): the default.
    for (const value of [undefined, null, 'prepare', 1, true])
      expect(normalizeContextSettings({ idleCompaction: value as never }).idleCompaction).toBe('suggest')
  })
  it('keeps the idle suggestion choice through configuration reload', () => withHome((home) => {
    const settings = new SettingsStore(MousseConfigStore.load(home))
    expect(settings.get().context.idleCompaction).toBe('suggest')
    settings.set({ context: { ...settings.get().context, idleCompaction: 'off' } })
    expect(new SettingsStore(MousseConfigStore.load(home)).get().context).toMatchObject({ idleCompaction: 'off', compactionTokens: 'model-max' })
  }))
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
    expect(reloaded.get().context).toEqual({ compactionEnabled: false, compactionTokens: 512000, idleCompaction: 'suggest' })
  }))
  it('moves the old stored 128k default to the model maximum once', () => withHome((home) => {
    writeStoredContext(home, { compactionEnabled: false, compactionTokens: 128000 })
    const settings = new SettingsStore(MousseConfigStore.load(home))
    expect(settings.get().context).toEqual({ compactionEnabled: false, compactionTokens: 'model-max', idleCompaction: 'suggest' })
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
