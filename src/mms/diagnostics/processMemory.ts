/**
 * Reads one process's memory cheaply: Node's counters, V8's heap statistics, and the OS's private bytes where the
 * runtime offers them (Electron's `process.getProcessMemoryInfo`, or `/proc/self/status` on Linux). Also reads the
 * memory of processes the service started, which needs one OS listing, so it runs only every few samples.
 */
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import v8 from 'node:v8'
import { toMb, type ChildMemory, type MemoryDetail, type ProcessMemory } from '../../shared/diagnostics/memory'

type ElectronProcess = NodeJS.Process & { getProcessMemoryInfo?: () => Promise<{ private: number; residentSet?: number }> }

/** Private bytes of this process in MB, or undefined when the OS does not say. */
export async function readOwnPrivateMb(): Promise<number | undefined> {
  const electron = process as ElectronProcess
  if (typeof electron.getProcessMemoryInfo === 'function') {
    try {
      const info = await electron.getProcessMemoryInfo()
      if (typeof info?.private === 'number' && info.private > 0) return Math.round((info.private / 1024) * 10) / 10
    } catch {
      // Before app ready, or not in Electron after all.
    }
  }
  if (process.platform === 'linux') {
    try {
      const status = await readFile('/proc/self/status', 'utf8')
      const anon = /^RssAnon:\s+(\d+)\s+kB/m.exec(status)
      if (anon) return Math.round((Number(anon[1]) / 1024) * 10) / 10
    } catch {
      // No procfs.
    }
  }
  return undefined
}

export async function sampleOwnProcess(): Promise<ProcessMemory> {
  const usage = process.memoryUsage()
  const privateMb = await readOwnPrivateMb()
  return {
    rss: toMb(usage.rss),
    ...(privateMb !== undefined ? { private: privateMb } : {}),
    heapUsed: toMb(usage.heapUsed),
    heapTotal: toMb(usage.heapTotal),
    external: toMb(usage.external),
    arrayBuffers: toMb(usage.arrayBuffers)
  }
}

/** V8's heap statistics and the size of each heap space. A few microseconds. */
export function readHeapDetail(): MemoryDetail {
  const heap = v8.getHeapStatistics()
  const heapSpaces: Record<string, number> = {}
  for (const space of v8.getHeapSpaceStatistics()) heapSpaces[space.space_name] = toMb(space.space_size)
  return {
    heapSpaces,
    heap: {
      totalHeapSize: toMb(heap.total_heap_size),
      usedHeapSize: toMb(heap.used_heap_size),
      heapSizeLimit: toMb(heap.heap_size_limit),
      mallocedMemory: toMb(heap.malloced_memory),
      externalMemory: toMb(heap.external_memory ?? 0),
      nativeContexts: heap.number_of_native_contexts,
      detachedContexts: heap.number_of_detached_contexts
    }
  }
}

function run(command: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(command, args, { windowsHide: true, timeout: 10_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      resolve(error ? null : String(stdout))
    })
  })
}

/** Resident memory in MB of each pid: `/proc` on Linux, `ps` on macOS, `tasklist` (working set) on Windows. */
export async function readProcessesMb(pids: number[]): Promise<Map<number, number>> {
  const out = new Map<number, number>()
  if (!pids.length) return out
  if (process.platform === 'linux') {
    await Promise.all(pids.map(async (pid) => {
      try {
        const status = await readFile(`/proc/${pid}/status`, 'utf8')
        const rss = /^VmRSS:\s+(\d+)\s+kB/m.exec(status)
        if (rss) out.set(pid, Math.round((Number(rss[1]) / 1024) * 10) / 10)
      } catch {
        // Gone.
      }
    }))
    return out
  }
  if (process.platform === 'win32') {
    const text = await run('tasklist', ['/FO', 'CSV', '/NH'])
    if (!text) return out
    const wanted = new Set(pids)
    for (const line of text.split(/\r?\n/)) {
      // "name","pid","session","#","12,345 K"
      const cells = line.match(/"([^"]*)"/g)?.map((cell) => cell.slice(1, -1))
      if (!cells || cells.length < 5) continue
      const pid = Number(cells[1])
      if (!wanted.has(pid)) continue
      const kb = Number(cells[4].replace(/[^0-9]/g, ''))
      if (Number.isFinite(kb)) out.set(pid, Math.round((kb / 1024) * 10) / 10)
    }
    return out
  }
  const text = await run('ps', ['-o', 'pid=,rss=', '-p', pids.join(',')])
  for (const line of text?.split('\n') ?? []) {
    const [pid, kb] = line.trim().split(/\s+/).map(Number)
    if (Number.isInteger(pid) && Number.isFinite(kb)) out.set(pid, Math.round((kb / 1024) * 10) / 10)
  }
  return out
}

/** Each tracked child's kind and memory. */
export async function readChildMemory(children: Array<{ pid: number; kind: string }>): Promise<ChildMemory[]> {
  const sizes = await readProcessesMb(children.map((child) => child.pid))
  return children.map((child) => ({ kind: child.kind, mb: sizes.get(child.pid) ?? null }))
}
