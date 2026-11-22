/**
 * A stop ends the daemon within its deadline even while the daemon's main thread is stuck in
 * synchronous work: the deadline runs on its own thread and reads the stop request itself.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { startDaemonExitWatchdog, type DaemonExitWatchdog } from '../src/cli/daemonExitWatchdog'
import { writeStopRequest } from '../src/cli/mmsRuntime'

const cleanup: Array<() => void> = []
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close() })

/** A process whose main thread never yields, like a daemon in a long synchronous pass. */
function stuckProcess(): ChildProcess {
  const child = spawn(process.execPath, ['-e', 'for (;;) {}'], { stdio: 'ignore' })
  cleanup.push(() => { try { child.kill('SIGKILL') } catch { /* gone */ } })
  return child
}

function watchdog(home: string, token: string, pid: number): DaemonExitWatchdog {
  const dog = startDaemonExitWatchdog({ homeDir: home, ownerToken: token, ms: 300, pollMs: 25, pid })
  cleanup.push(() => dog.stop())
  return dog
}

const exited = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null
const blockMainThread = (ms: number) => { const until = Date.now() + ms; while (Date.now() < until) { /* stuck */ } }

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mousse-exit-watchdog-'))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

describe('the daemon exit watchdog', () => {
  it('ends a stuck process once its stop request has waited past the deadline, while the main thread is blocked', async () => {
    const dir = home()
    const child = stuckProcess()
    watchdog(dir, 'token-a', child.pid!)
    writeStopRequest(dir, 'token-a')
    // The thread that wrote the request is as stuck as the daemon: nothing on it can end the child.
    blockMainThread(3_000)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(exited(child)).toBe(true)
  }, 20_000)

  it('leaves the process running without a stop request, or with one for another daemon', async () => {
    const dir = home()
    const child = stuckProcess()
    watchdog(dir, 'token-a', child.pid!)
    writeStopRequest(dir, 'token-b')
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    expect(exited(child)).toBe(false)
  }, 20_000)

  it('starts the deadline when the main thread reports a stop that came another way', async () => {
    const child = stuckProcess()
    watchdog(home(), 'token-a', child.pid!).arm()
    blockMainThread(3_000)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(exited(child)).toBe(true)
  }, 20_000)
})
