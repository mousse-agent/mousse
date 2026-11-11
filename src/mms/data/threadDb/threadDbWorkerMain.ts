/**
 * Entry of the thread database workers (`threadDbWorker.js`). The write worker answers one synchronous request at a
 * time through a shared flag and a message port; the read worker answers requests by id. See `threadDbClient.ts`.
 */
import v8 from 'node:v8'
import { parentPort, workerData, type MessagePort } from 'node:worker_threads'
import { ThreadDbEngine } from './threadDbEngine'
import { runOp, toWireError, WORKER_STAT_ALIVE, WORKER_STAT_HEAP_KB, WORKER_STAT_OPEN } from './threadDbClient'

const data = workerData as ({ role: 'write'; flag: Int32Array; port: MessagePort } | { role: 'read' | 'index' | 'import' }) & { stats?: Int32Array }

/**
 * This worker's own stats, where the daemon reads them without asking (the memory monitor): its open connections,
 * its heap after each request, and that it is running. Writing them costs a few microseconds a request.
 */
const stats = data.stats
const onOpenCount = stats ? (count: number) => { Atomics.store(stats, WORKER_STAT_OPEN, count) } : undefined
const noteHeap = (): void => {
  if (stats) Atomics.store(stats, WORKER_STAT_HEAP_KB, Math.round(v8.getHeapStatistics().used_heap_size / 1024))
}
if (stats) {
  Atomics.store(stats, WORKER_STAT_ALIVE, 1)
  noteHeap()
  process.on('exit', () => {
    Atomics.store(stats, WORKER_STAT_ALIVE, 0)
    Atomics.store(stats, WORKER_STAT_OPEN, 0)
  })
}

if (data.role === 'write') {
  const engine = new ThreadDbEngine({ idleCloseMs: 2_000, onOpenCount })
  parentPort!.on('message', (request: { id: number; op: string; args: unknown[] }) => {
    let reply: { id: number; ok: boolean; value?: unknown; error?: ReturnType<typeof toWireError> }
    try {
      reply = { id: request.id, ok: true, value: runOp(engine, request.op, request.args) }
    } catch (error) {
      reply = { id: request.id, ok: false, error: toWireError(error) }
    }
    data.port.postMessage(reply)
    Atomics.store(data.flag, 0, 1)
    Atomics.notify(data.flag, 0)
    noteHeap()
  })
} else {
  // Reads (and index work and imports, each in a worker of its own) open a connection per thread request and close it after, so
  // these workers hold no thread database open between requests.
  const engine = new ThreadDbEngine({ idleCloseMs: 0, checkpointOnClose: false, onOpenCount })
  process.on('exit', () => engine.closeEverything())
  parentPort!.on('message', (request: { id: number; op: string; args: unknown[] }) => {
    try {
      const value = runOp(engine, request.op, request.args)
      parentPort!.postMessage({ id: request.id, ok: true, value })
    } catch (error) {
      parentPort!.postMessage({ id: request.id, ok: false, error: toWireError(error) })
    } finally {
      engine.closeAll()
      noteHeap()
    }
  })
}
