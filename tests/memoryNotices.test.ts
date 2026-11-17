// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { normalizeProfilerSettings } from '../src/shared/diagnostics/profiler'
import { MEMORY_NOTICE_TEXT, memoryNoticesEnabled, openMemoryReport, presentMemoryNotice, type MemoryNoticeDeps } from '../src/renderer/hooks/useMemoryNotices'
import { openMemoryIssue } from '../src/main/diagnostics/memoryReport'
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
    expect(MEMORY_NOTICE_TEXT).toBe('High memory use')
    expect(toast.detail).toBe('Service 700 MB, above 600 MB for 15 min. Report opens a prefilled GitHub issue; nothing is sent until you submit.')
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

  it('notices show only while the profiler is on, and its notices switch is not off', () => {
    const profiler = normalizeProfilerSettings()
    const notifications = { threadCompletionSound: true, allRemoteThreads: false }
    expect(memoryNoticesEnabled(undefined)).toBe(false)
    expect(memoryNoticesEnabled({ experimental: {}, notifications })).toBe(false)
    expect(memoryNoticesEnabled({ experimental: { profiler }, notifications })).toBe(false)
    expect(memoryNoticesEnabled({ experimental: { profiler: { ...profiler, enabled: true } }, notifications })).toBe(true)
    expect(memoryNoticesEnabled({ experimental: { profiler: { ...profiler, enabled: true } }, notifications: { ...notifications, memoryNotices: false } })).toBe(false)
  })

  it('the Memory row tooltip lists the service counts', () => {
    const status: MemoryStatus = {
      sample: {
        t: 1, up: 60,
        service: { rss: 200, private: 180, heapUsed: 60, heapTotal: 80 },
        counts: { sqliteConnections: 3, workerThreads: 2, loadedThreads: 1, threadRuntimes: 2, threadCacheThreads: 1, threadCacheMb: 1, replayEvents: 9, ptys: 0, fileWatchers: 2, providerProcesses: 1, profiles: 1 },
        app: [{ kind: 'main', role: 'main', rss: 210, private: 150 }, { kind: 'renderer', role: 'window', rss: 400, private: 350, heapUsed: 90, heapTotal: 120 }],
        hints: { windows: [{ w: 1600, h: 1000, scale: 1, visible: true }], surfaceMb: 6.1, acrylic: false, views: { applet: 0, browser: 0, devtools: 0 }, webglContexts: 0, canvases: 0 }
      },
      detail: null, trend: [], growthMbPerHour: 2.5, breaches: [], notice: null, logFile: 'diagnostics/memory.jsonl'
    }
    expect(memoryBreakdown(status).split('\n')).toEqual([
      'Loaded threads 1, runtimes 2, SQLite 3, workers 2, terminals 0, providers 1',
      'Growth 2.5 MB/h',
      'Log: <Mousse home>/diagnostics/memory.jsonl'
    ])
  })
})

describe('Report', () => {
  const issue = { title: 'Memory report', body: 'Service 150 MB', url: 'https://github.com/mousse-agent/mousse/issues/new?title=x&body=y', complete: true }

  it('opens a complete link without touching the clipboard', async () => {
    const opened: string[] = []
    const copied: string[] = []
    const result = await openMemoryIssue(issue, { open: async (url) => { opened.push(url) }, copy: (text) => copied.push(text) })
    expect(result).toEqual({ ok: true, url: issue.url, copied: false, complete: true })
    expect(opened).toEqual([issue.url])
    expect(copied).toEqual([])
  })

  it('copies a report too long for the link, and one the browser would not open', async () => {
    const copied: string[] = []
    const long = await openMemoryIssue({ ...issue, complete: false }, { open: async () => {}, copy: (text) => copied.push(text) })
    expect(long).toMatchObject({ ok: true, copied: true, complete: false })
    const failed = await openMemoryIssue(issue, { open: async () => { throw new Error('no browser') }, copy: (text) => copied.push(text) })
    expect(failed).toMatchObject({ ok: false, copied: true })
    expect(copied).toEqual(['Service 150 MB', 'Service 150 MB'])
  })

  it('says so when the browser did not open, or the text went to the clipboard', async () => {
    const shown: string[] = []
    const show = (input: { message: string }) => { shown.push(input.message) }
    await openMemoryReport({ memoryReport: async () => ({ ok: false, copied: true, complete: true }) }, show)
    await openMemoryReport({ memoryReport: async () => ({ ok: true, copied: true, complete: false }) }, show)
    await openMemoryReport({ memoryReport: async () => ({ ok: true, copied: false, complete: true }) }, show)
    await openMemoryReport({ memoryReport: async () => { throw new Error('service gone') } }, show)
    expect(shown).toEqual([
      "Couldn't open the browser. The report is on your clipboard.",
      'Report copied. Paste it into the new issue.',
      "Couldn't make the memory report."
    ])
  })
})
