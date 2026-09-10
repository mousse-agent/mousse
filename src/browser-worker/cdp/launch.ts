import { spawn, type ChildProcess } from 'node:child_process'
import { createWriteStream, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Readable, Writable } from 'node:stream'
import { CdpConnection } from './connection'
import { processRecordPath } from '../lifecycle/paths'
import { stopOwnedPid } from '../lifecycle/process'
import { fail } from '../errors'

export interface LaunchedChrome {
  pid: number
  process: ChildProcess
  cdp: CdpConnection
  userDataDir: string
  executablePath: string
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
}

export function chromeLaunchArgs(options: LaunchChromeOptions): string[] {
  const size = options.windowSize ?? { width: 1280, height: 720 }
  const args = [
    `--user-data-dir=${options.userDataDir}`,
    '--remote-debugging-pipe',
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
  return args
}

export async function launchManagedChrome(options: LaunchChromeOptions): Promise<LaunchedChrome> {
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
  writeFileSync(processRecordPath(options.userDataDir), JSON.stringify({
    pid,
    executablePath: options.executablePath,
    startedAt: new Date().toISOString(),
    ownerPid: process.pid
  }, null, 2))
  const stdout = createWriteStream(join(logDir, 'stdout.log'))
  const stderr = createWriteStream(join(logDir, 'stderr.log'))
  child.stdout?.pipe(stdout)
  child.stderr?.pipe(stderr)
  const pipeIn = child.stdio[3] as Writable | null
  const pipeOut = child.stdio[4] as Readable | null
  if (!pipeIn || !pipeOut) {
    await stopOwnedPid(pid)
    fail('setup_required', 'Managed Chromium did not inherit CDP pipe handles (fd 3/4)')
  }
  const cdp = new CdpConnection(pipeOut, pipeIn)
  let exitError: Error | undefined
  child.once('error', (error) => {
    exitError = error
    void cdp.close()
  })
  child.once('exit', (code, signal) => {
    exitError = new Error(`Chromium exited (code ${code}, signal ${signal})`)
    void cdp.close()
  })
  await Promise.race([
    probeBrowser(cdp),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Chromium CDP handshake timed out')), 20_000))
  ]).catch(async (error) => {
    await stopOwnedPid(pid)
    throw error
  })
  if (exitError) {
    await stopOwnedPid(pid)
    fail('setup_required', exitError.message)
  }
  let stopped = false
  return {
    pid,
    process: child,
    cdp,
    userDataDir: options.userDataDir,
    executablePath: options.executablePath,
    stop: async () => {
      if (stopped) return
      stopped = true
      try { await cdp.send('Browser.close', {}, { timeoutMs: 3_000 }) } catch { /* ignore */ }
      await new Promise((resolve) => setTimeout(resolve, 200))
      await stopOwnedPid(pid)
      await cdp.close()
      stdout.end()
      stderr.end()
    }
  }
}

async function probeBrowser(cdp: CdpConnection): Promise<Record<string, unknown>> {
  const version = await cdp.send<Record<string, unknown>>('Browser.getVersion', {}, { timeoutMs: 15_000 })
  return version
}
