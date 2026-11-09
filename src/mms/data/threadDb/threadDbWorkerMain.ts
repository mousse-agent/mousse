/**
 * Entry of the thread database workers (`threadDbWorker.js`). The write worker answers one synchronous request at a
 * time through a shared flag and a message port; the read worker answers requests by id. See `threadDbClient.ts`.
 */
import { parentPort, workerData, type MessagePort } from 'node:worker_threads'
import { ThreadDbEngine } from './threadDbEngine'
import { runOp, toWireError } from './threadDbClient'

const data = workerData as { role: 'write'; flag: Int32Array; port: MessagePort } | { role: 'read' }

if (data.role === 'write') {
  const engine = new ThreadDbEngine({ idleCloseMs: 2_000 })
  parentPort!.on('message', (request: { op: string; args: unknown[] }) => {
    let reply: { ok: boolean; value?: unknown; error?: ReturnType<typeof toWireError> }
    try {
      reply = { ok: true, value: runOp(engine, request.op, request.args) }
    } catch (error) {
      reply = { ok: false, error: toWireError(error) }
    }
    data.port.postMessage(reply)
    Atomics.store(data.flag, 0, 1)
    Atomics.notify(data.flag, 0)
  })
} else {
  // Reads open a connection per request and close it after, so this worker holds nothing open between them.
  const engine = new ThreadDbEngine({ idleCloseMs: 0, checkpointOnClose: false })
  parentPort!.on('message', (request: { id: number; op: string; args: unknown[] }) => {
    try {
      const value = runOp(engine, request.op, request.args)
      parentPort!.postMessage({ id: request.id, ok: true, value })
    } catch (error) {
      parentPort!.postMessage({ id: request.id, ok: false, error: toWireError(error) })
    } finally {
      engine.closeAll()
    }
  })
}
