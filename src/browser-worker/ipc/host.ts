import type { Readable, Writable } from 'node:stream'
import { validateBrowserWorkerRequest } from '../../shared/browser/envelope'
import { isBrowserWorkerError } from '../errors'
import { SessionManager, type WorkerInitConfig } from '../session/SessionManager'
import { encodeWorkerFrame, WorkerFrameDecoder } from './framing'
import { CdpDisconnectedError } from '../cdp/connection'

interface PendingCancel {
  controller: AbortController
  work: Promise<void>
}

const MAX_PENDING_HOST_REQUESTS = 128

export async function runBrowserWorkerHost(input: Readable, output: Writable): Promise<void> {
  const decoder = new WorkerFrameDecoder()
  const pending = new Map<string, PendingCancel>()
  const runtime: { manager: SessionManager | null } = { manager: null }
  let initialized = false
  let closing = false
  let closed = false
  let shutdownWork: Promise<void> | null = null
  const frameHandlers = new Set<Promise<void>>()

  const write = (value: unknown): Promise<void> =>
    new Promise((resolve, reject) => {
      output.write(encodeWorkerFrame(value), (error) => (error ? reject(error) : resolve()))
    })

  const abortAdmitted = (): void => {
    for (const item of pending.values()) {
      try { item.controller.abort('cancelled') } catch { /* already aborted */ }
    }
  }

  const closeManager = async (): Promise<void> => {
    const manager = runtime.manager
    if (!manager) return
    await manager.closeAll()
  }

  const shutdownOnce = async (id: unknown): Promise<void> => {
    closing = true
    abortAdmitted()
    await Promise.allSettled([...pending.values()].map((item) => item.work))
    await closeManager()
    closed = true
    await write({ kind: 'shutdown_ok', version: 1, id: id ?? 'shutdown' })
  }

  const handleFrame = async (frame: unknown): Promise<void> => {
    if (!frame || typeof frame !== 'object' || Array.isArray(frame)) return
    const record = frame as Record<string, unknown>
    if (record.kind === 'cancel' && typeof record.id === 'string') {
      pending.get(record.id)?.controller.abort('cancelled')
      return
    }
    if (record.kind === 'init') {
      const id = typeof record.id === 'string' ? record.id : 'init'
      if (closing || closed) {
        await write({
          kind: 'init_err', version: 1, id,
          error: { code: 'cancelled', message: 'Worker is shutting down' }
        })
        return
      }
      if (initialized || runtime.manager) {
        await write({
          kind: 'init_err', version: 1, id,
          error: { code: 'invalid_action', message: 'Worker is already initialized' }
        })
        return
      }
      try {
        const config: WorkerInitConfig = {
          profileRoot: String(record.profileRoot ?? ''),
          browserRoot: String(record.browserRoot ?? ''),
          artifactRoot: String(record.artifactRoot ?? ''),
          chromeExtraArgs: Array.isArray(record.chromeExtraArgs)
            ? record.chromeExtraArgs.filter((item): item is string => typeof item === 'string')
            : []
        }
        if (!config.profileRoot || !config.browserRoot || !config.artifactRoot) throw new Error('init requires profileRoot, browserRoot and artifactRoot')
        const manager = new SessionManager(config)
        runtime.manager = manager
        initialized = true
        await write({ kind: 'init_ok', version: 1, id, capabilities: manager.report() })
      } catch (error) {
        runtime.manager = null
        initialized = false
        await write({
          kind: 'init_err', version: 1, id,
          error: { code: 'setup_required', message: error instanceof Error ? error.message : String(error) }
        })
      }
      return
    }
    if (record.kind === 'shutdown') {
      if (!shutdownWork) {
        shutdownWork = shutdownOnce(record.id)
        await shutdownWork
        return
      }
      await shutdownWork
      try { await write({ kind: 'shutdown_ok', version: 1, id: record.id ?? 'shutdown' }) } catch { /* stream may already be ended */ }
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
    if (closing || closed) {
      await write({ version: 1, id: request.id, ok: false, error: { code: 'cancelled', message: 'Worker is shutting down' } })
      return
    }
    if (!runtime.manager) {
      await write({ version: 1, id: request.id, ok: false, error: { code: 'setup_required', message: 'Worker has not been initialized' } })
      return
    }
    if (pending.has(request.id)) {
      return
    }
    if (pending.size >= MAX_PENDING_HOST_REQUESTS) {
      await write({ version: 1, id: request.id, ok: false, error: { code: 'invalid_action', message: 'Too many in-flight browser worker requests' } })
      return
    }
    const controller = new AbortController()
    const work = (async () => {
      try {
        const result = await runtime.manager!.handle(request, controller.signal)
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
    })()
    pending.set(request.id, { controller, work })
    await work
  }

  let handlerError: Error | undefined
  const trackFrame = (frame: unknown): void => {
    const work = handleFrame(frame).catch((error) => {
      handlerError = error instanceof Error ? error : new Error(String(error))
    })
    frameHandlers.add(work)
    void work.finally(() => frameHandlers.delete(work))
  }

  let streamError: Error | undefined
  await new Promise<void>((resolve, reject) => {
    input.on('data', (chunk: Buffer) => {
      try {
        decoder.push(chunk)
        for (const frame of decoder.shiftAll()) trackFrame(frame)
      } catch (error) {
        streamError = error instanceof Error ? error : new Error(String(error))
        reject(streamError)
      }
    })
    input.on('end', () => resolve())
    input.on('error', reject)
    output.on('error', reject)
  })
  await Promise.allSettled([...frameHandlers])
  if (!closing && !closed) {
    closing = true
    abortAdmitted()
    await Promise.allSettled([...pending.values()].map((item) => item.work))
    await closeManager()
    closed = true
  } else if (shutdownWork) {
    await shutdownWork
  }
  if (streamError) throw streamError
  if (handlerError) throw handlerError
}

export async function runBrowserWorkerMain(): Promise<void> {
  await runBrowserWorkerHost(process.stdin, process.stdout)
}
