import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ChildProcess } from 'node:child_process'
import { HeadlessAgentRunner } from '../src/mms/terminals/HeadlessAgentRunner'
import { PtyManager } from '../src/mms/terminals/PtyManager'
import { WorkerHandle } from '../src/mms/terminals/WorkerHandle'
import {
  ProcessAdmissionError,
  ProcessShutdownError,
  windowsTaskkillArgs,
  type OwnedTreeSignal
} from '../src/mms/terminals/processLifecycle'
import {
  heartbeatCommand,
  heartbeatLineCount,
  heartbeatPath,
  makeLifecycleTempRoot,
  pidPath,
  readOwnedPidFile,
  removeOwnedTempRoot,
  waitForHeartbeat,
  waitUntilPidGone
} from './fixtures/agent-platform/process-lifecycle/ownedTemp'

const originalMousseHome = process.env.MOUSSE_HOME
const tempRoots: string[] = []

interface LifecycleRunner {
  beginShutdown(): void
  getActiveCount(): number
  shutdown(options?: { timeoutMs?: number }): Promise<void>
}

const runners: LifecycleRunner[] = []

function trackRoot(root: string): string {
  tempRoots.push(root)
  return root
}

function trackRunner<T extends LifecycleRunner>(
  runner: T
): T {
  runners.push(runner)
  return runner
}

async function waitMs(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

function heartbeatEnv(dir: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    LIFECYCLE_HEARTBEAT_DIR: dir,
    LIFECYCLE_ROLE: 'child',
    LIFECYCLE_HEARTBEAT_MS: '80',
    ...extra
  }
}

function failingSpawnChild(): ChildProcess {
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const proc = new EventEmitter() as ChildProcess
  Object.assign(proc, {
    pid: undefined,
    stdout,
    stderr,
    stdin: null,
    kill: () => false
  })
  queueMicrotask(() => {
    const error = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })
    proc.emit('error', error)
    stdout.end()
    stderr.end()
    proc.emit('close')
  })
  return proc
}

beforeEach(() => {
  const home = mkdtempSync(join(realpathSync.native(tmpdir()), 'mousse-process-lifecycle-home-'))
  trackRoot(home)
  process.env.MOUSSE_HOME = home
})

afterEach(async () => {
  for (const runner of runners.splice(0)) {
    try {
      runner.beginShutdown()
    } catch {
      /* already stopped */
    }
    try {
      await runner.shutdown({ timeoutMs: 8_000 })
    } catch {
      /* timeout: remaining ownership is diagnosed by the test */
    }
  }
  for (const root of tempRoots.splice(0)) {
    try {
      removeOwnedTempRoot(root)
    } catch {
      /* best-effort after containment check inside the helper */
    }
  }
  if (originalMousseHome === undefined) delete process.env.MOUSSE_HOME
  else process.env.MOUSSE_HOME = originalMousseHome
})

describe('WorkerHandle exit/close publication', () => {
  it('publishes exit and close exactly once and never synthesizes them from a kill call', async () => {
    const handle = new WorkerHandle('h1', 'agent-a', 'headless')
    expect(handle.alive).toBe(true)
    expect(handle.closed).toBe(false)
    const first = handle.recordExit(1, 'SIGTERM')
    const second = handle.recordExit(0, null)
    expect(second).toBe(first)
    expect(first.code).toBe(1)
    expect(first.signal).toBe('SIGTERM')
    expect(handle.alive).toBe(false)
    handle.recordClose()
    handle.recordClose()
    expect(handle.closed).toBe(true)
    await expect(handle.waitForExit()).resolves.toBe(first)
    await expect(handle.waitForClose()).resolves.toBeUndefined()
  })
})

describe('owned tree signaling', () => {
  it('builds taskkill arguments from the exact recorded pid and never from a process name', () => {
    const term = windowsTaskkillArgs(77, 'term')
    const force = windowsTaskkillArgs(77, 'kill')
    expect(term).toEqual(['/PID', '77', '/T'])
    expect(force).toEqual(['/PID', '77', '/T', '/F'])
    expect(term.join(' ')).not.toMatch(/\/IM/i)
    expect(force.join(' ')).not.toMatch(/\/IM/i)
    expect(term.some((part) => part.includes(' '))).toBe(false)
  })
})

describe('HeadlessAgentRunner real process lifecycle', () => {
  it('shutdown waits for the owned PowerShell/node tree and stops heartbeats', async () => {
    const root = trackRoot(makeLifecycleTempRoot())
    const beats = join(root, 'beats')
    const runner = trackRunner(new HeadlessAgentRunner())
    const processId = runner.spawn('agent-tree', root, heartbeatCommand(), {
      env: heartbeatEnv(beats, { LIFECYCLE_SPAWN_GRANDCHILD: '1' })
    })
    expect(processId).not.toBe(String(process.pid))
    await waitForHeartbeat(heartbeatPath(beats, 'child'))
    await waitForHeartbeat(heartbeatPath(beats, 'grandchild'))
    const childPid = readOwnedPidFile(pidPath(beats, 'child'))
    const grandchildPid = readOwnedPidFile(pidPath(beats, 'grandchild'))
    expect(childPid).not.toBe(process.pid)
    expect(grandchildPid).not.toBe(process.pid)
    expect(runner.getActiveCount()).toBe(1)
    expect(runner.list()).toHaveLength(1)

    runner.beginShutdown()
    expect(() =>
      runner.spawn('agent-tree', root, heartbeatCommand(), { env: heartbeatEnv(beats) })
    ).toThrow(ProcessAdmissionError)
    const first = runner.shutdown({ timeoutMs: 20_000 })
    const second = runner.shutdown({ timeoutMs: 20_000 })
    expect(second).toBe(first)
    await first
    await second
    await runner.shutdown({ timeoutMs: 1_000 })

    expect(runner.getActiveCount()).toBe(0)
    expect(runner.has(processId)).toBe(false)
    await waitUntilPidGone(childPid, 'headless child')
    await waitUntilPidGone(grandchildPid, 'headless grandchild')
    const childLines = heartbeatLineCount(heartbeatPath(beats, 'child'))
    const grandLines = heartbeatLineCount(heartbeatPath(beats, 'grandchild'))
    await waitMs(350)
    expect(heartbeatLineCount(heartbeatPath(beats, 'child'))).toBe(childLines)
    expect(heartbeatLineCount(heartbeatPath(beats, 'grandchild'))).toBe(grandLines)
    expect(() =>
      runner.spawn('agent-tree', root, heartbeatCommand(), { env: heartbeatEnv(beats) })
    ).toThrow(ProcessAdmissionError)
  }, 40_000)

  it('keeps ownership after kill() until the process actually exits', async () => {
    const root = trackRoot(makeLifecycleTempRoot())
    const beats = join(root, 'beats')
    const runner = trackRunner(new HeadlessAgentRunner())
    const exits: Array<{ processId: string; exitCode: number | null }> = []
    runner.on('exit', (payload) => exits.push(payload))
    const processId = runner.spawn('agent-kill', root, heartbeatCommand(), {
      env: heartbeatEnv(beats, { LIFECYCLE_SPAWN_GRANDCHILD: '1' })
    })
    await waitForHeartbeat(heartbeatPath(beats, 'child'))
    await waitForHeartbeat(heartbeatPath(beats, 'grandchild'))
    const childPid = readOwnedPidFile(pidPath(beats, 'child'))
    const grandchildPid = readOwnedPidFile(pidPath(beats, 'grandchild'))

    runner.kill(processId)
    expect(runner.has(processId)).toBe(false)
    expect(runner.list()).toHaveLength(0)
    expect(runner.getHandle(processId)).toBeUndefined()
    expect(runner.getActiveCount()).toBe(1)

    await runner.shutdown({ timeoutMs: 20_000 })
    expect(runner.getActiveCount()).toBe(0)
    expect(exits.filter((event) => event.processId === processId)).toHaveLength(1)
    await waitUntilPidGone(childPid, 'killed headless child')
    await waitUntilPidGone(grandchildPid, 'killed headless grandchild')
    const lines = heartbeatLineCount(heartbeatPath(beats, 'child'))
    await waitMs(350)
    expect(heartbeatLineCount(heartbeatPath(beats, 'child'))).toBe(lines)
  }, 40_000)

  it('does not invent successful exit metadata for a natural early exit', async () => {
    const root = trackRoot(makeLifecycleTempRoot())
    const runner = trackRunner(new HeadlessAgentRunner())
    const exits: Array<{
      processId: string
      exitCode: number | null
      signal: string | null
      exit: { error?: string }
    }> = []
    runner.on('exit', (payload) => exits.push(payload))
    const command = process.platform === 'win32' ? "Write-Output 'early-exit'" : "printf 'early-exit\\n'"
    const processId = runner.spawn('agent-early', root, command)
    const deadline = Date.now() + 15_000
    while (runner.getActiveCount() > 0 && Date.now() < deadline) await waitMs(50)
    await runner.shutdown({ timeoutMs: 5_000 })
    expect(runner.getActiveCount()).toBe(0)
    expect(exits).toHaveLength(1)
    expect(exits[0].processId).toBe(processId)
    expect(exits[0].exit.error).toBeUndefined()
    expect(exits[0].exitCode).toBe(0)
  }, 25_000)
})

describe('HeadlessAgentRunner injected transport edges', () => {
  it('does not capture or signal a reusable parent PID after exit while its pipes remain open', async () => {
    const handle = new WorkerHandle('exited-open-pipes', 'agent-tree', 'headless')
    const runner = trackRunner(new HeadlessAgentRunner({ treeSignaler: {
      capture() { throw new Error('Cannot capture an exited parent') },
      signal() { throw new Error('Cannot signal an exited parent') }
    } }))
    runner.adoptTransportForTests({ handle, pid: 88_888, signal: () => { throw new Error('Cannot kill an exited handle') } })
    handle.recordExit(0, null)
    const draining = runner.shutdown({ timeoutMs: 500 })
    expect(runner.getActiveCount()).toBe(1)
    handle.recordClose()
    await draining
    expect(runner.getActiveCount()).toBe(0)
  })

  it('retains captured descendants through timeout and retries without recapturing a dead parent PID', async () => {
    const handle = new WorkerHandle('captured-timeout', 'agent-tree', 'headless')
    let alive = true
    let allowExit = false
    let captures = 0
    const runner = trackRunner(new HeadlessAgentRunner({ treeSignaler: {
      capture() {
        captures += 1
        return { isAlive: () => alive, signal: () => { if (allowExit) alive = false } }
      },
      signal() { throw new Error('A captured tree must not be rediscovered by numeric PID') }
    } }))
    runner.adoptTransportForTests({ handle, pid: 88_888, signal: () => {
      handle.recordExit(null, 'SIGTERM')
      handle.recordClose()
    } })
    await expect(runner.shutdown({ timeoutMs: 150 })).rejects.toMatchObject({
      code: 'shutdown_timeout',
      remaining: [expect.objectContaining({ alive: false, closed: true, capturedTreeAlive: true })]
    })
    expect(runner.getActiveCount()).toBe(1)
    allowExit = true
    await runner.shutdown({ timeoutMs: 500 })
    expect(captures).toBe(1)
    expect(runner.getActiveCount()).toBe(0)
  })

  it('captures the descendant tree before local termination can reparent it', async () => {
    const events: string[] = []
    const handle = new WorkerHandle('capture-first', 'agent-tree', 'headless')
    let descendantsAttached = true
    const runner = trackRunner(new HeadlessAgentRunner({
      treeSignaler: {
        signal() {
          events.push(descendantsAttached ? 'captured-descendants' : 'lost-descendants')
        }
      }
    }))
    runner.adoptTransportForTests({
      handle, pid: 88_888,
      signal: () => {
        descendantsAttached = false
        events.push('local-kill')
        queueMicrotask(() => { handle.recordExit(null, 'SIGTERM'); handle.recordClose() })
      }
    })
    await runner.shutdown({ timeoutMs: 1_000 })
    expect(events).toEqual(['captured-descendants', 'local-kill'])
    expect(runner.getActiveCount()).toBe(0)
  })

  it('awaits tree termination after parent close and never re-targets the reusable pid', async () => {
    let finishTreeSignal!: () => void
    const treeSignal = new Promise<void>((resolve) => { finishTreeSignal = resolve })
    const signals: OwnedTreeSignal[] = []
    const handle = new WorkerHandle('parent-exits-first', 'agent-tree', 'headless')
    const runner = trackRunner(new HeadlessAgentRunner({
      treeSignaler: {
        signal(_pid, mode) {
          signals.push(mode)
          return treeSignal
        }
      }
    }))
    runner.adoptTransportForTests({ handle, pid: 88_888 })

    runner.beginShutdown()
    runner.beginShutdown()
    const draining = runner.shutdown({ timeoutMs: 10_000 })
    handle.recordExit(0, null)
    handle.recordClose()
    await Promise.resolve()

    expect(runner.getActiveCount()).toBe(1)
    expect(signals).toEqual(['term'])

    finishTreeSignal()
    await draining
    await runner.shutdown({ timeoutMs: 100 })
    expect(runner.getActiveCount()).toBe(0)
    expect(signals).toEqual(['term'])
  })

  it('treats spawn error as observed failure, not a successful drain from kill', async () => {
    const root = trackRoot(makeLifecycleTempRoot())
    const runner = trackRunner(
      new HeadlessAgentRunner({
        spawn: () => failingSpawnChild()
      })
    )
    const exits: Array<{ exit: { error?: string; code: number | null } }> = []
    runner.on('exit', (payload) => exits.push(payload))
    const processId = runner.spawn('agent-fail', root, heartbeatCommand())
    expect(runner.getActiveCount()).toBe(1)
    await runner.shutdown({ timeoutMs: 5_000 })
    expect(runner.getActiveCount()).toBe(0)
    expect(exits).toHaveLength(1)
    expect(exits[0].exit.error).toMatch(/ENOENT|spawn/)
    expect(exits[0].exit.code).toBeNull()
    expect(processId).toEqual(expect.any(String))
  })

  it('retains a failed tree signal for diagnosis and safely retries while the handle is alive', async () => {
    const handle = new WorkerHandle('retry-tree', 'agent-retry', 'headless')
    let allowSignal = false
    const runner = trackRunner(new HeadlessAgentRunner({
      treeSignaler: {
        signal() {
          if (!allowSignal) return Promise.reject(new Error('tree signal unavailable'))
          queueMicrotask(() => {
            handle.recordExit(null, 'SIGTERM')
            handle.recordClose()
          })
          return Promise.resolve()
        }
      }
    }))
    runner.adoptTransportForTests({ handle, pid: 77_777 })

    const first = await runner.shutdown({ timeoutMs: 150 }).catch((error: unknown) => error)
    expect(first).toBeInstanceOf(ProcessShutdownError)
    expect((first as ProcessShutdownError).remaining).toEqual([
      expect.objectContaining({ treeSignalError: 'tree signal unavailable' })
    ])
    expect(runner.getActiveCount()).toBe(1)

    allowSignal = true
    await runner.shutdown({ timeoutMs: 1_000 })
    expect(runner.getActiveCount()).toBe(0)
  })

  it('fails closed on timeout, shares the in-flight operation, and retains ownership to retry', async () => {
    const signals: OwnedTreeSignal[] = []
    const handle = new WorkerHandle('injected-timeout', 'agent-injected', 'headless')
    const runner = trackRunner(
      new HeadlessAgentRunner({
        treeSignaler: {
          signal(_pid, mode) {
            signals.push(mode)
          }
        }
      })
    )
    runner.adoptTransportForTests({
      handle,
      pid: undefined,
      signal: (force) => {
        signals.push(force ? 'kill' : 'term')
      }
    })
    expect(runner.getActiveCount()).toBe(1)

    const first = runner.shutdown({ timeoutMs: 200 })
    const second = runner.shutdown({ timeoutMs: 200 })
    expect(second).toBe(first)
    const error = await first.then(
      () => {
        throw new Error('injected timeout transport must not report drained')
      },
      (reason: unknown) => reason
    )
    expect(error).toBeInstanceOf(ProcessShutdownError)
    const shutdownError = error as ProcessShutdownError
    expect(shutdownError.code).toBe('shutdown_timeout')
    expect(shutdownError.remaining).toEqual([
      expect.objectContaining({
        id: 'injected-timeout',
        alive: true,
        closed: false,
        signaled: true
      })
    ])
    expect(runner.getActiveCount()).toBe(1)
    expect(handle.alive).toBe(true)
    expect(handle.exit).toBeUndefined()
    expect(signals.length).toBeGreaterThan(0)

    const retry = runner.shutdown({ timeoutMs: 150 })
    await expect(retry).rejects.toBeInstanceOf(ProcessShutdownError)
    handle.recordExit(null, null, 'late-observed-exit')
    handle.recordClose()
    await runner.shutdown({ timeoutMs: 1_000 })
    expect(runner.getActiveCount()).toBe(0)
    expect(() =>
      runner.adoptTransportForTests({
        handle: new WorkerHandle('reopen', 'agent-injected', 'headless')
      })
    ).toThrow(ProcessAdmissionError)
  })

  it('synchronous spawn throw leaves no owned worker and does not report drained from a kill', async () => {
    const runner = trackRunner(
      new HeadlessAgentRunner({
        spawn: () => {
          throw Object.assign(new Error('spawn EACCES'), { code: 'EACCES' })
        }
      })
    )
    expect(() =>
      runner.spawn('agent-throw', trackRoot(makeLifecycleTempRoot()), heartbeatCommand())
    ).toThrow(/EACCES/)
    expect(runner.getActiveCount()).toBe(0)
    await runner.shutdown({ timeoutMs: 500 })
    expect(runner.getActiveCount()).toBe(0)
  })
})

describe('PtyManager real process lifecycle', () => {
  it('shutdown waits for onExit of an owned PTY running a heartbeat child', async () => {
    const root = trackRoot(makeLifecycleTempRoot())
    const beats = join(root, 'beats')
    const manager = trackRunner(new PtyManager())
    const ptyId = manager.create('agent-pty', root, heartbeatCommand(), {
      threadId: 'thread-a',
      env: heartbeatEnv(beats, { LIFECYCLE_SPAWN_GRANDCHILD: '1' })
    })
    await waitForHeartbeat(heartbeatPath(beats, 'child'), 2, 20_000)
    await waitForHeartbeat(heartbeatPath(beats, 'grandchild'), 2, 20_000)
    const childPid = readOwnedPidFile(pidPath(beats, 'child'))
    const grandchildPid = readOwnedPidFile(pidPath(beats, 'grandchild'))
    expect(manager.isAlive(ptyId)).toBe(true)
    expect(manager.getActiveCount()).toBe(1)

    manager.beginShutdown()
    expect(() => manager.write(ptyId, 'echo still-open\r')).toThrow(ProcessAdmissionError)
    expect(() => manager.create('agent-pty', root, heartbeatCommand())).toThrow(ProcessAdmissionError)
    await manager.shutdown({ timeoutMs: 25_000 })
    await manager.shutdown({ timeoutMs: 500 })

    expect(manager.getActiveCount()).toBe(0)
    expect(manager.isAlive(ptyId)).toBe(false)
    await waitUntilPidGone(childPid, 'pty child')
    await waitUntilPidGone(grandchildPid, 'pty grandchild')
    const lines = heartbeatLineCount(heartbeatPath(beats, 'child'))
    await waitMs(350)
    expect(heartbeatLineCount(heartbeatPath(beats, 'child'))).toBe(lines)
    expect(() => manager.getOutputSince(ptyId, 0)).toThrow(ProcessAdmissionError)
  }, 45_000)

  it('killByThreadId preserves the other thread session map while still tracking the killed PTY until exit', async () => {
    const root = trackRoot(makeLifecycleTempRoot())
    const beatsA = join(root, 'a')
    const beatsB = join(root, 'b')
    const manager = trackRunner(new PtyManager())
    const ptyA = manager.create('agent-a', root, heartbeatCommand(), {
      threadId: 'thread-a',
      env: heartbeatEnv(beatsA)
    })
    const ptyB = manager.create('agent-b', root, heartbeatCommand(), {
      threadId: 'thread-b',
      env: heartbeatEnv(beatsB)
    })
    await waitForHeartbeat(heartbeatPath(beatsA, 'child'), 2, 20_000)
    await waitForHeartbeat(heartbeatPath(beatsB, 'child'), 2, 20_000)
    manager.killByThreadId('thread-a')
    expect(manager.has(ptyA)).toBe(false)
    expect(manager.has(ptyB)).toBe(true)
    expect(manager.list('thread-b')).toHaveLength(1)
    expect(manager.getActiveCount()).toBe(2)
    await manager.shutdown({ timeoutMs: 25_000 })
    expect(manager.getActiveCount()).toBe(0)
    expect(manager.has(ptyB)).toBe(false)
  }, 45_000)
})

describe('PtyManager injected timeout', () => {
  it('does not treat a kill signal as exit when the transport never closes', async () => {
    const handle = new WorkerHandle('pty-injected', 'agent-pty', 'pty')
    const manager = trackRunner(new PtyManager({ treeSignaler: { signal() {} } }))
    manager.adoptTransportForTests({ handle, signal: () => undefined })
    manager.beginShutdown()
    await expect(manager.shutdown({ timeoutMs: 180 })).rejects.toMatchObject({
      code: 'shutdown_timeout',
      remaining: [expect.objectContaining({ id: 'pty-injected', alive: true, closed: false })]
    })
    expect(handle.exit).toBeUndefined()
    expect(manager.getActiveCount()).toBe(1)
    handle.recordExit(null, 'SIGKILL')
    expect(manager.getActiveCount()).toBe(1)
    handle.recordClose()
    await manager.shutdown({ timeoutMs: 500 })
    expect(manager.getActiveCount()).toBe(0)
  })
})

describe.skipIf(process.platform === 'win32')('POSIX non-cooperative child', () => {
  it('retains a captured SIGTERM-ignoring descendant after parent exit, then escalates on retry', async () => {
    const root = trackRoot(makeLifecycleTempRoot())
    const beats = join(root, 'beats')
    const runner = trackRunner(new HeadlessAgentRunner())
    const processId = runner.spawn('agent-orphan', root, heartbeatCommand(), {
      env: heartbeatEnv(beats, { LIFECYCLE_SPAWN_GRANDCHILD: '1', LIFECYCLE_GRANDCHILD_IGNORE_STOP: '1' })
    })
    await waitForHeartbeat(heartbeatPath(beats, 'child'))
    await waitForHeartbeat(heartbeatPath(beats, 'grandchild'))
    const childPid = readOwnedPidFile(pidPath(beats, 'child'))
    const grandchildPid = readOwnedPidFile(pidPath(beats, 'grandchild'))
    runner.kill(processId)
    await waitUntilPidGone(childPid, 'cooperative parent')
    await waitMs(150)
    expect(runner.getActiveCount()).toBe(1)
    const lines = heartbeatLineCount(heartbeatPath(beats, 'grandchild'))
    await waitMs(150)
    expect(heartbeatLineCount(heartbeatPath(beats, 'grandchild'))).toBeGreaterThan(lines)
    await runner.shutdown({ timeoutMs: 2_000 })
    expect(runner.getActiveCount()).toBe(0)
    await waitUntilPidGone(grandchildPid, 'captured non-cooperative grandchild')
    const stopped = heartbeatLineCount(heartbeatPath(beats, 'grandchild'))
    await waitMs(150)
    expect(heartbeatLineCount(heartbeatPath(beats, 'grandchild'))).toBe(stopped)
  }, 20_000)

  it('does not report drained while SIGTERM is ignored, then force-kills the owned pid', async () => {
    const root = trackRoot(makeLifecycleTempRoot())
    const beats = join(root, 'beats')
    const runner = trackRunner(new HeadlessAgentRunner())
    runner.spawn('agent-ignore', root, heartbeatCommand(), {
      env: heartbeatEnv(beats, { LIFECYCLE_IGNORE_STOP: '1' })
    })
    await waitForHeartbeat(heartbeatPath(beats, 'child'))
    const childPid = readOwnedPidFile(pidPath(beats, 'child'))
    await runner.shutdown({ timeoutMs: 8_000 })
    expect(runner.getActiveCount()).toBe(0)
    await waitUntilPidGone(childPid, 'posix ignore-stop child')
  }, 20_000)
})
