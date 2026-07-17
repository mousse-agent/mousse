import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'fs'
import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import type { ParsedArgs } from '../parseArgs'
import { exitWithError, writeOutput } from '../output'
import { openMms } from '../mmsContext'
import { resolveMousseHome, getMmsPidPath } from '../paths'
import { SERVICE_HELP } from '../help'
import {
  detectStartupPlatform,
  getMmsStartupStatus,
  installMmsStartup,
  uninstallMmsStartup
} from '../serviceLocator'
import { resolveCliInvocation, resolveCliPathForInstall } from '../cliLaunch'

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
      await startDaemon(globals.homeDir || undefined)
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

async function runForeground(homeFlag?: string): Promise<void> {
  const { homeDir, mms } = await openMms(
    {
      homeDir: homeFlag ?? '',
      mode: 'text',
      print: false,
      continueSession: false,
      version: false,
      help: false
    },
    true
  )

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    process.stderr.write(`\nReceived ${signal}, shutting down MMS...\n`)
    await mms.stop()
    process.exit(0)
  }

  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))

  process.stderr.write(`Mousse MMS running (headless) — home: ${homeDir}\n`)
  await new Promise<void>(() => {})
}

async function startDaemon(homeFlag?: string): Promise<void> {
  const homeDir = resolveMousseHome(homeFlag)

  const pidPath = getMmsPidPath(homeDir)
  if (existsSync(pidPath)) {
    const existing = Number(readFileSync(pidPath, 'utf-8').trim())
    if (existing && isProcessRunning(existing)) {
      exitWithError(`MMS already running (pid ${existing})`, 'text')
    }
  }

  const inv = resolveCliInvocation(fileURLToPath(import.meta.url))
  const child = spawn(
    inv.command,
    [...inv.argsPrefix, 'service', 'run', '--home', homeDir],
    {
      detached: true,
      stdio: 'ignore',
      env: { ...inv.env, MOUSSE_HOME: homeDir },
      windowsHide: true
    }
  )
  child.unref()
  writeFileSync(pidPath, String(child.pid), 'utf-8')
  writeOutput('text', { started: true, pid: child.pid, pidfile: pidPath })
}

async function stopDaemon(homeFlag: string | undefined, mode: ParsedArgs['globals']['mode']): Promise<void> {
  const homeDir = resolveMousseHome(homeFlag)

  const pidPath = getMmsPidPath(homeDir)
  if (!existsSync(pidPath)) {
    exitWithError('MMS is not running (no pidfile).', mode)
  }

  const pid = Number(readFileSync(pidPath, 'utf-8').trim())
  if (!pid || !isProcessRunning(pid)) {
    unlinkSync(pidPath)
    exitWithError('MMS is not running (stale pidfile removed).', mode)
  }

  try {
    process.kill(pid)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    exitWithError(`Failed to stop MMS (pid ${pid}): ${message}`, mode)
  }

  unlinkSync(pidPath)
  writeOutput(mode, { stopped: true, pid })
}

async function showStatus(homeFlag: string | undefined, mode: ParsedArgs['globals']['mode']): Promise<void> {
  const homeDir = resolveMousseHome(homeFlag)

  const pidPath = getMmsPidPath(homeDir)
  let running = false
  let pid: number | null = null

  if (existsSync(pidPath)) {
    pid = Number(readFileSync(pidPath, 'utf-8').trim())
    running = Boolean(pid && isProcessRunning(pid))
    if (!running) {
      unlinkSync(pidPath)
      pid = null
    }
  }

  const startup = await getMmsStartupStatus()
  const platform = await detectStartupPlatform()

  writeOutput(mode, {
    running,
    pid,
    pidfile: pidPath,
    home: homeDir,
    startup,
    platform
  })
}

async function installService(homeFlag: string | undefined, mode: ParsedArgs['globals']['mode']): Promise<void> {
  const homeDir = resolveMousseHome(homeFlag)

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

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
