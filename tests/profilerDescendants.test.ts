import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { MemoryMonitor } from '../src/mms/diagnostics/MemoryMonitor'
import { trackChildProcess, untrackChildProcess } from '../src/mms/diagnostics/liveCounts'
import { createAppToolRegistry, type AppToolHost, type AppToolTurn, type ToolCallContext } from '../src/mms/run/mcp/appTools'
import { normalizeProfilerSettings } from '../src/shared/diagnostics/profiler'

it.skipIf(!['linux', 'darwin', 'win32'].includes(process.platform))('profiler_children finds a real three-generation tree without exposing its arguments or counting tracked descendants twice', async () => {
  const home = mkdtempSync(join(tmpdir(), 'profiler-descendants-'))
  // Hand-authored OS fixture, not a recording of a provider. Each parent reaps its child on shutdown.
  const leaf = `process.send(process.pid); setInterval(() => {}, 1000)`
  const middle = `
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['-e', ${JSON.stringify(leaf)}, 'private-test-marker', '/private/test-path', 'fake-secret-token'], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    child.on('message', pid => process.send([process.pid, pid]));
    process.on('message', () => child.kill());
    child.on('close', () => process.exit(0));
  `
  const root = spawn(process.execPath, ['-e', `
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['-e', ${JSON.stringify(middle)}], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    child.on('message', pids => process.send(pids));
    process.on('message', () => child.send('stop'));
    child.on('close', () => process.exit(0));
  `], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
  const rootClosed = once(root, 'close')
  let pids: number[] = []
  const monitor = new MemoryMonitor({
    homeDir: home, version: 'test',
    readCounts: async () => ({ counts: {} as never, workerHeaps: [] })
  })
  try {
    const [message] = await once(root, 'message')
    pids = message as number[]
    trackChildProcess(root, 'codex')
    const settings = { ...normalizeProfilerSettings(), enabled: true, agentAccess: true }
    const { registry } = createAppToolRegistry({ host: {
      profiler: () => ({ settings, service: { monitor: () => monitor } })
    } as unknown as AppToolHost })
    const call = async () => {
      const result = await registry.get('profiler_children')!.handler({}, {
        turn: { threadId: 'test', actor: { kind: 'main' } } as AppToolTurn,
        caller: { threadId: 'test', runId: 'test', provider: 'codex', accessLevel: 'manage' },
        signal: new AbortController().signal, transport: 'mcp'
      } as ToolCallContext)
      expect(result.isError).toBeFalsy()
      for (const privateValue of ['private-test-marker', '/private/test-path', 'fake-secret-token', home]) expect(result.text).not.toContain(privateValue)
      expect(result.text).not.toMatch(/"(?:pid|ppid|command|path)"/)
      return JSON.parse(result.text)
    }
    const report = await call()
    expect(report.processes).toHaveLength(3)
    expect(report.processes.filter((p: { relationship: string }) => p.relationship === 'descendant')).toHaveLength(2)
    expect(report.processes.every((p: { kind: string; mb: number }) => p.kind === 'codex' && p.mb > 0)).toBe(true)
    expect(report.discovery).toBe('complete')
    expect(report.totalMb).toBe(report.measuredTotalMb)
    expect(report.totalMb).toBeGreaterThan(0)
    expect(report.processes.every((p: { metric: string }) => ['footprint', 'working-set'].includes(p.metric))).toBe(true)
    // Nested roots belong to their own tracked kind, and are counted once.
    trackChildProcess(pids[0], 'mcp')
    const nested = await call()
    expect(nested.processes).toHaveLength(3)
    expect(nested.processes.filter((p: { relationship: string }) => p.relationship === 'tracked')).toHaveLength(2)
    expect(nested.byKind.find((p: { kind: string }) => p.kind === 'mcp').count).toBe(2)
  } finally {
    monitor.stop()
    const owned = [...pids].reverse().concat(root.pid ?? [])
    const fallback = setTimeout(() => {
      for (const pid of owned) try { process.kill(pid, 'SIGKILL') } catch { /* Already gone. */ }
    }, 5_000)
    try {
      if (root.connected) root.send('stop')
      expect(await rootClosed).toEqual([0, null])
      for (const pid of owned) expect(() => process.kill(pid, 0)).toThrow()
    } finally {
      clearTimeout(fallback)
      for (const pid of owned) untrackChildProcess(pid)
      rmSync(home, { recursive: true, force: true })
    }
  }
})
