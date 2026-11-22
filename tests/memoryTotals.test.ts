import { describe, expect, it } from 'vitest'
import { memoryTable, memoryTotals, type MemorySample } from '../src/shared/diagnostics/memory'

const base: MemorySample = {
  t: 1, up: 1,
  service: { rss: 200, private: 100 }, workers: [50, 60],
  app: [{ kind: 'main', rss: 300, private: 120 }, { kind: 'gpu', rss: 400 }],
  children: [{ kind: 'codex', mb: 80 }],
  counts: { sqliteConnections: 0, workerThreads: 2, loadedThreads: 0, threadRuntimes: 0, threadCacheThreads: 0, threadCacheMb: 0, replayEvents: 0, ptys: 0, fileWatchers: 0, providerProcesses: 1, profiles: 1, activeTurns: 0 }
}

describe('resident memory totals', () => {
  it.each([
    ['all measured', {}, 980, 0],
    ['unreadable child', { children: [{ kind: 'codex', mb: null }] }, null, 1],
    ['footprint is not RSS', { children: [{ kind: 'codex', mb: 80, footprint: true }] }, null, 1],
    ['missing child row', { children: [] }, null, 1],
    ['missing child sample', { children: undefined }, null, 1],
    ['missing desktop', { app: undefined }, null, 0],
    ['no children running', { children: undefined, counts: { ...base.counts, providerProcesses: 0 } }, 900, 0]
  ] as const)('%s', (_name, patch, total, missing) => {
    const result = memoryTotals({ ...base, ...patch })
    expect(result.workloadWorkingSetMb).toBe(total)
    expect(result.unavailableChildren).toBe(missing)
    expect(result.serviceWorkingSetMb).toBe(200)
    expect(result.desktopWorkingSetMb).toBe('app' in patch ? null : 700)
  })

  it('separates footprints, working sets and failures in a mixed child sample', () => {
    const sample = { ...base, children: [{ kind: 'claude', mb: 50, footprint: true }, { kind: 'codex', mb: 80 }, { kind: 'mcp', mb: null }] }
    expect(memoryTotals(sample)).toMatchObject({ workloadWorkingSetMb: null, measuredWorkingSetMb: 980, unavailableChildren: 2 })
    const rows = memoryTable(sample)
    expect(rows.find((row) => row.label === 'Agents and tools (3)')).toMatchObject({ private: 50, rss: 80 })
    expect(rows.find((row) => row.label === 'Measured workload subtotal')).toMatchObject({ rss: 980, detail: expect.stringContaining('children without working sets: 2') })
  })
})
