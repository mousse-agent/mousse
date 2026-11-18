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
  SERVICE_POLL_INTERVAL_MS,
  SERVICE_STOP_TIMEOUT_MS,
  sleepAsync,
  writeStopRequest,
  type MmsRuntimeRecord,
  type MmsStopRequest
} from './mmsRuntime'

export type DaemonStopResult =
  | { kind: 'not-running' }
  /** The home is held, but not by a daemon whose token can be read, so no owner-checked stop can be sent. */
  | { kind: 'unreadable' }
  | { kind: 'stopped'; pid: number }
  /** The original daemon stopped but another one owns the home now. */
  | { kind: 'replaced'; pid: number; record: MmsRuntimeRecord }
  | { kind: 'timeout'; pid: number }

/** The daemon a stop is for, and the token that fences the stop request. */
export type DaemonStopTarget =
  | { kind: 'not-running' }
  /** The home is held, but not by a daemon whose token can be read, so no owner-checked stop can be sent. */
  | { kind: 'unreadable' }
  | { kind: 'running'; pid: number; token: string }

/**
 * The ready daemon, or one still starting: a daemon takes the home's owner lease
 * first and publishes its runtime record only once ready, and both carry the same token.
 */
export function resolveDaemonStopTarget(homeDir: string): DaemonStopTarget {
  const status = resolveRuntimeStatus(homeDir)
  if (!status.running) return { kind: 'not-running' }
  if (status.record) return { kind: 'running', pid: status.record.pid, token: status.record.token }
  const owner = status.owner?.owned ? status.owner.record : null
  if (owner?.kind === 'daemon') return { kind: 'running', pid: owner.pid, token: owner.token }
  return { kind: 'unreadable' }
}

/**
 * Writes the fenced stop request and returns without waiting for the daemon to stop.
 * A daemon still starting picks it up as soon as it holds the owner lease and goes no
 * further. `waitForOwnerMs` covers a daemon just started that has not taken the lease
 * yet: the request is sent once it has, or not at all when none takes it in time.
 */
export async function sendDaemonStop(
  homeDir: string,
  opts: { reason?: string; waitForOwnerMs?: number; intervalMs?: number } = {}
): Promise<DaemonStopTarget> {
  const deadline = Date.now() + (opts.waitForOwnerMs ?? 0)
  let target = resolveDaemonStopTarget(homeDir)
  while (target.kind === 'not-running' && Date.now() < deadline) {
    await sleepAsync(opts.intervalMs ?? SERVICE_POLL_INTERVAL_MS)
    target = resolveDaemonStopTarget(homeDir)
  }
  if (target.kind === 'running') requestDaemonShutdown(homeDir, target.token, opts.reason ?? 'client-request')
  return target
}

/**
 * Asks the daemon for `homeDir` to shut down and waits until it has, also while it is
 * still starting. Uses protocol `daemon.shutdown` when the endpoint answers and always
 * writes the fenced stop request as the fallback. Never kills the process or removes
 * its ownership.
 */
export async function stopRunningDaemon(
  homeDir: string,
  opts: { reason?: string; timeoutMs?: number; intervalMs?: number } = {}
): Promise<DaemonStopResult> {
  const reason = opts.reason ?? 'service-stop'
  const target = resolveDaemonStopTarget(homeDir)
  if (target.kind !== 'running') return target
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
  requestDaemonShutdown(homeDir, target.token, reason)
  const result = await pollUntilRuntimeStopped(homeDir, target.token, {
    timeoutMs: opts.timeoutMs ?? SERVICE_STOP_TIMEOUT_MS,
    ...(opts.intervalMs === undefined ? {} : { intervalMs: opts.intervalMs })
  })
  if (result.kind === 'timeout') return { kind: 'timeout', pid: target.pid }
  clearStopRequest(homeDir)
  return result.kind === 'stopped'
    ? { kind: 'stopped', pid: target.pid }
    : { kind: 'replaced', pid: target.pid, record: result.record }
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
  /** A stop was requested. Stays true; startup checks it after each step. */
  shuttingDown: boolean
  /** The latest teardown pass. Every shutdown caller waits for it. */
  teardown?: Promise<void>
}

/**
 * Daemon teardown: stop protocol → stop MMS (scheduler) → runtime record →
 * clear stop request. Safe to call multiple times: each call queues one more
 * pass behind the running one and waits for it, so a later call stops anything
 * startup created after the first pass and every caller returns only once
 * teardown is done.
 */
export function shutdownDaemonLifecycle(
  state: DaemonLifecycleState,
  opts?: {
    reason?: string
    onLog?: (msg: string) => void
  }
): Promise<void> {
  const log = opts?.onLog ?? (() => undefined)
  if (!state.shuttingDown) {
    state.shuttingDown = true
    log(`Shutting down MMS (${opts?.reason ?? 'shutdown'})...`)
  }
  const pass = (state.teardown ?? Promise.resolve()).then(() => tearDownRemaining(state, log))
  state.teardown = pass
  return pass
}

/** Stops every handle still on `state` and clears it. Never throws. */
async function tearDownRemaining(
  state: DaemonLifecycleState,
  log: (msg: string) => void
): Promise<void> {
  if (state.pollStop) {
    clearInterval(state.pollStop)
    state.pollStop = null
  }

  const protocolServer = state.protocolServer
  state.protocolServer = null
  try {
    await protocolServer?.stop()
  } catch (err) {
    log(`protocol stop failed: ${err instanceof Error ? err.message : String(err)}`)
  }

  const mms = state.mms
  state.mms = null
  try {
    await mms?.stop()
  } catch (err) {
    log(`mms.stop failed: ${err instanceof Error ? err.message : String(err)}`)
  }

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
