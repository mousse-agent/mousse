/**
 * Shared daemon shutdown helpers: owner-token-fenced stop request + resource cleanup.
 * Used by protocol `daemon.shutdown` and service stop/run paths.
 */

import type { MousseMainService } from './contract'
import type { MmsProtocolServer } from '../mms/protocol/server'
import { readOwnerRecord } from '../mms/ownership/MmsOwnerLease'
import {
  clearStopRequest,
  pollUntilRuntimeStopped,
  removeOwnRuntimeRecord,
  resolveRuntimeStatus,
  SERVICE_STOP_TIMEOUT_MS,
  writeStopRequest,
  type MmsRuntimeRecord,
  type MmsStopRequest
} from './mmsRuntime'

export type DaemonStopResult =
  | { kind: 'not-running' }
  /** The runtime file exists but cannot be read, so no owner-checked stop can be sent. */
  | { kind: 'unreadable' }
  | { kind: 'stopped'; pid: number }
  /** The original daemon stopped but another one owns the home now. */
  | { kind: 'replaced'; pid: number; record: MmsRuntimeRecord }
  | { kind: 'timeout'; pid: number }

/**
 * Asks the daemon for `homeDir` to shut down and waits until it has. Uses protocol
 * `daemon.shutdown` when the endpoint answers and always writes the fenced stop request
 * as the fallback. Never kills the process or removes its ownership.
 */
export async function stopRunningDaemon(
  homeDir: string,
  opts: { reason?: string; timeoutMs?: number; intervalMs?: number } = {}
): Promise<DaemonStopResult> {
  const reason = opts.reason ?? 'service-stop'
  const status = resolveRuntimeStatus(homeDir)
  if (!status.running) return { kind: 'not-running' }
  if (!status.record) return { kind: 'unreadable' }
  const record = status.record
  try {
    const owner = readOwnerRecord(homeDir)
    if (owner?.token && owner.endpoint) {
      const { LocalMmsClient } = await import('../mms/protocol/client')
      const client = new LocalMmsClient({
        homeDir,
        ownerToken: owner.token,
        endpoint: owner.endpoint,
        clientType: 'cli',
        requestTimeoutMs: 5_000
      })
      try {
        await client.connect()
        await client.request('daemon.shutdown', { reason })
      } finally {
        await client.close().catch(() => undefined)
      }
    }
  } catch {
    /* fall through to the stop request */
  }
  requestDaemonShutdown(homeDir, record.token, reason)
  const result = await pollUntilRuntimeStopped(homeDir, record.token, {
    timeoutMs: opts.timeoutMs ?? SERVICE_STOP_TIMEOUT_MS,
    ...(opts.intervalMs === undefined ? {} : { intervalMs: opts.intervalMs })
  })
  if (result.kind === 'timeout') return { kind: 'timeout', pid: record.pid }
  clearStopRequest(homeDir)
  return result.kind === 'stopped'
    ? { kind: 'stopped', pid: record.pid }
    : { kind: 'replaced', pid: record.pid, record: result.record }
}

/** Write an owner-token-fenced stop request. Single source of truth for graceful stop signaling. */
export function requestDaemonShutdown(
  homeDir: string,
  ownerToken: string,
  reason = 'client-request'
): { accepted: true; reason: string; stopRequest: MmsStopRequest } {
  if (!ownerToken || !ownerToken.trim()) {
    throw new Error('owner token required for daemon shutdown')
  }
  const stopRequest = writeStopRequest(homeDir, ownerToken)
  return { accepted: true, reason, stopRequest }
}

export interface DaemonLifecycleState {
  homeDir: string
  mms: MousseMainService | null
  protocolServer: MmsProtocolServer | null
  ownerToken: string | null
  runtimeWritten: boolean
  pollStop: ReturnType<typeof setInterval> | null
  shuttingDown: boolean
}

/**
 * Idempotent daemon teardown: stop protocol → stop MMS (scheduler/channels) →
 * runtime record → clear stop request. Safe to call multiple times.
 */
export async function shutdownDaemonLifecycle(
  state: DaemonLifecycleState,
  opts?: {
    reason?: string
    onLog?: (msg: string) => void
  }
): Promise<void> {
  if (state.shuttingDown) return
  state.shuttingDown = true
  const log = opts?.onLog ?? (() => undefined)
  log(`Shutting down MMS (${opts?.reason ?? 'shutdown'})...`)

  if (state.pollStop) {
    clearInterval(state.pollStop)
    state.pollStop = null
  }

  try {
    if (state.protocolServer) {
      await state.protocolServer.stop()
    }
  } catch (err) {
    log(`protocol stop failed: ${err instanceof Error ? err.message : String(err)}`)
  }
  state.protocolServer = null

  try {
    if (state.mms) {
      await state.mms.stop()
    }
  } catch (err) {
    log(`mms.stop failed: ${err instanceof Error ? err.message : String(err)}`)
  }
  state.mms = null

  if (state.runtimeWritten && state.ownerToken) {
    try {
      removeOwnRuntimeRecord(state.homeDir, state.ownerToken)
    } catch {
      /* best-effort */
    }
    state.runtimeWritten = false
  }

  try {
    clearStopRequest(state.homeDir)
  } catch {
    /* best-effort */
  }
}
