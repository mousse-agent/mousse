/**
 * Shared daemon shutdown helpers: owner-token-fenced stop request + resource cleanup.
 * Used by protocol `daemon.shutdown` and service stop/run paths.
 */

import type { MousseMainService } from './contract'
import type { MmsProtocolServer } from '../mms/protocol/server'
import {
  clearStopRequest,
  removeOwnRuntimeRecord,
  writeStopRequest,
  type MmsStopRequest
} from './mmsRuntime'

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
