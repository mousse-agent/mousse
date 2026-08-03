/**
 * CLI connection to the authoritative MMS daemon via LocalMmsClient.
 * Starts the daemon when absent; never acquires a competing owner lease.
 */

import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import { existsSync } from 'fs'
import { join } from 'path'
import { LocalMmsClient } from '../mms/protocol/client'
import { resolveDaemonHostInvocation } from './daemonHost'
import {
  canonicalizeHome,
  pollUntilRuntimeReady,
  resolveRuntimeStatus,
  SERVICE_POLL_INTERVAL_MS,
  SERVICE_START_TIMEOUT_MS
} from './mmsRuntime'
import { readOwnerRecord, resolveOwnerStatus } from '../mms/ownership/MmsOwnerLease'
import { resolveLocalEndpoint } from '../mms/protocol/endpoint'
import { resolveMousseHome } from './paths'

export interface DaemonClientOptions {
  homeDir?: string
  /** When true, do not spawn a daemon if missing. */
  disableAutoStart?: boolean
  requestTimeoutMs?: number
}

export interface DaemonClient {
  homeDir: string
  client: LocalMmsClient
  request: <T = unknown>(method: string, params?: unknown) => Promise<T>
  close: () => Promise<void>
}

/**
 * Ensure daemon is ready and return an authenticated LocalMmsClient.
 * Fails clearly if a live foreign owner blocks start, or readiness times out.
 */
export async function connectDaemonClient(
  opts: DaemonClientOptions = {}
): Promise<DaemonClient> {
  const homeDir = canonicalizeHome(resolveMousseHome(opts.homeDir))
  process.env.MOUSSE_HOME = homeDir

  let runtime = resolveRuntimeStatus(homeDir)
  if (!runtime.running || !runtime.record) {
    const owner = resolveOwnerStatus(homeDir)
    if (owner.owned && owner.record && owner.record.pid !== process.pid) {
      // Live owner without runtime — wait briefly for readiness.
      const waited = await pollUntilRuntimeReady(homeDir, {
        timeoutMs: Math.min(SERVICE_START_TIMEOUT_MS, 15_000),
        intervalMs: SERVICE_POLL_INTERVAL_MS
      })
      if (!waited) {
        throw new Error(
          `MMS home is owned by live ${owner.record.kind} process (pid ${owner.record.pid}) but runtime is not ready.`
        )
      }
      runtime = resolveRuntimeStatus(homeDir)
    } else if (!opts.disableAutoStart) {
      await spawnDaemon(homeDir)
      const ready = await pollUntilRuntimeReady(homeDir, {
        timeoutMs: SERVICE_START_TIMEOUT_MS,
        intervalMs: SERVICE_POLL_INTERVAL_MS
      })
      if (!ready) {
        throw new Error(
          `MMS daemon failed to become ready within ${SERVICE_START_TIMEOUT_MS}ms`
        )
      }
      runtime = resolveRuntimeStatus(homeDir)
    } else {
      throw new Error('MMS daemon is not running')
    }
  }

  const owner = readOwnerRecord(homeDir)
  if (!owner?.token) {
    throw new Error('MMS owner token unavailable after readiness')
  }
  const endpoint = owner.endpoint ?? resolveLocalEndpoint(homeDir).path

  const client = new LocalMmsClient({
    homeDir,
    ownerToken: owner.token,
    endpoint,
    clientType: 'cli',
    requestTimeoutMs: opts.requestTimeoutMs
  })
  await client.connect()

  return {
    homeDir,
    client,
    request: (method, params) => client.request(method, params),
    close: () => client.close()
  }
}

async function spawnDaemon(homeDir: string): Promise<void> {
  const candidates = [
    join(process.cwd(), 'out/cli/index.js'),
    join(__dirname, 'index.js'),
    join(__dirname, '../cli/index.js')
  ]
  let scriptPath: string | undefined
  for (const c of candidates) {
    if (existsSync(c)) {
      scriptPath = c
      break
    }
  }
  const host = resolveDaemonHostInvocation(
    scriptPath ??
      (typeof import.meta.url === 'string' ? fileURLToPath(import.meta.url) : undefined)
  )
  const child = spawn(
    host.command,
    [...host.argsPrefix, 'service', 'run', '--home', homeDir],
    {
      detached: true,
      stdio: 'ignore',
      env: { ...host.env, MOUSSE_HOME: homeDir },
      windowsHide: true
    }
  )
  child.unref()
}
