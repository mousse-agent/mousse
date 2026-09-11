import type { Readable, Writable } from 'node:stream'
import { validateBrowserWorkerRequest } from '../../shared/browser/envelope'
import { isBrowserWorkerError } from '../errors'
import { SessionManager, type WorkerInitConfig } from '../session/SessionManager'
import { encodeWorkerFrame, WorkerFrameDecoder } from './framing'
import { CdpDisconnectedError } from '../cdp/connection'

interface PendingCancel {
  controller: AbortController
}

export async function runBrowserWorkerHost(input: Readable, output: Writable): Promise<void> {
  const decoder = new WorkerFrameDecoder()
  const pending = new Map<string, PendingCancel>()
  const runtime: { manager: SessionManager | null } = { manager: null }
  let closing = false

  const write = (value: unknown): Promise<void> =>
    new Promise((resolve, reject) => {
      output.write(encodeWorkerFrame(value), (error) => (error ? reject(error) : resolve()))
    })

  const handleFrame = async (frame: unknown): Promise<void> => {
    if (!frame || typeof frame !== 'object' || Array.isArray(frame)) return
    const record = frame as Record<string, unknown>
    if (record.kind === 'cancel' && typeof record.id === 'string') {
      pending.get(record.id)?.controller.abort('cancelled')
      return
    }
    if (record.kind === 'init') {
      const id = typeof record.id === 'string' ? record.id : 'init'
      try {
        const config: WorkerInitConfig = {
          profileRoot: String(record.profileRoot ?? ''),
          browserRoot: String(record.browserRoot ?? ''),
          artifactRoot: String(record.artifactRoot ?? '')
        }
        if (!config.profileRoot || !config.browserRoot || !config.artifactRoot) throw new Error('init requires profileRoot, browserRoot and artifactRoot')
        runtime.manager = new SessionManager(config)
        await write({ kind: 'init_ok', version: 1, id, capabilities: runtime.manager.report() })
      } catch (error) {
        await write({
          kind: 'init_err', version: 1, id,
          error: { code: 'setup_required', message: error instanceof Error ? error.message : String(error) }
        })
      }
      return
    }
    if (record.kind === 'shutdown') {
      closing = true
      await runtime.manager?.closeAll()
      await write({ kind: 'shutdown_ok', version: 1, id: record.id ?? 'shutdown' })
      return
    }
    let request
    try {
      request = validateBrowserWorkerRequest(frame)
    } catch (error) {
      const id = typeof record.id === 'string' ? record.id : 'invalid'
      await write({ version: 1, id, ok: false, error: { code: 'invalid_action', message: error instanceof Error ? error.message : String(error) } })
      return
    }
    if (!runtime.manager) {
      await write({ version: 1, id: request.id, ok: false, error: { code: 'setup_required', message: 'Worker has not been initialized' } })
      return
    }
    const controller = new AbortController()
    pending.set(request.id, { controller })
    try {
      const result = await runtime.manager.handle(request, controller.signal)
      const responseDelayMs = request.method === 'act' && process.env.MOUSSE_BROWSER_TEST_DELAY_RESPONSE_MS
        ? Math.min(30_000, Math.max(0, Number(process.env.MOUSSE_BROWSER_TEST_DELAY_RESPONSE_MS) || 0))
        : 0
      if (responseDelayMs) await new Promise((resolve) => setTimeout(resolve, responseDelayMs))
      await write({ version: 1, id: request.id, ok: true, result })
    } catch (error) {
      const code = isBrowserWorkerError(error)
        ? error.code
        : error instanceof CdpDisconnectedError
          ? 'worker_disconnected'
          : (error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === 'cancelled')
            ? 'cancelled'
            : 'invalid_action'
      await write({
        version: 1,
        id: request.id,
        ok: false,
        error: { code, message: error instanceof Error ? error.message : String(error) }
      })
    } finally {
      pending.delete(request.id)
    }
  }

  await new Promise<void>((resolve, reject) => {
    input.on('data', (chunk: Buffer) => {
      try {
        decoder.push(chunk)
        for (const frame of decoder.shiftAll()) void handleFrame(frame)
      } catch (error) {
        reject(error)
      }
    })
    input.on('end', () => resolve())
    input.on('error', reject)
    output.on('error', reject)
  })
  if (!closing) await runtime.manager?.closeAll()
}

export async function runBrowserWorkerMain(): Promise<void> {
  await runBrowserWorkerHost(process.stdin, process.stdout)
}
