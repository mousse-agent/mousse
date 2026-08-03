import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import type { ParsedArgs } from '../parseArgs'
import { exitWithError, writeOutput } from '../output'
import { createDaemonOwner } from '../daemonOwner'
import { resolveMousseHome } from '../paths'
import { SERVICE_HELP } from '../help'
import {
  detectStartupPlatform,
  getMmsStartupStatus,
  installMmsStartup,
  uninstallMmsStartup
} from '../serviceLocator'
import { resolveCliPathForInstall } from '../cliLaunch'
import {
  canonicalizeHome,
  clearStopRequest,
  pollUntilRuntimeReady,
  pollUntilRuntimeStopped,
  publishOwnRuntimeRecord,
  readStopRequest,
  removeOwnRuntimeRecord,
  resolveRuntimeStatus,
  RuntimeOwnershipError,
  SERVICE_POLL_INTERVAL_MS,
  SERVICE_START_TIMEOUT_MS,
  SERVICE_STOP_TIMEOUT_MS
} from '../mmsRuntime'
import {
  formatOwnerBusyMessage,
  MmsOwnerBusyError,
  readOwnerRecord,
  resolveOwnerStatus
} from '../../mms/ownership/MmsOwnerLease'
import { resolveDaemonHostInvocation } from '../daemonHost'
import { MmsProtocolServer } from '../../mms/protocol'
import {
  requestDaemonShutdown,
  shutdownDaemonLifecycle,
  type DaemonLifecycleState
} from '../daemonShutdown'

export async function runService(args: ParsedArgs): Promise<void> {
  const { globals, subcommand } = args

  if (!subcommand || subcommand === 'help' || globals.help) {
    process.stdout.write(SERVICE_HELP)
    return
  }

  switch (subcommand) {
    case 'run':
      await runForeground(globals.homeDir || undefined)
      break
    case 'start':
      await startDaemon(globals.homeDir || undefined, globals.mode)
      break
    case 'stop':
      await stopDaemon(globals.homeDir || undefined, globals.mode)
      break
    case 'status':
      await showStatus(globals.homeDir || undefined, globals.mode)
      break
    case 'install':
      await installService(globals.homeDir || undefined, globals.mode)
      break
    case 'uninstall':
      await uninstallService(globals.mode)
      break
    default:
      exitWithError(`Unknown service subcommand: ${subcommand}`, globals.mode)
  }
}

export interface DaemonForegroundOptions {
  homeDir: string
  /** Test inject: fail after protocol server construction / start. */
  failAfter?: 'protocol-start' | 'set-endpoint' | 'runtime-publish'
  /** When true, do not register SIGINT/SIGTERM (tests). */
  skipSignals?: boolean
  onLog?: (msg: string) => void
}

/**
 * Foreground daemon lifetime. Resolves after awaited cleanup (sets process.exitCode).
 * Every failure after owner/MMS creation uses the same idempotent shutdown path.
 */
export async function runDaemonForeground(opts: DaemonForegroundOptions): Promise<DaemonLifecycleState> {
  const homeDir = canonicalizeHome(opts.homeDir)
  const startedAt = new Date().toISOString()
  const log = opts.onLog ?? ((msg: string) => process.stderr.write(`${msg}\n`))

  let resolveLifetime!: () => void
  const lifetime = new Promise<void>((resolve) => {
    resolveLifetime = resolve
  })

  const state: DaemonLifecycleState = {
    homeDir,
    mms: null,
    protocolServer: null,
    ownerToken: null,
    runtimeWritten: false,
    pollStop: null,
    shuttingDown: false
  }

  const shutdown = async (reason: string, exitCode = 0): Promise<void> => {
    if (state.shuttingDown) return
    await shutdownDaemonLifecycle(state, {
      reason,
      onLog: (msg) => log(`\n${msg}`)
    })
    process.exitCode = exitCode
    resolveLifetime()
  }

  if (!opts.skipSignals) {
    process.on('SIGINT', () => {
      void shutdown('SIGINT')
    })
    process.on('SIGTERM', () => {
      void shutdown('SIGTERM')
    })
  }

  try {
    // Sole production owner construction path (kind: daemon).
    const opened = await createDaemonOwner(
      {
        homeDir,
        mode: 'text'
      },
      { start: true }
    )
    state.mms = opened.mms
    state.ownerToken = opened.mms.getOwnerLease()?.owner.token ?? null
    if (!state.ownerToken) {
      throw new Error('Daemon started without owner lease')
    }

    // Protocol server after MMS start; publish endpoint on owner then readiness.
    state.protocolServer = new MmsProtocolServer({
      mms: opened.mms,
      ownerToken: state.ownerToken,
      version: tryReadPackageVersion()
    })
    const endpoint = await state.protocolServer.start()
    if (opts.failAfter === 'protocol-start') {
      throw new Error('Injected protocol-start failure')
    }
    const lease = opened.mms.getOwnerLease()
    if (!lease?.setEndpoint(endpoint) || opts.failAfter === 'set-endpoint') {
      throw new Error(
        opts.failAfter === 'set-endpoint'
          ? 'Injected set-endpoint failure'
          : 'Failed to publish protocol endpoint on owner lease'
      )
    }

    try {
      if (opts.failAfter === 'runtime-publish') {
        throw new RuntimeOwnershipError('Injected runtime-publish failure')
      }
      publishOwnRuntimeRecord(homeDir, {
        ownerToken: state.ownerToken,
        startedAt,
        version: tryReadPackageVersion(),
        ownerKind: 'daemon'
      })
      state.runtimeWritten = true
    } catch (err) {
      if (err instanceof RuntimeOwnershipError) {
        log(err.message)
        await shutdown('runtime-publish-failed', 1)
        return state
      }
      throw err
    }

    log(
      `Mousse MMS running (headless) — home: ${homeDir} pid: ${process.pid} owner=daemon endpoint=${endpoint}`
    )

    state.pollStop = setInterval(() => {
      if (state.shuttingDown) return
      const req = readStopRequest(homeDir)
      if (!req) return
      if (req.token !== state.ownerToken) return
      void shutdown('stop-request')
    }, SERVICE_POLL_INTERVAL_MS)

    await lifetime
    return state
  } catch (err) {
    if (err instanceof MmsOwnerBusyError) {
      log(formatOwnerBusyMessage(err.owner, err.heldUnreadable))
      // No MMS created, or create threw before assignment — still cleanup if any.
      await shutdown('owner-busy', 1)
      return state
    }
    const message = err instanceof Error ? err.message : String(err)
    log(`MMS failed to start: ${message}`)
    // CRITICAL: any failure after owner/MMS creation must tear down fully.
    await shutdown('startup-failed', 1)
    return state
  }
}

async function runForeground(homeFlag?: string): Promise<void> {
  await runDaemonForeground({
    homeDir: resolveMousseHome(homeFlag)
  })
}

async function startDaemon(
  homeFlag: string | undefined,
  mode: ParsedArgs['globals']['mode']
): Promise<void> {
  const homeDir = canonicalizeHome(resolveMousseHome(homeFlag))

  const owner = resolveOwnerStatus(homeDir)
  if (owner.owned) {
    exitWithError(formatOwnerBusyMessage(owner.record, owner.heldUnreadable), mode)
  }

  const existing = resolveRuntimeStatus(homeDir)
  if (existing.running && existing.record) {
    exitWithError(
      `MMS already running (pid ${existing.record.pid})`,
      mode
    )
  }

  const host = resolveDaemonHostInvocation(fileURLToPath(import.meta.url))
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

  // Do NOT record child.pid as the daemon pid (may be cmd.exe on Windows).
  const record = await pollUntilRuntimeReady(homeDir, {
    timeoutMs: SERVICE_START_TIMEOUT_MS,
    intervalMs: SERVICE_POLL_INTERVAL_MS,
    isAborted: () => child.exitCode !== null && child.exitCode !== 0
  })

  if (record) {
    writeOutput(mode, {
      started: true,
      pid: record.pid,
      processInstanceId: record.processInstanceId,
      home: homeDir,
      readyAt: record.readyAt,
      version: record.version,
      protocolVersion: record.protocolVersion,
      ownerKind: record.ownerKind,
      hostMode: host.mode,
      hostReason: host.reason
    })
    return
  }

  if (child.exitCode !== null && child.exitCode !== 0) {
    exitWithError(`MMS daemon exited before readiness (code ${child.exitCode})`, mode)
  }

  exitWithError(
    `MMS failed to become ready within ${SERVICE_START_TIMEOUT_MS}ms (launcher spawn pid ${child.pid ?? 'unknown'} is not the daemon ownership pid)`,
    mode
  )
}

async function stopDaemon(
  homeFlag: string | undefined,
  mode: ParsedArgs['globals']['mode']
): Promise<void> {
  const homeDir = canonicalizeHome(resolveMousseHome(homeFlag))
  const status = resolveRuntimeStatus(homeDir)

  if (!status.running) {
    exitWithError('MMS is not running.', mode)
  }
  if (!status.record) {
    // Held unreadable — cannot issue token-checked stop.
    exitWithError(
      'MMS runtime is present but unreadable; cannot send owner-checked stop request.',
      mode
    )
  }

  const record = status.record!
  // Prefer protocol graceful shutdown when endpoint is reachable; keep stop-file fallback.
  try {
    const owner = readOwnerRecord(homeDir)
    if (owner?.token && owner.endpoint) {
      const { LocalMmsClient } = await import('../../mms/protocol/client')
      const client = new LocalMmsClient({
        homeDir,
        ownerToken: owner.token,
        endpoint: owner.endpoint,
        clientType: 'cli',
        requestTimeoutMs: 5_000
      })
      try {
        await client.connect()
        await client.request('daemon.shutdown', { reason: 'service-stop' })
      } finally {
        await client.close().catch(() => undefined)
      }
    }
  } catch {
    /* fall through to stop-file */
  }
  // Same fenced stop request as protocol daemon.shutdown (compatibility path).
  requestDaemonShutdown(homeDir, record.token, 'service-stop')

  const result = await pollUntilRuntimeStopped(homeDir, record.token, {
    timeoutMs: SERVICE_STOP_TIMEOUT_MS,
    intervalMs: SERVICE_POLL_INTERVAL_MS
  })

  if (result.kind === 'stopped') {
    clearStopRequest(homeDir)
    writeOutput(mode, { stopped: true, pid: record.pid, running: false })
    return
  }

  if (result.kind === 'replaced') {
    clearStopRequest(homeDir)
    // Accurate: original stopped/replaced, but MMS is still running under a new owner.
    writeOutput(mode, {
      stopped: false,
      originalPid: record.pid,
      running: true,
      pid: result.record.pid,
      processInstanceId: result.record.processInstanceId,
      note: 'Original instance no longer owns runtime; a replacement MMS is still running'
    })
    return
  }

  // Timeout: do not hard-kill or remove ownership.
  exitWithError(
    `MMS stop timed out after ${SERVICE_STOP_TIMEOUT_MS}ms (pid ${record.pid} still running). Ownership left in place.`,
    mode
  )
}

async function showStatus(
  homeFlag: string | undefined,
  mode: ParsedArgs['globals']['mode']
): Promise<void> {
  const homeDir = canonicalizeHome(resolveMousseHome(homeFlag))
  const status = resolveRuntimeStatus(homeDir)
  const startup = await getMmsStartupStatus()
  const platform = await detectStartupPlatform()

  const owner = resolveOwnerStatus(homeDir)
  const host = resolveDaemonHostInvocation(fileURLToPath(import.meta.url))
  writeOutput(mode, {
    running: status.running || owner.owned,
    ready: Boolean(status.record),
    pid: status.record?.pid ?? owner.record?.pid ?? null,
    processInstanceId:
      status.record?.processInstanceId ?? owner.record?.processInstanceId ?? null,
    ownerKind: owner.record?.kind ?? status.record?.ownerKind ?? null,
    protocolVersion: owner.record?.protocolVersion ?? status.record?.protocolVersion ?? null,
    version: owner.record?.version ?? status.record?.version ?? null,
    readyAt: status.record?.readyAt ?? null,
    home: homeDir,
    staleRemoved: status.staleRemoved,
    heldUnreadable: status.heldUnreadable ?? owner.heldUnreadable,
    owner: owner.record
      ? {
          kind: owner.record.kind,
          pid: owner.record.pid,
          protocolVersion: owner.record.protocolVersion,
          version: owner.record.version ?? null
        }
      : null,
    startup,
    platform,
    host: {
      mode: host.mode,
      reason: host.reason,
      nodePtyOk: host.nodePtyOk
    }
  })
}

async function installService(
  homeFlag: string | undefined,
  mode: ParsedArgs['globals']['mode']
): Promise<void> {
  const homeDir = canonicalizeHome(resolveMousseHome(homeFlag))

  await installMmsStartup({
    cliPath: resolveCliPathForInstall(process.argv[1] ?? fileURLToPath(import.meta.url)),
    homeDir
  })
  const status = await getMmsStartupStatus()
  writeOutput(mode, { ...status, installed: true })
}

async function uninstallService(mode: ParsedArgs['globals']['mode']): Promise<void> {
  await uninstallMmsStartup()
  const status = await getMmsStartupStatus()
  writeOutput(mode, { ...status, installed: false })
}

function tryReadPackageVersion(): string | undefined {
  try {
    return process.env.npm_package_version ?? undefined
  } catch {
    return undefined
  }
}
