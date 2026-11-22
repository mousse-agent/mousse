import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryMonitor } from '../src/mms/diagnostics/MemoryMonitor'
import { liveChildProcesses, resetLiveCounts, trackChildProcess, untrackChildProcess } from '../src/mms/diagnostics/liveCounts'
import { overviewReport, sampleNowReport } from '../src/mms/diagnostics/profilerReports'
import { type ChildMemory } from '../src/shared/diagnostics/memory'

const homes: string[] = []
afterEach(() => {
  resetLiveCounts()
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'mousse-child-sampling-'))
  homes.push(dir)
  const now = { t: Date.now() }
  const read = vi.fn(async (): Promise<ChildMemory[]> => liveChildProcesses().map(({ kind }) => ({ kind, mb: 42 })))
  const monitor = new MemoryMonitor({
    homeDir: dir, version: 'test', now: () => now.t,
    sampleProcess: async () => ({ rss: 100, heapUsed: 50 }),
    readCounts: async () => ({ counts: { sqliteConnections: 0, workerThreads: 0, loadedThreads: 0, threadRuntimes: 0, threadCacheThreads: 0, threadCacheMb: 0, replayEvents: 0, ptys: 0, fileWatchers: 0, profiles: 1, activeTurns: 0 }, workerHeaps: [] }),
    readChildren: read
  })
  const report = () => overviewReport(monitor.status(), monitor.thresholds, now.t)
  const row = () => report().processes?.find((row) => row.label.startsWith('Agents and tools'))
  const tick = async () => { await monitor.tick(); now.t += monitor.thresholds.sampleIntervalMs }
  return { monitor, now, read, report, row, tick }
}

describe('provider rows between detailed readings', () => {
  it('keeps rows in overview through intermediate samples with two memory reads for six ticks', async () => {
    trackChildProcess(process.pid, 'codex')
    const f = fixture()
    for (let i = 0; i < 6; i++) {
      await f.monitor.tick()
      expect(f.row()).toMatchObject({ detail: expect.stringContaining('codex 42 MB') })
      expect(f.report().childrenSampledSecondsAgo).toBe((i % 5) * f.monitor.thresholds.sampleIntervalMs / 1000)
      f.now.t += f.monitor.thresholds.sampleIntervalMs
    }
    expect(f.read).toHaveBeenCalledTimes(2)
    f.monitor.stop()
  })

  // Membership changes, empty successful reads, unavailable measurements and rejected reads are different inputs.
  it('drops an exited provider before the next detailed reading and does not reuse its memory for a new provider', async () => {
    trackChildProcess(process.pid, 'codex')
    const f = fixture()
    await f.tick()
    untrackChildProcess(process.pid)
    await f.tick()
    expect(f.row()).toBeUndefined()
    trackChildProcess(process.pid, 'claude')
    f.read.mockResolvedValueOnce([{ kind: 'claude', mb: 17 }])
    await f.tick()
    expect(f.row()).toMatchObject({ detail: expect.stringContaining('claude 17 MB') })
    expect(f.read).toHaveBeenCalledTimes(3)
    f.monitor.stop()
  })

  it('treats an empty successful read as authoritative rather than keeping old rows', async () => {
    trackChildProcess(process.pid, 'codex')
    const f = fixture()
    await f.tick()
    f.read.mockResolvedValueOnce([])
    await f.monitor.tick({ children: true })
    expect(f.row()).toBeUndefined()
    await f.tick()
    expect(f.row()).toBeUndefined()
    expect(f.read).toHaveBeenCalledTimes(2)
    f.monitor.stop()
  })

  it('keeps live provider identity but marks memory unavailable after failure, then retries', async () => {
    trackChildProcess(process.pid, 'codex')
    const f = fixture()
    await f.tick()
    f.read.mockRejectedValueOnce(new Error('unavailable'))
    await f.monitor.tick({ children: true })
    expect(f.row()).toMatchObject({ detail: expect.stringContaining('codex - MB') })
    expect(f.report().childrenSampledSecondsAgo).toBeNull()
    untrackChildProcess(process.pid)
    f.read.mockRejectedValueOnce(new Error('still unavailable'))
    await f.tick()
    expect(f.row()).toBeUndefined()
    expect(f.monitor.samples()).toHaveLength(3)
    f.monitor.stop()
  })

  it('keeps an unreadable child as a row without inventing a measured value', async () => {
    trackChildProcess(process.pid, 'codex')
    const f = fixture()
    f.read.mockResolvedValueOnce([{ kind: 'codex', mb: null }])
    await f.tick()
    await f.monitor.tick()
    expect(f.row()).toMatchObject({ detail: expect.stringContaining('codex - MB') })
    expect(f.read).toHaveBeenCalledTimes(1)
    f.monitor.stop()
  })

  it('refreshes an expired cache on an intermediate measure and forces explicit child measurements', async () => {
    trackChildProcess(process.pid, 'codex')
    const f = fixture()
    await f.tick()
    f.now.t += 5 * f.monitor.thresholds.sampleIntervalMs
    f.read.mockResolvedValueOnce([{ kind: 'codex', mb: 55 }])
    const expired = await f.monitor.measure()
    expect(sampleNowReport(expired, null).processes.find((r) => r.label.startsWith('Agents and tools'))).toMatchObject({ detail: expect.stringContaining('codex 55 MB') })
    f.read.mockResolvedValueOnce([{ kind: 'codex', mb: 66 }])
    const fresh = await f.monitor.measure({ children: true })
    expect(fresh.children?.[0].mb).toBe(66)
    expect(sampleNowReport(fresh, expired).childrenSampledSecondsAgo).toBe(0)
    expect(f.read).toHaveBeenCalledTimes(3)
    f.monitor.stop()
  })

  it('does not publish a provider that exited while its memory was being read', async () => {
    trackChildProcess(process.pid, 'codex')
    const f = fixture()
    f.read.mockImplementationOnce(async () => {
      untrackChildProcess(process.pid)
      return [{ kind: 'codex', mb: 42 }]
    })
    await f.tick()
    expect(f.row()).toBeUndefined()
    f.monitor.stop()
  })
})
