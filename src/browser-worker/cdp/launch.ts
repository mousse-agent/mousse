import { spawn, type ChildProcess } from 'node:child_process'
import { createWriteStream, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Readable, Writable } from 'node:stream'
import { CdpConnection } from './connection'
import { processRecordPath } from '../lifecycle/paths'
import {
  consumeInjectedStopFailureForTests,
  rootOnlyTree,
  stopOwnedProcessTree,
  type OwnedProcessTree
} from '../lifecycle/ownedTree'
import { fail } from '../errors'

export interface LaunchedChrome {
  pid: number
  process: ChildProcess
  cdp: CdpConnection
  userDataDir: string
  executablePath: string
  tree: OwnedProcessTree
  stop: () => Promise<void>
}

export interface LaunchChromeOptions {
  executablePath: string
  userDataDir: string
  headless?: boolean
  windowSize?: { width: number; height: number }
  deviceScaleFactor?: number
  extraArgs?: string[]
  env?: NodeJS.ProcessEnv
  signal?: AbortSignal
}

export function chromeLaunchArgs(options: LaunchChromeOptions): string[] {
  const size = options.windowSize ?? { width: 1280, height: 720 }
  const args = [
    `--user-data-dir=${options.userDataDir}`,
    '--remote-debugging-pipe',
    '--site-per-process',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-default-apps',
    '--disable-popup-blocking',
    '--disable-background-networking',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-breakpad',
    '--disable-client-side-phishing-detection',
    '--disable-component-update',
    '--disable-crash-reporter',
    '--disable-dev-shm-usage',
    '--disable-hang-monitor',
    '--disable-ipc-flooding-protection',
    '--disable-prompt-on-repost',
    '--disable-renderer-backgrounding',
    '--disable-sync',
    '--metrics-recording-only',
    '--password-store=basic',
    '--use-mock-keychain',
    '--enable-features=NetworkService,NetworkServiceInProcess',
    '--disable-features=Translate,MediaRouter,OptimizationHints,PaintHolding,BackForwardCache',
    `--window-size=${size.width},${size.height}`,
    '--hide-scrollbars',
    '--mute-audio'
  ]
  if (options.headless !== false) args.unshift('--headless=new', '--disable-gpu')
  if (options.deviceScaleFactor && options.deviceScaleFactor !== 1) args.push(`--force-device-scale-factor=${options.deviceScaleFactor}`)
  if (options.extraArgs) args.push(...options.extraArgs)
  if (args.some((arg) => arg.startsWith('--remote-debugging-port'))) fail('invalid_action', 'Public remote-debugging TCP is not permitted')
  if ((options.extraArgs ?? []).some((arg) => arg.startsWith('--user-data-dir') || arg.startsWith('--profile-directory') || arg.startsWith('--remote-debugging'))) {
    fail('invalid_action', 'Extra Chromium arguments may not override profile or debugging isolation')
  }
  return args
}

export async function launchManagedChrome(options: LaunchChromeOptions): Promise<LaunchedChrome> {
  if (options.signal?.aborted) fail('cancelled', 'Chromium launch cancelled before spawn')
  mkdirSync(options.userDataDir, { recursive: true })
  const args = chromeLaunchArgs(options)
  const logDir = join(options.userDataDir, 'mousse-logs')
  mkdirSync(logDir, { recursive: true })
  const child = spawn(options.executablePath, args, {
    stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'],
    windowsHide: true,
    env: { ...process.env, ...options.env, CHROME_LOG_FILE: join(logDir, 'chrome.log') }
  })
  const pid = child.pid
  if (!pid) {
    child.kill()
    fail('setup_required', 'Failed to start managed Chromium (no PID)')
  }
  let tree = rootOnlyTree(pid, { parentHandleAlive: child.exitCode === null, executablePath: options.executablePath })
  writeOwnedProcessRecord(options.userDataDir, tree, options.executablePath)
  const stdout = createWriteStream(join(logDir, 'stdout.log'))
  const stderr = createWriteStream(join(logDir, 'stderr.log'))
  child.stdout?.pipe(stdout)
  child.stderr?.pipe(stderr)
  const pipeIn = child.stdio[3] as Writable | null
  const pipeOut = child.stdio[4] as Readable | null
  if (!pipeIn || !pipeOut) {
    await stopChildTree(child, tree)
    fail('setup_required', 'Managed Chromium did not inherit CDP pipe handles (fd 3/4)')
  }
  const cdp = new CdpConnection(pipeOut, pipeIn)
  let exitError: Error | undefined
  let exitCode: number | null | undefined
  const exitPromise = new Promise<void>((resolve) => {
    child.once('exit', (code, signal) => {
      exitCode = code
      exitError = new Error(`Chromium exited (code ${code}, signal ${signal})`)
      void cdp.close()
      resolve()
    })
  })
  const closePromise = new Promise<void>((resolve) => {
    child.once('close', () => resolve())
  })
  child.once('error', (error) => {
    exitError = error
    void cdp.close()
  })
  const abortLaunch = async (): Promise<never> => {
    await stopChildTree(child, tree)
    fail('cancelled', 'Chromium launch cancelled')
  }
  if (options.signal?.aborted) await abortLaunch()
  try {
    await Promise.race([
      probeBrowser(cdp, options.signal),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Chromium CDP handshake timed out')), 20_000)),
      exitPromise.then(() => { throw exitError ?? new Error('Chromium exited during handshake') })
    ])
  } catch (error) {
    try { await stopChildTree(child, tree) } catch { /* retain original launch error */ }
    throw error
  }
  if (options.signal?.aborted) await abortLaunch()
  if (exitError && child.exitCode !== null) {
    await stopChildTree(child, tree)
    fail('setup_required', exitError.message)
  }
  tree = rootOnlyTree(pid, { parentHandleAlive: child.exitCode === null, executablePath: options.executablePath })
  writeOwnedProcessRecord(options.userDataDir, tree, options.executablePath)
  let stopped = false
  let stopWork: Promise<void> | null = null
  return {
    pid,
    process: child,
    cdp,
    userDataDir: options.userDataDir,
    executablePath: options.executablePath,
    tree,
    stop: async () => {
      if (stopWork) return stopWork
      if (stopped) return
      stopWork = (async () => {
        const injected = consumeInjectedStopFailureForTests()
        if (injected) throw injected
        tree = rootOnlyTree(pid, { parentHandleAlive: child.exitCode === null, executablePath: options.executablePath })
        writeOwnedProcessRecord(options.userDataDir, tree, options.executablePath)
        try { await cdp.send('Browser.close', {}, { timeoutMs: 3_000 }) } catch { /* ignore */ }
        if (child.exitCode === null) {
          await stopOwnedProcessTree(tree)
        }
        await Promise.race([
          Promise.all([exitPromise, closePromise]),
          new Promise((_, reject) => setTimeout(() => reject(new Error(`Chromium child handle did not exit (pid ${pid})`)), 8_000))
        ])
        if (child.exitCode === null || exitCode === undefined) {
          throw new Error(`Chromium child handle did not publish exit (pid ${pid})`)
        }
        await cdp.close()
        stdout.end()
        stderr.end()
        stopped = true
      })().finally(() => {
        if (!stopped) stopWork = null
      })
      return stopWork
    }
  }
}

function writeOwnedProcessRecord(userDataDir: string, tree: OwnedProcessTree, executablePath: string): void {
  writeFileSync(processRecordPath(userDataDir), JSON.stringify({
    pid: tree.root.pid,
    executablePath,
    startedAt: tree.capturedAt,
    ownerPid: process.pid,
    creation: tree.root.creation,
    descendants: tree.descendants
  }, null, 2))
}

async function stopChildTree(child: ChildProcess, tree: OwnedProcessTree): Promise<void> {
  const pid = child.pid
  const live = pid
    ? rootOnlyTree(pid, { parentHandleAlive: child.exitCode === null, executablePath: tree.root.executablePath })
    : tree
  try {
    await stopOwnedProcessTree(live)
  } catch (error) {
    if (process.platform !== 'win32') {
      try { child.kill() } catch { /* already gone */ }
    }
    throw error
  }
}

async function probeBrowser(cdp: CdpConnection, signal?: AbortSignal): Promise<Record<string, unknown>> {
  return cdp.send<Record<string, unknown>>('Browser.getVersion', {}, { timeoutMs: 15_000, signal })
}
