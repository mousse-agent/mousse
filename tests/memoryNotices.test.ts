// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { MEMORY_NOTICE_TEXT, memoryNoticesEnabled, presentMemoryNotice, type MemoryNoticeDeps } from '../src/renderer/hooks/useMemoryNotices'
import { memoryBreakdown } from '../src/renderer/components/settings/MemoryRows'
import type { MemoryNotice, MemoryStatus } from '../src/shared/diagnostics/memory'

const NOTICE: MemoryNotice = { kind: 'service-high', summary: 'Service 700 MB, above 600 MB for 15 min', at: 1_000 }

function deps(): MemoryNoticeDeps & { show: ReturnType<typeof vi.fn>; shown: ReturnType<typeof vi.fn>; report: ReturnType<typeof vi.fn> } {
  return { show: vi.fn(), shown: vi.fn(), report: vi.fn() }
}

describe('memory notice', () => {
  it('shows one terse toast with Report and the details in its tooltip, and tells the service', () => {
    const d = deps()
    expect(presentMemoryNotice(NOTICE, true, new Set(), d)).toBe(true)
    const toast = d.show.mock.calls[0][0]
    expect(toast).toMatchObject({ message: MEMORY_NOTICE_TEXT, key: 'memory-notice', action: { label: 'Report' } })
    expect(toast.title).toBeUndefined()
    expect(toast.detail).toContain('Service 700 MB')
    expect(d.shown).toHaveBeenCalledWith('service-high')
    toast.action.run()
    expect(d.report).toHaveBeenCalledTimes(1)
  })

  it('shows nothing when the notices are off, and leaves the day allowance unused', () => {
    const d = deps()
    expect(presentMemoryNotice(NOTICE, false, new Set(), d)).toBe(false)
    expect(d.show).not.toHaveBeenCalled()
    expect(d.shown).not.toHaveBeenCalled()
  })

  it('a window shows the same notice once, from the event and the start-up read', () => {
    const d = deps()
    const seen = new Set<string>()
    presentMemoryNotice(NOTICE, true, seen, d)
    presentMemoryNotice({ ...NOTICE }, true, seen, d)
    expect(d.show).toHaveBeenCalledTimes(1)
    presentMemoryNotice({ ...NOTICE, kind: 'service-growth', at: 2_000 }, true, seen, d)
    expect(d.show).toHaveBeenCalledTimes(2)
  })

  it('the setting is on unless turned off', () => {
    expect(memoryNoticesEnabled(undefined)).toBe(true)
    expect(memoryNoticesEnabled({ notifications: { threadCompletionSound: true, allRemoteThreads: false } })).toBe(true)
    expect(memoryNoticesEnabled({ notifications: { threadCompletionSound: true, allRemoteThreads: false, memoryNotices: false } })).toBe(false)
  })

  it('the About row tooltip lists each process and the counts', () => {
    const status: MemoryStatus = {
      sample: {
        t: 1, up: 60,
        service: { rss: 200, private: 180, heapUsed: 60, heapTotal: 80 },
        counts: { sqliteConnections: 3, workerThreads: 2, loadedThreads: 1, threadRuntimes: 2, threadCacheThreads: 1, threadCacheMb: 1, replayEvents: 9, ptys: 0, fileWatchers: 2, providerProcesses: 1, profiles: 1 },
        app: [{ kind: 'main', rss: 210, private: 150 }, { kind: 'window', rss: 400, private: 350, heapUsed: 90, heapTotal: 120 }]
      },
      detail: null, trend: [], growthMbPerHour: 2.5, breaches: [], notice: null, logFile: 'diagnostics/memory.jsonl'
    }
    expect(memoryBreakdown(status).split('\n')).toEqual([
      'Service: 180 MB, heap 60/80',
      'App main: 150 MB',
      'Window 1: 350 MB, heap 90/120',
      'Loaded threads 1, runtimes 2, SQLite 3, workers 2, terminals 0, providers 1',
      'Growth 2.5 MB/h',
      'Log: <Mousse home>/diagnostics/memory.jsonl'
    ])
  })
})
