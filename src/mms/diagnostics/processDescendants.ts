/** On-demand process ancestry. Only numeric OS fields are requested; command lines and names are never read. */
import { execFile } from 'node:child_process'
import type { ChildMemory } from '../../shared/diagnostics/memory'
import { readChildMemory } from './processMemory'

const MAX_TABLE_ROWS = 65_536
const MAX_TREE_PROCESSES = 1_024

export type Discovery = 'complete' | 'limited' | 'unavailable' | 'unsupported'
export interface ProcessParent { pid: number; ppid: number }
export interface TreeProcess { pid: number; kind: string; relationship: 'tracked' | 'descendant' }
export interface ChildTreeReading {
  children: Array<ChildMemory & { relationship: 'tracked' | 'descendant' }>
  discovery: Discovery
}

/** A bounded numeric process listing, shared by POSIX ps and Windows CIM. */
export function parseProcessParents(text: string): { parents: ProcessParent[]; limited: boolean } {
  const parents: ProcessParent[] = []
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line)
    if (!match) continue
    const pid = Number(match[1]), ppid = Number(match[2])
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0x7fffffff || !Number.isSafeInteger(ppid) || ppid > 0x7fffffff) continue
    if (parents.length === MAX_TABLE_ROWS) return { parents, limited: true }
    parents.push({ pid, ppid })
  }
  return { parents, limited: false }
}

/** Each pid once, with a nested tracked root taking precedence over its ancestor's kind. No recursive walking. */
export function selectProcessTree(roots: Array<{ pid: number; kind: string }>, parents: ProcessParent[]): { processes: TreeProcess[]; limited: boolean } {
  const processes = new Map<number, TreeProcess>()
  let limited = false
  for (const root of roots) {
    if (!Number.isSafeInteger(root.pid) || root.pid <= 1 || root.pid === process.pid || processes.has(root.pid)) continue
    if (processes.size === MAX_TREE_PROCESSES) { limited = true; break }
    processes.set(root.pid, { ...root, relationship: 'tracked' })
  }
  const present = new Set(parents.map((entry) => entry.pid))
  const byParent = new Map<number, number[]>()
  for (const entry of parents) {
    const siblings = byParent.get(entry.ppid)
    if (siblings) siblings.push(entry.pid)
    else byParent.set(entry.ppid, [entry.pid])
  }
  const queue = [...processes.values()].filter((entry) => present.has(entry.pid))
  for (let i = 0; i < queue.length; i++) {
    const parent = queue[i]
    for (const pid of byParent.get(parent.pid) ?? []) {
      if (pid <= 1 || pid === process.pid || processes.has(pid)) continue
      if (processes.size === MAX_TREE_PROCESSES) return { processes: [...processes.values()], limited: true }
      const child: TreeProcess = { pid, kind: parent.kind, relationship: 'descendant' }
      processes.set(pid, child)
      queue.push(child)
    }
  }
  return { processes: [...processes.values()], limited }
}

async function listParents(): Promise<string | null> {
  const [command, args] = process.platform === 'win32'
    ? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "Get-CimInstance Win32_Process | ForEach-Object { '{0} {1}' -f $_.ProcessId, $_.ParentProcessId }"]] as const
    : ['ps', ['-A', '-o', 'pid=,ppid=']] as const
  return new Promise((resolve) => {
    execFile(command, [...args], { windowsHide: true, timeout: 5_000, maxBuffer: 2 * 1024 * 1024 }, (error, stdout) => resolve(error ? null : String(stdout)))
  })
}

/** Only profiler_children calls this: no OS ancestry scan on the monitor's frequent sample path. */
export async function readChildTreeMemory(roots: Array<{ pid: number; kind: string }>): Promise<ChildTreeReading> {
  let discovery: Discovery = 'complete'
  let parents: ProcessParent[] = []
  if (!['linux', 'darwin', 'win32'].includes(process.platform)) discovery = 'unsupported'
  else if (roots.length) {
    const text = await listParents()
    if (text === null) discovery = 'unavailable'
    else {
      const parsed = parseProcessParents(text)
      parents = parsed.parents
      // An empty listing cannot establish that the tracked processes have no descendants.
      discovery = parsed.limited ? 'limited' : parents.length ? 'complete' : 'unavailable'
    }
  }
  const selected = selectProcessTree(roots, parents)
  if (selected.limited) discovery = 'limited'
  const children: ChildTreeReading['children'] = []
  // Bound concurrent /proc reads. macOS and Windows use one memory listing for the selected pids.
  const batchSize = process.platform === 'linux' ? 32 : MAX_TREE_PROCESSES
  for (let i = 0; i < selected.processes.length; i += batchSize) {
    const batch = selected.processes.slice(i, i + batchSize)
    const readings = await readChildMemory(batch)
    readings.forEach((reading, j) => children.push({ ...reading, relationship: batch[j].relationship }))
  }
  return { children, discovery }
}
