/**
 * Entry of the usage history worker (`usageHistoryWorker.js`). It reads the agents' logs on its own thread, so a
 * first read of many logs never holds up the daemon's other requests. Each message is one history request; the
 * scanner and its cache stay in memory while the worker lives.
 */
import { parentPort, workerData } from 'node:worker_threads'
import { UsageHistoryScanner } from './UsageHistoryScanner'
import type { UsageHistoryRequest } from '../../shared/usageHistory'

const scanner = new UsageHistoryScanner((workerData as { cachePath: string }).cachePath)

parentPort?.on('message', (message: { id: number; request: UsageHistoryRequest }) => {
  scanner.history(message.request).then(
    (value) => parentPort?.postMessage({ id: message.id, ok: true, value }),
    (error: unknown) => parentPort?.postMessage({ id: message.id, ok: false, error: error instanceof Error ? error.message : String(error) })
  )
})
