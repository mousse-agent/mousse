import { afterEach, describe, expect, it, vi } from 'vitest'

const os = vi.hoisted(() => ({
  output: '10 1\n20 10\n30 20\n40 1\n',
  failed: false,
  list: vi.fn(),
  read: vi.fn(async (children: Array<{ pid: number; kind: string }>) => children.map((child) => ({ kind: child.kind, mb: child.pid === 30 ? null : 2 })))
}))
vi.mock('node:child_process', () => ({ execFile: (...args: unknown[]) => {
  os.list(...args.slice(0, 3))
  const done = args[3] as (error: Error | null, text: string) => void
  done(os.failed ? new Error('private path or command') : null, os.output)
} }))
vi.mock('../src/mms/diagnostics/processMemory', () => ({ readChildMemory: os.read }))
vi.mock('../src/mms/diagnostics/liveCounts', () => ({ liveChildProcesses: () => [{ pid: 10, kind: 'codex' }] }))
import { parseProcessParents, readChildTreeMemory, selectProcessTree } from '../src/mms/diagnostics/processDescendants'
import { MemoryMonitor } from '../src/mms/diagnostics/MemoryMonitor'

const actualProcess = process
function platform(value: string) {
  vi.stubGlobal('process', new Proxy(actualProcess, { get: (target, key) => key === 'platform' ? value : Reflect.get(target, key) }))
}
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); os.failed = false; os.output = '10 1\n20 10\n30 20\n40 1\n' })

describe('on-demand process ancestry', () => {
  it('accepts only numeric PID/parent rows and caps the OS table', () => {
    expect(parseProcessParents(' PID PPID\n10 1\r\n 20 10 \n0 1\n3 -1\n4 1 /home/private/token\n9007199254740992 1')).toEqual({ parents: [{ pid: 10, ppid: 1 }, { pid: 20, ppid: 10 }], limited: false })
    const capped = parseProcessParents('10 1\n'.repeat(65_537))
    expect(capped.parents).toHaveLength(65_536)
    expect(capped.limited).toBe(true)
  })

  // Inputs: nested/duplicate roots, deep descendants, unrelated processes, cycles, an absent root,
  // invalid roots and the service itself. Each live pid belongs to its closest tracked root once.
  it('finds multiple generations, gives nested roots their own kind and excludes unrelated processes', () => {
    const { processes } = selectProcessTree([{ pid: 10, kind: 'codex' }, { pid: 20, kind: 'mcp' }, { pid: 20, kind: 'duplicate' }, { pid: -1, kind: 'invalid' }, { pid: process.pid, kind: 'service' }, { pid: 90, kind: 'gone' }], [
      { pid: 10, ppid: 30 }, { pid: 20, ppid: 10 }, { pid: 30, ppid: 20 }, { pid: 40, ppid: 1 }, { pid: 91, ppid: 90 }, { pid: process.pid, ppid: 10 }
    ])
    expect(processes).toEqual([
      { pid: 10, kind: 'codex', relationship: 'tracked' },
      { pid: 20, kind: 'mcp', relationship: 'tracked' },
      { pid: 90, kind: 'gone', relationship: 'tracked' },
      { pid: 30, kind: 'mcp', relationship: 'descendant' }
    ])
  })

  it('bounds a deep tree without recursive work', () => {
    const result = selectProcessTree([{ pid: 10, kind: 'codex' }], Array.from({ length: 2_000 }, (_, i) => ({ pid: i + 10, ppid: i + 9 })))
    expect(result.processes).toHaveLength(1_024)
    expect(result.limited).toBe(true)
  })

  it.each(['linux', 'darwin', 'win32'])('reads descendants with one numeric ancestry listing on %s, preserving unavailable memory', async (target) => {
    platform(target)
    const result = await readChildTreeMemory([{ pid: 10, kind: 'codex' }])
    expect(result).toMatchObject({ discovery: 'complete', children: [
      { kind: 'codex', mb: 2, relationship: 'tracked' },
      { kind: 'codex', mb: 2, relationship: 'descendant' },
      { kind: 'codex', mb: null, relationship: 'descendant' }
    ] })
    expect(os.list).toHaveBeenCalledTimes(1)
    // Only ancestry fields, never process names, paths or command lines, are requested from the OS.
    const query = os.list.mock.calls[0][1].join(' ')
    if (target === 'win32') expect(query).toContain("'{0} {1}' -f $_.ProcessId, $_.ParentProcessId")
    else expect(query).toContain('pid=,ppid=')
    expect(query).not.toMatch(/CommandLine|ExecutablePath|args=|comm=/)
    expect(os.list.mock.calls[0][2]).toMatchObject({ timeout: 5_000, maxBuffer: 2 * 1024 * 1024 })
  })

  it.each(['failed', 'empty'])('keeps tracked processes and reports discovery unavailable for a %s listing', async (mode) => {
    platform('linux')
    os.failed = mode === 'failed'
    os.output = ''
    expect(await readChildTreeMemory([{ pid: 10, kind: 'codex' }])).toMatchObject({ discovery: 'unavailable', children: [{ kind: 'codex', relationship: 'tracked' }] })
  })

  it('does no listing without roots or on an unsupported platform', async () => {
    platform('linux')
    expect(await readChildTreeMemory([])).toEqual({ children: [], discovery: 'complete' })
    platform('freebsd')
    expect(await readChildTreeMemory([{ pid: 10, kind: 'codex' }])).toMatchObject({ discovery: 'unsupported' })
    expect(os.list).not.toHaveBeenCalled()
  })

  it('limits Linux reads to batches of 32 and discloses truncated trees', async () => {
    platform('linux')
    os.output = '10 1\n' + Array.from({ length: 1_050 }, (_, i) => `${i + 100} 10`).join('\n')
    const result = await readChildTreeMemory([{ pid: 10, kind: 'codex' }])
    expect(result.discovery).toBe('limited')
    expect(result.children).toHaveLength(1_024)
    expect(os.read.mock.calls).toHaveLength(32)
    expect(os.read.mock.calls.every(([batch]) => batch.length <= 32)).toBe(true)
  })

  it('keeps ancestry scans out of regular samples and shares an in-flight child-tool read', async () => {
    platform('linux')
    const monitor = new MemoryMonitor({
      homeDir: process.env.MOUSSE_HOME!, version: 'test',
      sampleProcess: async () => ({ rss: 1, heapUsed: 1, heapTotal: 1, external: 0, arrayBuffers: 0 }),
      readCounts: async () => ({ counts: {} as never, workerHeaps: [] }),
      readDetail: () => ({} as never)
    })
    try {
      await monitor.measure()
      await monitor.measure({ children: true })
      expect(os.list).not.toHaveBeenCalled()
      const first = monitor.readChildTreeNow()
      const second = monitor.readChildTreeNow()
      expect(second).toBe(first)
      expect((await first).children).toHaveLength(3)
      expect(os.list).toHaveBeenCalledTimes(1)
    } finally { monitor.stop() }
  })
})
