import { NET_LOCAL_CAPABILITY } from '../shared/net/local'
/**
 * CLI connection to the authoritative MMS daemon via LocalMmsClient.
 * Starts the daemon when absent; never acquires a competing owner lease.
 */

import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import { existsSync } from 'fs'
import { join } from 'path'
import { isProtocolVersionMismatch, LocalMmsClient } from '../mms/protocol/client'
import { MMS_PROTOCOL_VERSION } from '../mms/protocol/types'
import { PROFILES_V1_CAPABILITY } from '../shared/profiles/types'
import { WORKFLOW_RUN_CAPABILITY } from '../shared/workflowRunPlatform'
import { BROWSER_SETUP_CAPABILITY } from '../shared/browser/setup'
import { WORKFLOW_DEFINITIONS_CAPABILITY } from '../shared/workflowPlatform'
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
 * What the CLI says when the running service speaks another protocol version (an older or newer
 * Mousse): the same recovery as the app's, stop the service and run again.
 */
export function protocolMismatchText(homeDir: string): string {
  return `The running Mousse service uses another protocol version than this command (${MMS_PROTOCOL_VERSION}). Let active tasks finish, then run mousse-cli service stop --home ${JSON.stringify(homeDir)} (or, from a source checkout, node out/cli/index.js service stop --home ${JSON.stringify(homeDir)}), then run the command again. The service has not been stopped automatically.`
}

/** Connects; a service on another protocol version gets the recovery text instead of the raw refusal. */
export async function connectCliClient(client: LocalMmsClient, homeDir: string): Promise<void> {
  try {
    await client.connect()
  } catch (error) {
    if (isProtocolVersionMismatch(error)) throw new Error(protocolMismatchText(homeDir))
    throw error
  }
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
    requestedCapabilities: [
      NET_LOCAL_CAPABILITY,
      PROFILES_V1_CAPABILITY,
      WORKFLOW_RUN_CAPABILITY,
      WORKFLOW_DEFINITIONS_CAPABILITY,
      BROWSER_SETUP_CAPABILITY
    ],
    requestTimeoutMs: opts.requestTimeoutMs
  })
  await connectCliClient(client, homeDir)

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
