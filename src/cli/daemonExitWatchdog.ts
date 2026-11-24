import { execFile } from 'node:child_process'
import { Worker } from 'node:worker_threads'
import { getLegacyStopRequestPath, getMmsStopRequestPath } from './mmsRuntime'

/**
 * The daemon's exit deadline on its own thread. A stop promises the process ends within
 * `DAEMON_EXIT_DEADLINE_MS`, but that deadline is a timer on the main thread: while the main thread is
 * busy with a long synchronous pass (an ownership scan over every thread, say), the timer cannot fire,
 * and the stop request is not even read. This thread reads the stop request itself and, once a stop
 * has gone on for `ms`, ends the process and the processes it started, as a crash would. What a stop
 * cuts off is recovered at the next start.
 */
export interface DaemonExitWatchdog {
  /** A stop began on the main thread (a signal, a protocol request, an Electron quit). */
  arm(): void
  /** Ends the thread; the process exits by itself. */
  stop(): void
}

export interface DaemonExitWatchdogOptions {
  homeDir: string
  ownerToken: string
  /** From the first sign of a stop to the end of the process. */
  ms: number
  /** How often the stop request is read. */
  pollMs?: number
  /** The process to end; this one unless a test names another. */
  pid?: number
}

/**
 * Plain JavaScript run with `eval`, so it needs no bundle entry of its own. It only reads two small
 * files and keeps one timer, so a blocked main thread cannot hold it up.
 */
const WATCHDOG_SOURCE = String.raw`
const { workerData, parentPort } = require('node:worker_threads')
const { readFileSync } = require('node:fs')
const { spawnSync } = require('node:child_process')
const { paths, token, ms, pollMs, pid } = workerData
let deadline = null
const end = () => {
  try { process.stderr.write('\nMMS did not exit within ' + Math.round(ms / 1000) + 's of the stop while its work held the main thread; ending it now\n') } catch {}
  if (process.platform === 'win32') {
    // The whole tree: agents, terminals and helpers the daemon started go with it, as a stop would end them.
    try { spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }) } catch {}
  }
  try { process.kill(pid, 'SIGKILL') } catch {}
}
const arm = () => {
  if (deadline) return
  deadline = setTimeout(end, ms)
}
const requested = () => {
  for (const path of paths) {
    try { if (JSON.parse(readFileSync(path, 'utf8')).token === token) return true } catch {}
  }
  return false
}
const poll = setInterval(() => { if (!deadline && requested()) { clearInterval(poll); arm() } }, pollMs)
parentPort.on('message', (message) => {
  if (message === 'arm') { clearInterval(poll); arm() }
  if (message === 'stop') { clearInterval(poll); if (deadline) clearTimeout(deadline); parentPort.close() }
})
`

export function startDaemonExitWatchdog(opts: DaemonExitWatchdogOptions): DaemonExitWatchdog {
  const worker = new Worker(WATCHDOG_SOURCE, {
    eval: true,
    workerData: {
      paths: [getMmsStopRequestPath(opts.homeDir, opts.ownerToken), getLegacyStopRequestPath(opts.homeDir)],
      token: opts.ownerToken,
      ms: opts.ms,
      pollMs: opts.pollMs ?? 500,
      pid: opts.pid ?? process.pid
    },
    resourceLimits: { maxOldGenerationSizeMb: 16 }
  })
  // Never keeps the process alive by itself.
  worker.unref()
  worker.on('error', () => undefined)
  return {
    arm: () => worker.postMessage('arm'),
    stop: () => {
      worker.postMessage('stop')
      void worker.terminate().catch(() => undefined)
    }
  }
}

/**
 * Ends another service process the way the watchdog ends its own (`end` above): on Windows its whole tree with
 * `taskkill /T /F`, so the agents, terminals and helpers it started go too; elsewhere with `SIGKILL`. For a service
 * that was asked to stop and is still there after its watchdog's deadline, because its watchdog cannot run either (the
 * whole process is frozen) or it predates the watchdog. Never this process.
 */
export async function endDaemonProcess(pid: number): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return
  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => {
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 10_000 }, () => resolve())
    })
  }
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    /* already gone */
  }
}
