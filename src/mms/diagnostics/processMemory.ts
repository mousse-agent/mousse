/**
 * Reads one process's memory cheaply: Node's counters, V8's heap statistics, and the OS's private bytes where the
 * runtime offers them (Electron's `process.getProcessMemoryInfo`, or `/proc/self/status` on Linux). Also reads the
 * memory of processes the service started (one OS listing a sample), and on macOS any processes' footprints.
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

const UNIT_MB: Record<string, number> = { B: 1 / 1048576, K: 1 / 1024, M: 1, G: 1024, T: 1048576 }

/**
 * `top -l 1 -stats pid,mem` output as MB by pid. MEM is the process's phys_footprint (Activity Monitor's Memory), in
 * B, K, M or G, sometimes followed by `+` or `-` (it grew or shrank).
 */
export function parseTopMemory(text: string): Map<number, number> {
  const out = new Map<number, number>()
  for (const line of text.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+(?:\.\d+)?)([BKMGT])[+-]?\s*$/.exec(line)
    if (!match) continue
    out.set(Number(match[1]), Math.round(Number(match[2]) * UNIT_MB[match[3]] * 10) / 10)
  }
  return out
}

/**
 * Each pid's footprint in MB on macOS: the memory Activity Monitor shows, with the GPU and IOSurface memory the process
 * holds, which resident size misses (and which counts freed pages resident size still shows). One `top` sample for
 * all of them, about 0.15 s of CPU. Gone pids are left out; null where `top` could not run or this is not macOS.
 */
export async function readFootprintsMb(pids: number[]): Promise<Map<number, number> | null> {
  if (process.platform !== 'darwin' || !pids.length) return null
  const text = await run('top', ['-l', '1', '-stats', 'pid,mem', ...pids.flatMap((pid) => ['-pid', String(pid)])])
  return text === null ? null : parseTopMemory(text)
}

/**
 * Memory in MB of each pid: the footprint on macOS (`ps`'s resident size if `top` fails), `/proc` resident on Linux,
 * `tasklist` working set on Windows. `footprint` says which macOS gave.
 */
export async function readProcessesMb(pids: number[]): Promise<Map<number, number> & { footprint?: boolean }> {
  const out: Map<number, number> & { footprint?: boolean } = new Map<number, number>()
  if (!pids.length) return out
  if (process.platform === 'darwin') {
    const footprints = await readFootprintsMb(pids)
    if (footprints) {
      for (const [pid, mb] of footprints) out.set(pid, mb)
      out.footprint = true
      return out
    }
  }
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
  return children.map((child) => ({ kind: child.kind, mb: sizes.get(child.pid) ?? null, ...(sizes.footprint ? { footprint: true } : {}) }))
}
