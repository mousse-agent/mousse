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
  uninstallMmsStartup
} from '../serviceLocator'
import { installServiceEntry } from '../serviceInstall'
import {
  canonicalizeHome,
  DAEMON_OWNER_TOKEN_ENV,
  pollUntilRuntimeReady,
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
  createOwnerToken,
  formatOwnerBusyMessage,
  MmsOwnerBusyError,
  resolveOwnerStatus
} from '../../mms/ownership/MmsOwnerLease'
import { installDaemonDiagnostics } from '../daemonDiagnostics'
import { capDaemonStartupOutput } from '../startupLog'
import { installElectronDaemonQuit } from '../electronDaemonLifetime'
import { resolveDaemonHostInvocation } from '../daemonHost'
import { dropForeignAppImageMounts } from '../appImageMounts'
import { MmsProtocolServer } from '../../mms/protocol'
import { prepareMemoryMonitor } from '../../mms/diagnostics/startMemoryMonitor'
import { remoteUpdatesFor } from '../../mms/updates/remoteUpdates'
import { registerRemoteUpdateMethods } from '../../mms/updates/registerRemoteUpdateMethods'
import { formatStartupTiming, startupPhase, startupTimingBegin, startupTimingEnd } from '../../mms/startup/startupTiming'
import { logInfo } from '../../mms/log/diag'
import { startDaemonExitWatchdog } from '../daemonExitWatchdog'
import { resumeGitSpawnWorkers } from '../../mms/git/gitSpawn'
import {
  DAEMON_EXIT_DEADLINE_MS,
  armDaemonExitDeadline,
  stopRunningDaemon,
  shutdownDaemonLifecycle,
  type DaemonLifecycleState
} from '../daemonShutdown'

/**
 * How much longer than the main thread's exit deadline the watchdog thread waits, so the ordinary
 * shutdown always gets the first chance to finish.
 */
const EXIT_WATCHDOG_SLACK_MS = 3_000

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
      await installService(globals.homeDir || undefined, globals.mode, args.flags.has('headless'))
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
  /** Test inject: aborting it stops the daemon like a signal would. */
  stopSignal?: AbortSignal
  /**
   * The owner token to take the home with, chosen by whoever started the daemon so it can send a
   * stop before the lease exists. A new one when unset.
   */
  ownerToken?: string
  /** Test inject: overrides the drain's retry delay and stuck deadline (see `DaemonLifecycleState.drainWait`). */
  drainWait?: DaemonLifecycleState['drainWait']
  /**
   * How the process ends when it outlives `DAEMON_EXIT_DEADLINE_MS` after a stop. The production daemon
   * exits the process; tests (`skipSignals`) have no deadline unless they pass one.
   */
  exitDeadline?: { ms?: number; exit: (code: number) => void }
  onLog?: (msg: string) => void
}

/**
 * Foreground daemon lifetime. Resolves after awaited cleanup (sets process.exitCode).
 * Every failure after owner/MMS creation uses the same idempotent shutdown path.
 */
export async function runDaemonForeground(opts: DaemonForegroundOptions): Promise<DaemonLifecycleState> {
  await resumeGitSpawnWorkers()
  const homeDir = canonicalizeHome(opts.homeDir)
  const startedAt = new Date().toISOString()
  const startedAtMs = performance.now()
  // Each step until ready is timed and logged at ready (`[info:startup]`), so a slow start shows where its time went.
  startupTimingBegin()
  const log = opts.onLog ?? ((msg: string) => process.stderr.write(`${msg}\n`))

  let resolveLifetime!: () => void
  const lifetime = new Promise<void>((resolve) => {
    resolveLifetime = resolve
  })

  const state: DaemonLifecycleState = {
    homeDir,
    mms: null,
    protocolServer: null,
    // Known from the start, so a stop request is read before the owner lease exists.
    ownerToken: opts.ownerToken ?? createOwnerToken(),
    runtimeWritten: false,
    pollStop: null,
    shuttingDown: false,
    ...(opts.drainWait ? { drainWait: opts.drainWait } : {})
  }
  const ownerToken = state.ownerToken!
  const exitDeadline = opts.exitDeadline ?? (opts.skipSignals ? undefined : { exit: (code: number) => process.exit(code) })
  // The production daemon's deadline also runs off the main thread, where a long synchronous pass cannot hold it up.
  const watchdog = opts.skipSignals
    ? null
    : startDaemonExitWatchdog({ homeDir, ownerToken, ms: (exitDeadline?.ms ?? DAEMON_EXIT_DEADLINE_MS) + EXIT_WATCHDOG_SLACK_MS })

  let memoryMonitor: ReturnType<typeof prepareMemoryMonitor> = null
  const shutdown = async (reason: string, exitCode = 0): Promise<void> => {
    memoryMonitor?.stop()
    memoryMonitor = null
    watchdog?.arm()
    if (state.shuttingDown) {
      // Already stopping: wait for teardown (and stop anything startup made since).
      await shutdownDaemonLifecycle(state)
      return
    }
    // Once asked to stop, the process ends within the deadline, even if a teardown step never answers.
    if (exitDeadline) {
      armDaemonExitDeadline(state, {
        ...(exitDeadline.ms === undefined ? {} : { ms: exitDeadline.ms }),
        exit: () => exitDeadline.exit(exitCode),
        onLog: (msg) => log(`\n${msg}`)
      })
    }
    await shutdownDaemonLifecycle(state, {
      reason,
      onLog: (msg) => log(`\n${msg}`)
    })
    process.exitCode = exitCode
    resolveLifetime()
  }
  let releaseElectronQuit: (() => void) | undefined
  opts.stopSignal?.addEventListener('abort', () => void shutdown('stop-signal'), { once: true })

  // Production daemon only (tests pass skipSignals): persist diagnostics and
  // register crash handlers. Handlers are never installed by library modules.
  if (!opts.skipSignals) {
    // The unit sets this for a headless Electron build, which Chromium has already read at startup.
    // Dropping it keeps terminals, agents and tools the daemon starts from inheriting it, so any
    // Electron app they launch keeps its renderer sandbox.
    delete process.env.ELECTRON_DISABLE_SANDBOX
    installDaemonDiagnostics({ homeDir, shutdown })
    process.on('SIGINT', () => {
      void shutdown('SIGINT')
    })
    process.on('SIGTERM', () => {
      void shutdown('SIGTERM')
    })
  }

  // A stop request for this daemon starts the shutdown. Read from the start, so a stop
  // sent while startup still runs is not left waiting for readiness.
  const checkStopRequest = (): void => {
    if (state.shuttingDown) return
    if (!readStopRequest(homeDir, ownerToken)) return
    void shutdown('stop-request')
  }

  // A stop that arrives while startup is still running: stop what startup has
  // made so far and go no further.
  const stoppedDuringStartup = async (): Promise<boolean> => {
    checkStopRequest()
    if (!state.shuttingDown) return false
    await shutdownDaemonLifecycle(state)
    return true
  }

  // Teardown clears it.
  state.pollStop = setInterval(checkStopRequest, SERVICE_POLL_INTERVAL_MS)

  try {
    // A stop can arrive while startup is waiting for the previous daemon's Git helpers to drain.
    if (opts.stopSignal?.aborted) {
      await shutdown('stop-signal')
      return state
    }
    // Before owner creation, so an Electron quit during startup is held too.
    if (!opts.skipSignals) {
      releaseElectronQuit = await installElectronDaemonQuit(shutdown, error => {
        log(
          `Electron daemon shutdown failed: ${error instanceof Error ? error.message : String(error)}`
        )
      })
    }
    // A stop sent before this daemon took the home: it never takes it.
    if (await stoppedDuringStartup()) return state

    // Sole production owner construction path (kind: daemon).
    const opened = await startupPhase('create', () => createDaemonOwner(
      {
        homeDir,
        mode: 'text'
      },
      { start: false, ownerToken }
    ))
    // A stop that came while the owner was being created skips the start. One that comes
    // during the start waits for it: teardown stops the owner only once it is on `state`.
    try {
      if (!(await stoppedDuringStartup())) await startupPhase('start', () => opened.mms.start())
    } finally {
      state.mms = opened.mms
    }
    if (await stoppedDuringStartup()) return state
    if (opened.mms.getOwnerLease()?.owner.token !== ownerToken) {
      throw new Error('Daemon started without owner lease')
    }

    // Protocol server after MMS start; publish endpoint on owner then readiness.
    const protocolServer = new MmsProtocolServer({
      mms: opened.mms,
      commandRouter: opened.mms.browserCommandRouter,
      ownerToken,
      version: tryReadPackageVersion()
    })
    state.protocolServer = protocolServer
    // Production daemon only: its methods are registered before the server seals its method list.
    if (!opts.skipSignals) {
      try {
        memoryMonitor = prepareMemoryMonitor({ mms: opened.mms, protocolServer, homeDir, version: process.env.MOUSSE_VERSION || tryReadPackageVersion() || 'unknown' })
      } catch (error) {
        log(`memory monitor not started: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    // Update requests from the user's other computers: the desktop app takes them on its own connection.
    if (opened.mms.domains) {
      const domains = opened.mms.domains
      registerRemoteUpdateMethods(domains, remoteUpdatesFor(homeDir), {
        emit: (type, data) => protocolServer.emitInstallationEvent(type, data),
        activeTurns: () =>
          (opened.mms.getInstallationHost()?.liveServices() ?? [opened.mms]).reduce(
            (sum, services) => sum + services.orchestrator.activeTurnCount(),
            0
          )
      })
    }
    const endpoint = await startupPhase('protocolServer', () => protocolServer.start())
    if (await stoppedDuringStartup()) return state
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
        ownerToken,
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

    const startupMs = performance.now() - startedAtMs
    log(
      `Mousse MMS running (headless) — home: ${homeDir} pid: ${process.pid} owner=daemon endpoint=${endpoint} startup=${Math.round(startupMs)}ms`
    )
    const timing = startupTimingEnd()
    if (timing) logInfo('startup', formatStartupTiming(timing, startupMs))

    memoryMonitor?.start()
    // Work that must not delay readiness starts now, in the background.
    opened.mms.afterReady()

    await lifetime
    return state
  } catch (err) {
    if (err instanceof MmsOwnerBusyError) {
      log(formatOwnerBusyMessage(err.owner, err.heldUnreadable))
      // No MMS created, or create threw before assignment — still cleanup if any.
      await shutdown('owner-busy', 1)
      return state
    }
    // A stop during startup can make a startup step fail (the protocol server
    // refuses to listen once stopped). That is the stop finishing, not a failure.
    if (await stoppedDuringStartup()) return state
    const message = err instanceof Error ? err.message : String(err)
    log(`MMS failed to start: ${message}`)
    // CRITICAL: any failure after owner/MMS creation must tear down fully.
    await shutdown('startup-failed', 1)
    return state
  } finally {
    startupTimingEnd()
    releaseElectronQuit?.()
  }
}

async function runForeground(homeFlag?: string): Promise<void> {
  // Started by the app, whose startup log takes stdout and stderr for the daemon's whole life: keep it bounded.
  capDaemonStartupOutput()
  // Before anything starts a program: the app that started the service may quit and take its mount with it.
  dropForeignAppImageMounts()
  // The window client that started this daemon chose its owner token (`DAEMON_OWNER_TOKEN_ENV`).
  // Dropped here so nothing the daemon starts inherits it.
  const chosen = process.env[DAEMON_OWNER_TOKEN_ENV]
  delete process.env[DAEMON_OWNER_TOKEN_ENV]
  await runDaemonForeground({
    homeDir: resolveMousseHome(homeFlag),
    ...(chosen && /^[0-9a-f]{64}$/.test(chosen) ? { ownerToken: chosen } : {})
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
      // eslint-disable-next-line mousse/no-console-window -- The daemon outlives the CLI. Its host is Electron as Node, a GUI program with no console that starts plain spawns hidden.
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
  const result = await stopRunningDaemon(homeDir, {
    reason: 'service-stop',
    timeoutMs: SERVICE_STOP_TIMEOUT_MS,
    intervalMs: SERVICE_POLL_INTERVAL_MS
  })
  switch (result.kind) {
    case 'not-running':
      exitWithError('MMS is not running.', mode)
      return
    case 'unreadable':
      exitWithError('MMS home is held but its owner cannot be read; cannot send owner-checked stop request.', mode)
      return
    case 'stopped':
      writeOutput(mode, { stopped: true, pid: result.pid, running: false })
      return
    case 'replaced':
      // Accurate: original stopped/replaced, but MMS is still running under a new owner.
      writeOutput(mode, {
        stopped: false,
        originalPid: result.pid,
        running: true,
        pid: result.record.pid,
        processInstanceId: result.record.processInstanceId,
        note: 'Original instance no longer owns runtime; a replacement MMS is still running'
      })
      return
    case 'timeout':
      // Do not hard-kill or remove ownership.
      exitWithError(
        `MMS stop timed out after ${SERVICE_STOP_TIMEOUT_MS}ms (pid ${result.pid} still running). Ownership left in place.`,
        mode
      )
  }
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
  mode: ParsedArgs['globals']['mode'],
  headless: boolean
): Promise<void> {
  const homeDir = canonicalizeHome(resolveMousseHome(homeFlag))

  await installServiceEntry({
    homeDir,
    headless,
    scriptPath: process.argv[1] ?? fileURLToPath(import.meta.url)
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
