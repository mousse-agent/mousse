/**
 * Development orchestrator: live MMS daemon + Electron GUI (electron-vite).
 *
 * - Builds/watches `out/cli/index.js` (CLI + MMS entry)
 * - Runs `mousse-cli service run` under system Node (sole daemon owner)
 * - Restarts the daemon when the CLI bundle rebuilds
 * - Runs `electron-vite dev` for main/preload/renderer HMR
 * - Sets MOUSSE_DEV_MANAGED_DAEMON so the GUI connects instead of spawning a second daemon
 *
 * Usage: npm run dev
 * Env:   MOUSSE_HOME (optional data dir)
 */

import { spawn, spawnSync } from 'child_process'
import { existsSync } from 'fs'
import { homedir } from 'os'
import { join, resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { buildCli } from './build-cli.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const nodeCmd = process.execPath
const cliEntry = resolve(root, 'out/cli/index.js')
const electronViteEntry = resolve(root, 'node_modules/electron-vite/bin/electron-vite.js')
const homeDir = process.env.MOUSSE_HOME ?? join(homedir(), '.mousse')

const READY_TIMEOUT_MS = 45_000
const READY_POLL_MS = 200
const RESTART_DEBOUNCE_MS = 400

const baseEnv = {
  ...process.env,
  MOUSSE_HOME: homeDir,
  // GUI must not spawn a competing Electron dual-mode daemon while we own it.
  MOUSSE_DEV_MANAGED_DAEMON: '1'
}

let daemon = null
let daemonStartedByUs = false
let electron = null
let shuttingDown = false
let restartTimer = null
let cliContext = null
let restartGeneration = 0

function log(msg) {
  console.log(`[dev] ${msg}`)
}

function logErr(msg) {
  console.error(`[dev] ${msg}`)
}

function runCli(args, opts = {}) {
  return spawnSync(nodeCmd, [cliEntry, ...args], {
    cwd: root,
    encoding: 'utf-8',
    env: baseEnv,
    ...opts
  })
}

function daemonStatus() {
  if (!existsSync(cliEntry)) return { running: false, ready: false }
  const res = runCli(['service', 'status', '--mode', 'json'])
  try {
    return JSON.parse((res.stdout || '').trim() || '{}')
  } catch {
    return { running: false, ready: false }
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

async function waitUntilReady(timeoutMs = READY_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (shuttingDown) return false
    const status = daemonStatus()
    if (status.ready && status.running) return true
    // Child already exited → fail fast
    if (daemon && daemon.exitCode !== null && daemon.exitCode !== undefined) {
      return false
    }
    await sleep(READY_POLL_MS)
  }
  return false
}

function stopDaemonSync() {
  if (!existsSync(cliEntry)) return
  // Prefer owner-token stop (works for our child and a pre-existing daemon on this home).
  runCli(['service', 'stop', '--mode', 'json'], { stdio: 'pipe' })
  if (daemon && daemon.exitCode === null) {
    try {
      daemon.kill('SIGTERM')
    } catch {
      /* ignore */
    }
    // Windows: force if still alive after a moment
    const child = daemon
    setTimeout(() => {
      if (child.exitCode === null) {
        try {
          child.kill('SIGKILL')
        } catch {
          /* ignore */
        }
      }
    }, 1500).unref?.()
  }
  daemon = null
}

function startDaemonProcess() {
  if (!existsSync(cliEntry)) {
    throw new Error(`CLI entry missing: ${cliEntry}`)
  }
  log(`starting MMS daemon (home=${homeDir})`)
  daemon = spawn(nodeCmd, [cliEntry, 'service', 'run', '--home', homeDir], {
    cwd: root,
    stdio: ['ignore', 'inherit', 'inherit'],
    env: baseEnv,
    // Keep attached so we can stop on exit; not detached.
    windowsHide: true
  })
  daemonStartedByUs = true
  daemon.on('exit', (code, signal) => {
    if (shuttingDown) return
    logErr(`MMS daemon exited (code=${code} signal=${signal ?? ''})`)
    daemon = null
  })
  daemon.on('error', (err) => {
    logErr(`MMS daemon failed to spawn: ${err.message}`)
  })
}

async function ensureDaemonRunning() {
  // Always run a daemon from this workspace's freshly built CLI so dev matches the branch.
  const status = daemonStatus()
  if (status.running || status.ready || existsSync(join(homeDir, 'mms.owner.json'))) {
    log(
      status.running
        ? `stopping existing MMS (pid ${status.pid ?? '?'}) so this session owns a live daemon…`
        : 'clearing stale MMS ownership so this session can start a live daemon…'
    )
    stopDaemonSync()
    await sleep(400)
  }

  startDaemonProcess()
  const ok = await waitUntilReady()
  if (!ok) {
    logErr('MMS daemon did not become ready in time')
    const after = daemonStatus()
    logErr(`status: ${JSON.stringify(after)}`)
    return false
  }
  const ready = daemonStatus()
  log(`MMS ready (pid ${ready.pid ?? '?'})`)
  return true
}

function scheduleDaemonRestart() {
  if (shuttingDown) return
  if (restartTimer) clearTimeout(restartTimer)
  restartTimer = setTimeout(() => {
    restartTimer = null
    void restartDaemon()
  }, RESTART_DEBOUNCE_MS)
}

async function restartDaemon() {
  if (shuttingDown) return
  const gen = ++restartGeneration
  log('CLI rebuilt — restarting MMS daemon…')
  stopDaemonSync()
  await sleep(300)
  if (shuttingDown || gen !== restartGeneration) return
  startDaemonProcess()
  const ok = await waitUntilReady()
  if (gen !== restartGeneration) return
  if (ok) {
    log('MMS restarted and ready (GUI will reconnect)')
  } else {
    logErr('MMS failed to become ready after rebuild')
  }
}

function startElectron() {
  if (!existsSync(electronViteEntry)) {
    throw new Error('electron-vite not found — run npm install')
  }
  log('starting electron-vite dev…')
  electron = spawn(nodeCmd, [electronViteEntry, 'dev'], {
    cwd: root,
    stdio: 'inherit',
    env: baseEnv
  })
  electron.on('exit', (code) => {
    electron = null
    if (!shuttingDown) {
      log(`electron-vite exited (code=${code ?? 0})`)
      void shutdown(code ?? 0)
    }
  })
  electron.on('error', (err) => {
    logErr(`electron-vite failed: ${err.message}`)
    void shutdown(1)
  })
}

async function shutdown(code = 0) {
  if (shuttingDown) return
  shuttingDown = true
  log('shutting down…')
  if (restartTimer) {
    clearTimeout(restartTimer)
    restartTimer = null
  }
  if (electron && electron.exitCode === null) {
    try {
      electron.kill('SIGTERM')
    } catch {
      /* ignore */
    }
  }
  if (daemonStartedByUs) {
    stopDaemonSync()
  }
  if (cliContext) {
    try {
      await cliContext.dispose()
    } catch {
      /* ignore */
    }
    cliContext = null
  }
  // Give children a beat, then exit hard so npm doesn't hang on Windows.
  setTimeout(() => process.exit(code), 200).unref?.()
}

process.on('SIGINT', () => void shutdown(0))
process.on('SIGTERM', () => void shutdown(0))
// Windows Ctrl+Break
process.on('SIGHUP', () => void shutdown(0))

// --- main ---
log(`MOUSSE_HOME=${homeDir}`)
log('building CLI/MMS bundle…')

try {
  // Initial one-shot so we can start the daemon immediately, then watch.
  await buildCli({ watch: false, log: true })
} catch (err) {
  logErr(`CLI build failed: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
}

const ready = await ensureDaemonRunning()
if (!ready) {
  logErr(
    'Could not start MMS. Fix startup errors above (often bad thread/project data under MOUSSE_HOME), then retry.'
  )
  process.exit(1)
}

// Watch CLI/MMS sources; rebuild restarts the daemon for a live MMS loop.
// Skip the first onEnd (initial watch build) — we already started from the one-shot build.
let skipWatchKickoff = true
cliContext = await buildCli({
  watch: true,
  log: true,
  onRebuild: (err) => {
    if (err) return
    if (skipWatchKickoff) {
      skipWatchKickoff = false
      return
    }
    scheduleDaemonRestart()
  }
})

startElectron()
