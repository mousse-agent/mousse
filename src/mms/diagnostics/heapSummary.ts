/**
 * The profiler's heap summary: a V8 heap snapshot of the service, analysed in a worker thread, of which only totals
 * leave: the largest constructors by retained size, counts and sizes by node type, and the largest strings by size.
 * A snapshot holds everything the service has in memory (thread text, prompts, paths, tokens), so nothing named by
 * data ever comes out: a constructor's name is kept only when it is a plain identifier, every other node is named by
 * its type alone, and a string is only its size. The file is written to `diagnostics/heap-snapshots/` (0600) and
 * deleted as soon as it is read; one a crash left behind is deleted when the service starts and before each summary.
 */
import { chmodSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import v8 from 'node:v8'
import { Worker } from 'node:worker_threads'
import { HEAP_SNAPSHOT_RELATIVE_DIR } from './heapSnapshot'

/**
 * A heap summary failure whose message is fixed text and numbers, safe to hand an agent. Any other error the summary
 * meets may carry a path and is replaced by fixed text at the tool.
 */
export class HeapSummaryError extends Error {
  override name = 'HeapSummaryError'
}

export interface HeapSummary {
  /** Nodes reachable from the root, and their total size. */
  nodes: number
  totalMb: number
  /** Every node type with its count and its nodes' own size. */
  byType: Array<{ type: string; count: number; selfMb: number }>
  /**
   * The constructors (and node types) that retain most: what would be freed if every object of that name were gone,
   * counting an object held by another of the same name once.
   */
  topRetainers: Array<{ name: string; count: number; selfMb: number; retainedMb: number }>
  /** The largest strings by size. Their content is never read out. */
  biggestStrings: Array<{ type: string; bytes: number; retainedBytes: number; content: 'redacted' }>
}

/**
 * Summarizes a parsed heap snapshot. Self-contained (no imports, no outside helpers): the worker runs its source.
 * Retained sizes come from the dominator tree over strong edges (Cooper, Harvey and Kennedy's iterative algorithm).
 */
export function summarizeHeapSnapshot(snapshot: any, top: number): HeapSummary {
  const meta = snapshot.snapshot.meta
  const nodeFields: string[] = meta.node_fields
  const edgeFields: string[] = meta.edge_fields
  const nodeTypes: string[] = meta.node_types[0]
  const edgeTypes: string[] = meta.edge_types[0]
  const nodesRaw: number[] = snapshot.nodes
  const edgesRaw: number[] = snapshot.edges
  const strings: string[] = snapshot.strings
  const NF = nodeFields.length
  const EF = edgeFields.length
  const typeOff = nodeFields.indexOf('type')
  const nameOff = nodeFields.indexOf('name')
  const sizeOff = nodeFields.indexOf('self_size')
  const edgeCountOff = nodeFields.indexOf('edge_count')
  const edgeTypeOff = edgeFields.indexOf('type')
  const toOff = edgeFields.indexOf('to_node')
  const weak = edgeTypes.indexOf('weak')
  const n = Math.floor(nodesRaw.length / NF)
  const mb = (bytes: number) => Math.round((bytes / 1048576) * 100) / 100

  const firstEdge = new Int32Array(n + 1)
  for (let i = 0, e = 0; i < n; i++) {
    firstEdge[i] = e
    e += nodesRaw[i * NF + edgeCountOff] * EF
    firstEdge[i + 1] = e
  }

  // Depth-first from the root (node 0), over strong edges: post-order numbers, and every reachable node.
  const post = new Int32Array(n).fill(-1)
  const order = new Int32Array(n)
  const visited = new Uint8Array(n)
  const stack = new Int32Array(n)
  const cursor = new Int32Array(n)
  let reached = 0
  let sp = 0
  stack[sp++] = 0
  visited[0] = 1
  cursor[0] = firstEdge[0]
  while (sp > 0) {
    const v = stack[sp - 1]
    let pushed = false
    while (cursor[v] < firstEdge[v + 1]) {
      const e = cursor[v]
      cursor[v] += EF
      if (edgesRaw[e + edgeTypeOff] === weak) continue
      const w = edgesRaw[e + toOff] / NF
      if (visited[w]) continue
      visited[w] = 1
      cursor[w] = firstEdge[w]
      stack[sp++] = w
      pushed = true
      break
    }
    if (!pushed) {
      sp--
      post[v] = reached
      order[reached++] = v
    }
  }

  // Predecessors of every reachable node, over the same edges.
  const predCount = new Int32Array(n + 1)
  for (let v = 0; v < n; v++) {
    if (!visited[v]) continue
    for (let e = firstEdge[v]; e < firstEdge[v + 1]; e += EF) {
      if (edgesRaw[e + edgeTypeOff] === weak) continue
      predCount[edgesRaw[e + toOff] / NF + 1]++
    }
  }
  for (let i = 0; i < n; i++) predCount[i + 1] += predCount[i]
  const preds = new Int32Array(predCount[n])
  const fill = predCount.slice(0, n)
  for (let v = 0; v < n; v++) {
    if (!visited[v]) continue
    for (let e = firstEdge[v]; e < firstEdge[v + 1]; e += EF) {
      if (edgesRaw[e + edgeTypeOff] === weak) continue
      const w = edgesRaw[e + toOff] / NF
      preds[fill[w]++] = v
    }
  }

  const idom = new Int32Array(n).fill(-1)
  idom[0] = 0
  let changed = true
  for (let round = 0; changed && round < 64; round++) {
    changed = false
    for (let k = reached - 2; k >= 0; k--) {
      const b = order[k]
      let next = -1
      for (let i = predCount[b]; i < predCount[b + 1]; i++) {
        let p = preds[i]
        if (idom[p] < 0) continue
        if (next < 0) { next = p; continue }
        let q = next
        while (p !== q) {
          while (post[p] < post[q]) p = idom[p]
          while (post[q] < post[p]) q = idom[q]
        }
        next = p
      }
      if (next >= 0 && idom[b] !== next) {
        idom[b] = next
        changed = true
      }
    }
  }

  const retained = new Float64Array(n)
  for (let k = 0; k < reached; k++) {
    const v = order[k]
    retained[v] += nodesRaw[v * NF + sizeOff]
    if (v !== 0 && idom[v] >= 0) retained[idom[v]] += retained[v]
  }

  const identifier = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/
  const classOf = new Array<string>(n)
  const nameOf = (v: number): string => {
    const type = nodeTypes[nodesRaw[v * NF + typeOff]] ?? 'other'
    if (type !== 'object') return `(${type})`
    const name = strings[nodesRaw[v * NF + nameOff]]
    return typeof name === 'string' && identifier.test(name) ? name : '(object)'
  }
  const types = new Map<string, { count: number; self: number }>()
  const classes = new Map<string, { count: number; self: number; retained: number }>()
  const stringTypes = new Set(['string', 'concatenated string', 'sliced string'])
  const bigStrings: Array<{ type: string; bytes: number; retainedBytes: number; content: 'redacted' }> = []
  let total = 0
  for (let k = 0; k < reached; k++) {
    const v = order[k]
    const self = nodesRaw[v * NF + sizeOff]
    total += self
    const type = nodeTypes[nodesRaw[v * NF + typeOff]] ?? 'other'
    const byType = types.get(type) ?? { count: 0, self: 0 }
    byType.count++
    byType.self += self
    types.set(type, byType)
    const name = (classOf[v] = nameOf(v))
    const cls = classes.get(name) ?? { count: 0, self: 0, retained: 0 }
    cls.count++
    cls.self += self
    classes.set(name, cls)
    if (stringTypes.has(type) && self >= 1024) {
      bigStrings.push({ type, bytes: self, retainedBytes: retained[v], content: 'redacted' })
      if (bigStrings.length > top * 4) {
        bigStrings.sort((a, b) => b.bytes - a.bytes)
        bigStrings.length = top
      }
    }
  }
  // A class's retained size counts an object held by another of the same class once (its dominator's class differs).
  for (let k = 0; k < reached; k++) {
    const v = order[k]
    if (v === 0) continue
    const name = classOf[v]
    let d = idom[v]
    let nested = false
    for (let hops = 0; d > 0 && hops < 64; hops++) {
      if (classOf[d] === name) { nested = true; break }
      d = idom[d]
    }
    if (!nested) classes.get(name)!.retained += retained[v]
  }
  bigStrings.sort((a, b) => b.bytes - a.bytes)
  return {
    nodes: reached,
    totalMb: mb(total),
    byType: [...types].map(([type, t]) => ({ type, count: t.count, selfMb: mb(t.self) })).sort((a, b) => b.selfMb - a.selfMb),
    topRetainers: [...classes]
      .filter(([name]) => name !== '(synthetic)')
      .map(([name, c]) => ({ name, count: c.count, selfMb: mb(c.self), retainedMb: mb(c.retained) }))
      .sort((a, b) => b.retainedMb - a.retainedMb)
      .slice(0, top),
    biggestStrings: bigStrings.slice(0, top).map((s) => ({ ...s, retainedBytes: Math.round(s.retainedBytes) }))
  }
}

/** The worker's source: reads the file, runs `summarizeHeapSnapshot` on it and posts the summary. */
function workerSource(): string {
  return [
    "const { parentPort, workerData } = require('node:worker_threads')",
    "const { readFileSync } = require('node:fs')",
    // A bundler may wrap nested functions in a naming helper; the worker has none.
    'var __name = (fn) => fn',
    `const summarize = (${summarizeHeapSnapshot.toString()})`,
    'try {',
    "  parentPort.postMessage({ ok: true, value: summarize(JSON.parse(readFileSync(workerData.file, 'utf8')), workerData.top) })",
    '} catch (error) {',
    // Only the error's class: a parse error's message quotes the file, which holds thread text.
    "  const name = error && ['Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError'].includes(error.name) ? error.name : 'Error'",
    '  parentPort.postMessage({ ok: false, error: name })',
    '}'
  ].join('\n')
}

/**
 * The largest snapshot file the summary reads. The worker reads the file as one string and parses it, which needs
 * a few times the file's size, and a string cannot pass about 512 MB at all.
 */
export const HEAP_SUMMARY_MAX_FILE_MB = 256
/** The worker's heap limit: room to parse a file at the cap, and no more taken from the service. */
export const HEAP_SUMMARY_WORKER_HEAP_MB = 1536

/**
 * Analyses a snapshot file in a worker thread, so the service's event loop stays free while it parses. A file over
 * `maxFileMb` is refused before anything reads it, and the worker runs under a heap limit of its own. Every failure is a
 * `HeapSummaryError` with fixed text: a worker's parse error would quote the file, and a file error its path.
 */
export function analyseHeapSnapshotFile(
  file: string,
  top: number,
  options: { timeoutMs?: number; maxFileMb?: number; workerHeapMb?: number } = {}
): Promise<HeapSummary> {
  const maxFileMb = options.maxFileMb ?? HEAP_SUMMARY_MAX_FILE_MB
  let sizeMb: number
  try {
    sizeMb = statSync(file).size / 1048576
  } catch {
    return Promise.reject(new HeapSummaryError('The heap analysis failed: the snapshot could not be read.'))
  }
  if (sizeMb > maxFileMb) {
    return Promise.reject(new HeapSummaryError(`The service heap snapshot is ${Math.round(sizeMb)} MB; the summary reads at most ${maxFileMb} MB. Use profiler_service_breakdown instead.`))
  }
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerSource(), {
      eval: true,
      workerData: { file, top },
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      resourceLimits: { maxOldGenerationSizeMb: options.workerHeapMb ?? HEAP_SUMMARY_WORKER_HEAP_MB, maxYoungGenerationSizeMb: 64 }
    })
    let settled = false
    const settle = (action: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      void worker.terminate()
      action()
    }
    const timer = setTimeout(() => settle(() => reject(new HeapSummaryError('The heap analysis took too long.'))), options.timeoutMs ?? 120_000)
    timer.unref?.()
    worker.once('message', (message: { ok: boolean; value?: HeapSummary; error?: string }) => {
      settle(() => {
        if (message.ok && message.value) resolve(message.value)
        else reject(new HeapSummaryError(`The heap analysis failed (${message.error ?? 'Error'}).`))
      })
    })
    worker.once('error', (error: Error & { code?: string }) => {
      settle(() => reject(error.code === 'ERR_WORKER_OUT_OF_MEMORY'
        ? new HeapSummaryError(`The heap analysis ran out of its ${options.workerHeapMb ?? HEAP_SUMMARY_WORKER_HEAP_MB} MB memory limit.`)
        : new HeapSummaryError('The heap analysis failed in its worker.')))
    })
    worker.once('exit', () => settle(() => reject(new HeapSummaryError('The heap analysis stopped before it finished.'))))
  })
}

/** Matches the files the heap summary writes; anything else in the folder is left alone. */
const SUMMARY_FILE = /^agent-\d+\.heapsnapshot$/

/**
 * Deletes heap summary files a crash or a killed service left behind: they hold everything the service had in memory.
 * Runs when the service starts and before each summary. Snapshots a person asked for (`heap-*`) are kept.
 */
export function removeLeftoverSummaryFiles(homeDir: string): number {
  const dir = join(homeDir, HEAP_SNAPSHOT_RELATIVE_DIR)
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return 0
  }
  let removed = 0
  for (const entry of entries) {
    if (!SUMMARY_FILE.test(entry)) continue
    try {
      rmSync(join(dir, entry), { force: true })
      removed += 1
    } catch { /* tried again at the next start or summary */ }
  }
  return removed
}

/**
 * How much bigger than the used heap a snapshot must be expected to be before the summary refuses without writing
 * one. A snapshot records every object with its fields and edges as numbers in JSON text, so for the object-heavy heap
 * the service has the file usually comes out at one to two times the used heap. Only long strings shrink it: the
 * snapshot keeps the first kilobyte of each. Refusing at twice the file cap (a ratio of 1/2) refuses only a heap whose
 * snapshot would pass the cap unless more than half of it were long strings, so a summary that would have fit is
 * almost never refused; the cap on the written file stays the exact check.
 */
export const HEAP_SUMMARY_MAX_HEAP_TO_FILE_RATIO = 2

/**
 * Writes a snapshot of this process, summarizes it in a worker and deletes it, whatever happens. Only the summary is
 * returned; the file's name and folder are not, and every failure is a fixed `HeapSummaryError` with numbers only.
 */
export async function takeHeapSummary(
  homeDir: string,
  top: number,
  deps: {
    write?: (file: string) => string
    analyse?: (file: string, top: number) => Promise<HeapSummary>
    now?: () => number
    /** The used heap, in bytes, before the snapshot is written. */
    heapUsedBytes?: () => number
    maxFileMb?: number
  } = {}
): Promise<HeapSummary> {
  const maxFileMb = deps.maxFileMb ?? HEAP_SUMMARY_MAX_FILE_MB
  const heapUsedMb = (deps.heapUsedBytes ?? (() => process.memoryUsage().heapUsed))() / 1048576
  if (heapUsedMb > maxFileMb * HEAP_SUMMARY_MAX_HEAP_TO_FILE_RATIO) {
    throw new HeapSummaryError(`The service heap uses ${Math.round(heapUsedMb)} MB; its snapshot would pass the ${maxFileMb} MB the summary reads. Use profiler_service_breakdown instead.`)
  }
  const dir = join(homeDir, HEAP_SNAPSHOT_RELATIVE_DIR)
  const target = join(dir, `agent-${(deps.now ?? Date.now)()}.heapsnapshot`)
  let written: string | undefined
  try {
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      chmodSync(dir, 0o700)
      removeLeftoverSummaryFiles(homeDir)
      written = (deps.write ?? ((file: string) => v8.writeHeapSnapshot(file)))(target)
      chmodSync(written, 0o600)
    } catch {
      // A file system error names the folder or file, and so the home path.
      throw new HeapSummaryError('The heap snapshot could not be written.')
    }
    return await (deps.analyse ?? ((file: string, count: number) => analyseHeapSnapshotFile(file, count, { maxFileMb })))(written, top)
  } finally {
    try {
      rmSync(written ?? target, { force: true })
    } catch { /* a file left behind is deleted at the next start or summary; its error would name the path */ }
  }
}
