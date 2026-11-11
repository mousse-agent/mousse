import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MemoryMonitor, type ServiceCountsReading } from '../src/mms/diagnostics/MemoryMonitor'
import { MemoryLog, pruneMemoryLog, readMemoryLog, samplesOf } from '../src/mms/diagnostics/memoryLog'
import { readHeapDetail, sampleOwnProcess } from '../src/mms/diagnostics/processMemory'
import { childKindOf, liveChildProcesses, liveFileWatchers, resetLiveCounts, trackChildProcess, trackFileWatcher } from '../src/mms/diagnostics/liveCounts'
import { readServiceCounts } from '../src/mms/diagnostics/startMemoryMonitor'
import { validateAppReport } from '../src/mms/diagnostics/memoryDomain'
import { summarizeMemoryLog } from '../src/cli/commands/diagnostics'
import { resolveMemoryThresholds, type MemoryNotice } from '../src/shared/diagnostics/memory'
import type { MmsProfileServices } from '../src/mms/MmsProfileServices'

const MIN = 60_000
const T0 = Date.UTC(2026, 10, 11, 8, 0, 0)
const homes: string[] = []

function home(name = 'alice'): string {
  // A home whose path holds a username, to prove none of it reaches the log or the report.
  const dir = mkdtempSync(join(tmpdir(), `mousse-mem-${name}-`))
  homes.push(dir)
  return dir
}

afterEach(() => {
  resetLiveCounts()
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const READING: ServiceCountsReading = {
  counts: { sqliteConnections: 2, workerThreads: 2, loadedThreads: 1, threadRuntimes: 1, threadCacheThreads: 1, threadCacheMb: 0.5, replayEvents: 12, ptys: 0, fileWatchers: 1, profiles: 1 },
  workerHeaps: [4 * 1024 * 1024]
}

function monitorAt(dir: string, opts: { mb: () => number; now: { t: number }; notices?: MemoryNotice[]; thresholds?: string; snapshots?: string[] }) {
  return new MemoryMonitor({
    homeDir: dir,
    version: '0.1.3',
    thresholds: resolveMemoryThresholds(opts.thresholds ?? '{"serviceSustainMinutes":3,"servicePrivateMb":500,"serviceSevereMb":900}'),
    readCounts: async () => READING,
    readReplayBytes: () => 2 * 1024 * 1024,
    onNotice: (notice) => opts.notices?.push(notice),
    now: () => opts.now.t,
    uptime: () => (opts.now.t - T0) / 1000 + 100,
    sampleProcess: async () => ({ rss: opts.mb() + 40, private: opts.mb(), heapUsed: 60, heapTotal: 80, external: 4, arrayBuffers: 1 }),
    readDetail: () => ({ heapSpaces: { old_space: 50 }, heap: { totalHeapSize: 80, usedHeapSize: 60, heapSizeLimit: 4096, mallocedMemory: 1, externalMemory: 4, nativeContexts: 1, detachedContexts: 0 } }),
    readChildren: async () => [{ kind: 'claude', mb: 210 }],
    childCount: () => 1,
    writeHeapSnapshot: opts.snapshots ? (file) => { opts.snapshots!.push(file); writeFileSync(file, '{}'); return file } : null,
    log: new MemoryLog(dir, { flushIntervalMs: 1 })
  })
}

async function run(monitor: MemoryMonitor, now: { t: number }, minutes: number): Promise<void> {
  for (let i = 0; i < minutes; i++) {
    await monitor.tick()
    now.t += MIN
  }
}

describe('process sampler', () => {
  it('reads real numbers for this process', async () => {
    const sample = await sampleOwnProcess()
    expect(sample.rss).toBeGreaterThan(10)
    expect(sample.heapUsed).toBeGreaterThan(1)
    expect(sample.heapTotal!).toBeGreaterThanOrEqual(sample.heapUsed!)
    expect(sample.rss).toBeGreaterThan(sample.heapUsed!)
    for (const value of Object.values(sample)) expect(Number.isFinite(value)).toBe(true)
    const detail = readHeapDetail()
    expect(Object.keys(detail.heapSpaces)).toContain('old_space')
    expect(detail.heap.heapSizeLimit).toBeGreaterThan(detail.heap.usedHeapSize)
  })

  it('counts file watchers until they close, and child processes until they exit', () => {
    const watcher = Object.assign(new EventEmitter(), { close() { this.emit('close') } })
    trackFileWatcher(watcher as never)
    expect(liveFileWatchers()).toBe(1)
    watcher.close()
    watcher.close()
    expect(liveFileWatchers()).toBe(0)

    const child = Object.assign(new EventEmitter(), { pid: process.pid })
    trackChildProcess(child, 'claude')
    expect(liveChildProcesses()).toEqual([{ pid: process.pid, kind: 'claude' }])
    child.emit('exit')
    expect(liveChildProcesses()).toEqual([])
    // A pid alone is dropped once nothing runs under it.
    trackChildProcess(2 ** 22 + 12345, 'codex')
    expect(liveChildProcesses()).toEqual([])
    expect(childKindOf('C:\\Users\\alice\\AppData\\claude.exe')).toBe('claude')
    expect(childKindOf('/usr/bin/codex')).toBe('codex')
    expect(childKindOf('/home/alice/my-tool')).toBe('provider')
  })

  it('sums the counts over every profile, without reading any thread', async () => {
    const profile = (sessions: number, ptys: number) => ({
      orchestrator: { loadedSessionCount: () => sessions },
      threadRuntimes: { runtimeCount: () => sessions + 1 },
      threads: { threadDbCacheStats: () => ({ threads: sessions, bytes: sessions * 1024 * 1024, coldLoads: 0, stateReads: 0 }), listAllThreads: () => { throw new Error('read a thread') } },
      ptyManager: { list: () => Array.from({ length: ptys }) }
    }) as unknown as MmsProfileServices
    const reading = await readServiceCounts([profile(2, 1), profile(3, 0)], () => 77)
    expect(reading.counts).toMatchObject({ loadedThreads: 5, threadRuntimes: 7, threadCacheThreads: 5, threadCacheMb: 5, ptys: 1, replayEvents: 77, profiles: 2 })
  })
})

describe('memory monitor', () => {
  it('logs one line of numbers a minute, and only numbers', async () => {
    const dir = home()
    const now = { t: T0 }
    const monitor = monitorAt(dir, { mb: () => 150, now })
    await run(monitor, now, 6)
    monitor.stop()
    const lines = readMemoryLog(join(dir, 'diagnostics', 'memory.jsonl'))
    const samples = samplesOf(lines)
    expect(samples).toHaveLength(6)
    expect(samples[0]).toMatchObject({ t: T0, service: { private: 150, rss: 190 }, counts: { loadedThreads: 1, providerProcesses: 1 }, workers: [4], replayMb: 2, children: [{ kind: 'claude', mb: 210 }] })
    // Children and the replay size every fifth sample only.
    expect(samples[1].children).toBeUndefined()
    expect(samples[5].children).toBeDefined()
    const text = readFileSync(join(dir, 'diagnostics', 'memory.jsonl'), 'utf8')
    expect(text).not.toContain('alice')
    expect(text).not.toContain(dir)
    expect(monitor.status()).toMatchObject({ breaches: [], notice: null, logFile: 'diagnostics/memory.jsonl' })
  })

  it('logs the full breakdown on a breach, notices once a day per kind, and remembers it across restarts', async () => {
    const dir = home()
    const now = { t: T0 }
    let mb = 150
    const notices: MemoryNotice[] = []
    const monitor = monitorAt(dir, { mb: () => mb, now, notices })
    await run(monitor, now, 3)
    mb = 600
    await run(monitor, now, 3)
    // A spike does not count: three minutes are needed.
    expect(notices).toEqual([])
    await run(monitor, now, 2)
    expect(notices.map((n) => n.kind)).toEqual(['service-high'])
    expect(monitor.status().notice?.kind).toBe('service-high')
    await monitor.flush()
    const breach = readMemoryLog(join(dir, 'diagnostics', 'memory.jsonl')).find((line) => line.type === 'breach')
    expect(breach).toMatchObject({ type: 'breach', breaches: [{ kind: 'service-high' }], detail: { heapSpaces: { old_space: 50 } }, sample: { children: [{ kind: 'claude' }] } })

    // Still high: no second notice while the first waits, and none after it was shown.
    await run(monitor, now, 5)
    expect(notices).toHaveLength(1)
    monitor.noticeShown('service-high')
    expect(monitor.status().notice).toBeNull()
    mb = 150
    await run(monitor, now, 5)
    mb = 600
    await run(monitor, now, 10)
    expect(notices).toHaveLength(1)
    monitor.stop()

    // A new service run the same day still remembers the notice was shown.
    const notices2: MemoryNotice[] = []
    const again = monitorAt(dir, { mb: () => 600, now, notices: notices2 })
    await run(again, now, 5)
    expect(notices2).toEqual([])
    // A day later it may show again.
    now.t += 24 * 60 * MIN
    await run(again, now, 5)
    expect(notices2.map((n) => n.kind)).toEqual(['service-high'])
    again.stop()
  })

  it('writes one heap snapshot a day, only when severe', async () => {
    const dir = home()
    const now = { t: T0 }
    let mb = 600
    const snapshots: string[] = []
    const monitor = monitorAt(dir, { mb: () => mb, now, snapshots })
    await run(monitor, now, 6)
    expect(snapshots).toEqual([])
    mb = 1_000
    await run(monitor, now, 10)
    expect(snapshots).toHaveLength(1)
    expect(readdirSync(join(dir, 'diagnostics')).filter((name) => name.endsWith('.heapsnapshot'))).toHaveLength(1)
    await monitor.flush()
    const line = readMemoryLog(join(dir, 'diagnostics', 'memory.jsonl')).find((entry) => entry.type === 'heap-snapshot')
    expect(line).toMatchObject({ kind: 'service-high', file: expect.stringMatching(/^diagnostics\/heap-.*\.heapsnapshot$/) })
    monitor.stop()
  })

  it('builds an issue with no home path, username or thread title', async () => {
    const dir = home('bob')
    const now = { t: T0 }
    const monitor = monitorAt(dir, { mb: () => 600, now })
    await run(monitor, now, 5)
    monitor.acceptAppReport('c1', [
      { kind: 'main', role: 'main', rss: 200, private: 150 },
      { kind: 'renderer', role: 'window', rss: 500, private: 420, heapUsed: 90, heapTotal: 120 },
      { kind: 'gpu', role: 'gpu', rss: 400, private: 334, cpu: 2 }
    ], { windows: [{ w: 1200, h: 800, scale: 2, visible: true }], surfaceMb: 14.6, acrylic: false, views: { applet: 1, browser: 0, devtools: 0 }, webglContexts: 2, canvases: 2 })
    await run(monitor, now, 1)
    const issue = await monitor.issue()
    monitor.stop()
    const everything = `${issue.title}\n${issue.body}\n${decodeURIComponent(issue.url)}`
    expect(issue.title).toContain('Service 600 MB')
    expect(issue.body).toContain('| Window | 420 | 500 | - | 90 | 120 |')
    expect(issue.body).toContain('| GPU | 334 | 400 | 2 | - | - |')
    expect(issue.body).toContain('WebGL contexts 2')
    expect(monitor.status().sample?.hints?.surfaceMb).toBe(14.6)
    for (const personal of [dir, 'bob', 'Fix the login page', 'mousse-agent/secret-project', process.env.USERNAME, process.env.USER]) {
      if (personal) expect(everything).not.toContain(personal)
    }
  })

  it('drops an app report that stopped arriving', async () => {
    const dir = home()
    const now = { t: T0 }
    const monitor = monitorAt(dir, { mb: () => 150, now })
    monitor.acceptAppReport('c1', [{ kind: 'main', rss: 200 }])
    await run(monitor, now, 1)
    expect(monitor.status().sample?.app).toHaveLength(1)
    await run(monitor, now, 4)
    expect(monitor.status().sample?.app).toBeUndefined()
    monitor.stop()
  })

  it('takes only known process kinds, roles and numbers from the app', () => {
    expect(validateAppReport({ processes: [{ kind: 'renderer', role: 'applet', rss: 12.34, private: 10, cpu: 0.25 }] }))
      .toEqual({ processes: [{ kind: 'renderer', role: 'applet', rss: 12.3, private: 10, cpu: 0.3 }] })
    expect(() => validateAppReport({ processes: [{ kind: 'renderer', rss: 1, title: 'My thread' }] })).toThrow(/Unexpected field/)
    expect(() => validateAppReport({ processes: [{ kind: 'C:/x', rss: 1 }] })).toThrow(/Unknown process kind/)
    expect(() => validateAppReport({ processes: [{ kind: 'renderer', role: 'https://example.com', rss: 1 }] })).toThrow(/Unknown process role/)
    expect(() => validateAppReport({ processes: [{ kind: 'main', rss: '1' }] })).toThrow()
    const hints = { windows: [{ w: 800, h: 600, scale: 1.25, visible: false }], surfaceMb: 0, acrylic: true, views: { applet: 0, browser: 1, devtools: 0 }, webglContexts: 0, canvases: 1 }
    expect(validateAppReport({ processes: [], hints }).hints).toEqual(hints)
    expect(() => validateAppReport({ processes: [], hints: { ...hints, title: 'x' } })).toThrow(/Unexpected field/)
    expect(() => validateAppReport({ processes: [], hints: { ...hints, windows: [{ w: 1, h: 1, scale: 1, visible: true, url: 'x' }] } })).toThrow(/Unexpected field/)
  })
})

describe('memory log', () => {
  it('rotates at its size and keeps a bounded number of files', async () => {
    const dir = home()
    const log = new MemoryLog(dir, { maxBytes: 2_000, keep: 3, flushIntervalMs: 1 })
    for (let i = 0; i < 200; i++) {
      log.append({ type: 'start', t: T0 + i, version: '0.1.3', pid: i })
      if (i % 10 === 9) await log.flush()
    }
    await log.flush()
    const files = readdirSync(join(dir, 'diagnostics')).sort()
    expect(files).toEqual(['memory.jsonl', 'memory.jsonl.1', 'memory.jsonl.2', 'memory.jsonl.3'])
    for (const file of files) expect(readFileSync(join(dir, 'diagnostics', file)).length).toBeLessThanOrEqual(2_000)
    // Oldest first, newest last, and the newest line kept.
    const lines = readMemoryLog(join(dir, 'diagnostics', 'memory.jsonl'))
    expect(lines[lines.length - 1]).toMatchObject({ pid: 199 })
    expect(lines.map((line) => line.t)).toEqual([...lines.map((line) => line.t)].sort((a, b) => a - b))
  })

  it('deletes rotated files older than a week, and skips damaged lines', () => {
    const dir = home()
    const path = join(dir, 'diagnostics', 'memory.jsonl')
    const log = new MemoryLog(dir)
    log.append({ type: 'start', t: T0, version: '1', pid: 1 })
    log.flushSync()
    writeFileSync(`${path}.1`, `${JSON.stringify({ type: 'start', t: T0 - 1, version: '0', pid: 0 })}\n{"type":"sam`)
    expect(readMemoryLog(path)).toHaveLength(2)
    expect(pruneMemoryLog(path, Date.now() + 8 * 24 * 3_600_000)).toBe(1)
    expect(readdirSync(join(dir, 'diagnostics'))).toEqual(['memory.jsonl'])
  })

  it('the CLI summary reads the latest run, its trend and breaches from the log', async () => {
    const dir = home()
    const now = { t: T0 }
    const monitor = monitorAt(dir, { mb: () => 600, now })
    await run(monitor, now, 6)
    monitor.stop()
    const summary = summarizeMemoryLog(readMemoryLog(join(dir, 'diagnostics', 'memory.jsonl')), now.t, { MOUSSE_MEMORY_MONITOR: '{"serviceSustainMinutes":3,"servicePrivateMb":500}' })
    expect(summary.samples).toBe(6)
    expect(summary.version).toBe('0.1.3')
    expect(summary.sample?.service.private).toBe(600)
    expect(summary.breaches.map((b) => b.kind)).toEqual(['service-high'])
    expect(summary.recentBreaches).toHaveLength(1)
    expect(summary.detail?.heapSpaces.old_space).toBe(50)
  })
})
