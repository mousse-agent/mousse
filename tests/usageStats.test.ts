import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildUsageStatsSnapshot } from '../src/shared/lineEditStats'
import { LineEditStatsStore } from '../src/mms/stats/LineEditStatsStore'

const originalHome = process.env.MOUSSE_HOME
afterEach(() => {
  if (originalHome === undefined) delete process.env.MOUSSE_HOME
  else process.env.MOUSSE_HOME = originalHome
})

describe('usage analytics', () => {
  it('aggregates per-turn token categories, dimensions, days and cache ratio', () => {
    const snapshot = buildUsageStatsSnapshot([
      { timestamp: '2026-08-24T10:00:00Z', provider: 'anthropic', model: 'Sonnet', input: 60, output: 20, cacheRead: 40, cacheWrite: 5 },
      { timestamp: '2026-08-25T10:00:00Z', provider: 'openai', model: 'GPT', input: 40, output: 10, cacheRead: 0, cacheWrite: 0 }
    ])
    expect(snapshot.totals).toEqual({ input: 100, output: 30, cacheRead: 40, cacheWrite: 5, tokens: 175, cacheRatio: 40 / 140 })
    expect(snapshot.providers).toEqual(['anthropic', 'openai'])
    expect(snapshot.models).toEqual(['GPT', 'Sonnet'])
    expect(snapshot.days['2026-08-24']).toEqual({ input: 60, output: 20, cached: 45, tokens: 125 })
  })

  it('persists sanitized per-turn provider usage beside line edit history', () => {
    const home = mkdtempSync(join(tmpdir(), 'mousse-usage-'))
    process.env.MOUSSE_HOME = home
    try {
      const store = new LineEditStatsStore()
      const guiStore = new LineEditStatsStore()
      store.recordUsage({ timestamp: '2026-08-25T12:00:00.000Z', provider: 'openai', model: 'GPT', input: 12.4, output: 3, cacheRead: -2, cacheWrite: 1 })
      guiStore.record('manual', 7, new Date('2026-08-25T13:00:00.000Z'))
      const reloaded = new LineEditStatsStore().getUsageSnapshot()
      expect(reloaded.turns[0]).toMatchObject({ provider: 'openai', model: 'GPT', input: 12, output: 3, cacheRead: 0, cacheWrite: 1 })
      expect(JSON.parse(readFileSync(join(home, 'line-edits.json'), 'utf8')).turns).toHaveLength(1)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
