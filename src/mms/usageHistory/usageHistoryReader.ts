import { existsSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { Worker } from 'node:worker_threads'
import type { UsageHistoryRequest, UsageHistoryResponse } from '../../shared/usageHistory'
import { UsageHistoryScanner } from './UsageHistoryScanner'

/** The worker stops after this long without a request; its next start reads the cache file again. */
export const USAGE_WORKER_IDLE_MS = 5 * 60_000

/** The built worker beside the bundle that runs this code (`out/cli/usageHistoryWorker.js`, `out/main/usageHistoryWorker.js`). */
export function usageHistoryWorkerScript(): string | undefined {
  if (process.env.MOUSSE_USAGE_HISTORY_WORKER === 'inline') return undefined
  if (process.env.MOUSSE_USAGE_HISTORY_WORKER) return process.env.MOUSSE_USAGE_HISTORY_WORKER
  const here = dirname(typeof __filename === 'string' ? __filename : fileURLToPath(import.meta.url))
  for (const dir of [here, join(here, '..')]) {
    const script = join(dir, 'usageHistoryWorker.js')
    const unpacked = script.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1')
    if (unpacked !== script && existsSync(unpacked)) return unpacked
    if (existsSync(script)) return script
  }
  return undefined
}

interface Pending { resolve: (value: UsageHistoryResponse) => void; reject: (error: Error) => void }

/**
 * Reads usage history on a worker thread, started on the first request and stopped when idle. Without a built
 * worker (tests, a source run) the scanner runs in this process; it still yields between chunks of each log.
 */
export class UsageHistoryReader {
  private worker: Worker | null = null
  private readonly pending = new Map<number, Pending>()
  private nextId = 1
  private idleTimer: ReturnType<typeof setTimeout> | undefined
  private local: UsageHistoryScanner | null = null

  constructor(private readonly cachePath: string, private readonly script: string | undefined = usageHistoryWorkerScript()) {}

  history(request: UsageHistoryRequest): Promise<UsageHistoryResponse> {
    if (!this.script) return (this.local ??= new UsageHistoryScanner(this.cachePath)).history(request)
    clearTimeout(this.idleTimer)
    const worker = this.start(this.script)
    const id = this.nextId++
    return new Promise<UsageHistoryResponse>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      worker.ref()
      worker.postMessage({ id, request })
    })
  }

  private start(script: string): Worker {
    if (this.worker) return this.worker
    const worker = new Worker(script, { workerData: { cachePath: this.cachePath }, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })
    worker.on('message', (message: { id: number; ok: boolean; value?: UsageHistoryResponse; error?: string }) => {
      const entry = this.pending.get(message.id)
      if (!entry) return
      this.pending.delete(message.id)
      if (message.ok) entry.resolve(message.value!)
      else entry.reject(new Error(message.error ?? 'Usage history failed'))
      if (!this.pending.size) this.idle(worker)
    })
    const fail = (error: Error) => {
      if (this.worker === worker) this.worker = null
      for (const entry of this.pending.values()) entry.reject(error)
      this.pending.clear()
    }
    worker.on('error', fail)
    worker.on('exit', (code) => fail(new Error(`Usage history worker stopped (${code})`)))
    this.worker = worker
    return worker
  }

  /** No request in flight: the worker no longer keeps the process alive, and stops after a while. */
  private idle(worker: Worker): void {
    worker.unref()
    clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => {
      if (this.worker !== worker || this.pending.size) return
      this.worker = null
      void worker.terminate()
    }, USAGE_WORKER_IDLE_MS)
    this.idleTimer.unref?.()
  }
}

const readers = new Map<string, UsageHistoryReader>()

/** The installation's one reader, its cache beside Mousse's other state: every profile reads the same logs. */
export function usageHistoryReader(homeDir: string): UsageHistoryReader {
  const cachePath = join(homeDir, 'cache', 'usage-history-v1.json')
  let reader = readers.get(cachePath)
  if (!reader) { reader = new UsageHistoryReader(cachePath); readers.set(cachePath, reader) }
  return reader
}
