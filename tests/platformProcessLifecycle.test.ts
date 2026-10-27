import { tryAcquireExecutionLease, releaseExecutionLeaseHandle, heartbeatExecutionLease } from '../src/mms/queue/ThreadExecutionLease'
import { assertHeldThreadLease } from '../src/mms/actions/GitOperationCoordinator'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PtyManager } from '../src/mms/terminals/PtyManager'
import { WorkerHandle } from '../src/mms/terminals/WorkerHandle'
import {
  ProcessLifecycleController,
  ProcessAdmissionError,
  ProcessShutdownError,
  createDefaultProcessTreeSignaler,
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
import { spawnOwnedShell } from './fixtures/agent-platform/process-lifecycle/ownedShell'

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
    const handle = new WorkerHandle('h1', 'agent-a', 'pty')
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

describe('ProcessLifecycleController real process lifecycle', () => {
  it('shutdown waits for an owned shell/node tree and stops heartbeats', async () => {
    const root = trackRoot(makeLifecycleTempRoot())
    const beats = join(root, 'beats')
    const controller = trackRunner(new ProcessLifecycleController('pty', createDefaultProcessTreeSignaler()))
    spawnOwnedShell(controller, 'agent-tree', root, heartbeatCommand(), heartbeatEnv(beats, { LIFECYCLE_SPAWN_GRANDCHILD: '1' }))
    await waitForHeartbeat(heartbeatPath(beats, 'child'))
    await waitForHeartbeat(heartbeatPath(beats, 'grandchild'))
    const childPid = readOwnedPidFile(pidPath(beats, 'child'))
    const grandchildPid = readOwnedPidFile(pidPath(beats, 'grandchild'))
    expect(childPid).not.toBe(process.pid)
    expect(grandchildPid).not.toBe(process.pid)
    expect(controller.getActiveCount()).toBe(1)

    controller.beginShutdown()
    expect(() => spawnOwnedShell(controller, 'agent-late', root, heartbeatCommand(), heartbeatEnv(beats))).toThrow(ProcessAdmissionError)
    const first = controller.shutdown({ timeoutMs: 20_000 })
    const second = controller.shutdown({ timeoutMs: 20_000 })
    expect(second).toBe(first)
    await first
    await controller.shutdown({ timeoutMs: 1_000 })

    expect(controller.getActiveCount()).toBe(0)
    await waitUntilPidGone(childPid, 'owned child')
    await waitUntilPidGone(grandchildPid, 'owned grandchild')
    const childLines = heartbeatLineCount(heartbeatPath(beats, 'child'))
    const grandLines = heartbeatLineCount(heartbeatPath(beats, 'grandchild'))
    await waitMs(350)
    expect(heartbeatLineCount(heartbeatPath(beats, 'child'))).toBe(childLines)
    expect(heartbeatLineCount(heartbeatPath(beats, 'grandchild'))).toBe(grandLines)
  }, 40_000)
})

describe('injected transport edges', () => {
  it('does not capture or signal a reusable parent PID after exit while its pipes remain open', async () => {
    const handle = new WorkerHandle('exited-open-pipes', 'agent-tree', 'pty')
    const runner = trackRunner(new PtyManager({ treeSignaler: {
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
    const handle = new WorkerHandle('captured-timeout', 'agent-tree', 'pty')
    let alive = true
    let allowExit = false
    let captures = 0
    const runner = trackRunner(new PtyManager({ treeSignaler: {
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
    const handle = new WorkerHandle('capture-first', 'agent-tree', 'pty')
    let descendantsAttached = true
    const runner = trackRunner(new PtyManager({
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
    const handle = new WorkerHandle('parent-exits-first', 'agent-tree', 'pty')
    const runner = trackRunner(new PtyManager({
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

  it('retains a failed tree signal for diagnosis and safely retries while the handle is alive', async () => {
    const handle = new WorkerHandle('retry-tree', 'agent-retry', 'pty')
    let allowSignal = false
    const runner = trackRunner(new PtyManager({
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
    const handle = new WorkerHandle('injected-timeout', 'agent-injected', 'pty')
    // The controller itself: the in-flight drain it shares is the operation under test.
    const runner = trackRunner(
      new ProcessLifecycleController('pty', {
        signal(_pid, mode) {
          signals.push(mode)
        }
      })
    )
    const adopt = (owned: WorkerHandle, signalLocal?: (force: boolean) => void) => {
      runner.assertAdmits('create')
      runner.track({ id: owned.id, agentId: owned.agentId, kind: 'pty', pid: undefined, handle: owned, signaled: false, signalLocal })
    }
    adopt(handle, (force) => {
      signals.push(force ? 'kill' : 'term')
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
    expect(() => adopt(new WorkerHandle('reopen', 'agent-injected', 'pty'))).toThrow(ProcessAdmissionError)
  })
})

describe('PtyManager real process lifecycle', () => {
  it('shutdown waits for onExit of an owned PTY running a heartbeat child', async () => {
    const root = trackRoot(makeLifecycleTempRoot())
    const beats = join(root, 'beats')
    const manager = trackRunner(new PtyManager())
    const taskLease = tryAcquireExecutionLease(root)!
    let released = false
    const ptyId = manager.create('agent-pty', root, heartbeatCommand(), {
      threadId: 'thread-a',
      env: heartbeatEnv(beats, { LIFECYCLE_SPAWN_GRANDCHILD: '1' }),
      ownership: { assert: () => assertHeldThreadLease(root, taskLease), heartbeat: () => { heartbeatExecutionLease(taskLease) }, settled: async () => {
        await waitUntilPidGone(readOwnedPidFile(pidPath(beats, 'child')), 'leased pty child')
        await waitUntilPidGone(readOwnedPidFile(pidPath(beats, 'grandchild')), 'leased pty grandchild')
        releaseExecutionLeaseHandle(taskLease); released = true
      } }
    })
    await waitForHeartbeat(heartbeatPath(beats, 'child'), 2, 20_000)
    await waitForHeartbeat(heartbeatPath(beats, 'grandchild'), 2, 20_000)
    const childPid = readOwnedPidFile(pidPath(beats, 'child'))
    const grandchildPid = readOwnedPidFile(pidPath(beats, 'grandchild'))
    expect(manager.isAlive(ptyId)).toBe(true)
    expect(manager.getActiveCount()).toBe(1)

    manager.beginShutdown()
    expect(released).toBe(false)
    expect(tryAcquireExecutionLease(root)).toBeNull()
    expect(() => manager.write(ptyId, 'echo still-open\r')).toThrow(ProcessAdmissionError)
    expect(() => manager.create('agent-pty', root, heartbeatCommand())).toThrow(ProcessAdmissionError)
    await manager.shutdown({ timeoutMs: 25_000 })
    await manager.shutdown({ timeoutMs: 500 })

    expect(manager.getActiveCount()).toBe(0)
    expect(released).toBe(true)
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
    // A requested stop is not evidence that the process has exited.
    expect(manager.has(ptyA)).toBe(true)
    expect(manager.has(ptyB)).toBe(true)
    expect(manager.list('thread-b')).toHaveLength(1)
    expect(manager.getActiveCount()).toBe(2)
    await manager.killAndWait(ptyA)
    expect(manager.has(ptyA)).toBe(false)
    expect(manager.has(ptyB)).toBe(true)
    expect(manager.getActiveCount()).toBe(1)
    await waitUntilPidGone(readOwnedPidFile(pidPath(beatsA, 'child')), 'stopped thread PTY child')
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
    const runner = trackRunner(new ProcessLifecycleController('pty', createDefaultProcessTreeSignaler()))
    spawnOwnedShell(runner, 'agent-orphan', root, heartbeatCommand(),
      heartbeatEnv(beats, { LIFECYCLE_SPAWN_GRANDCHILD: '1', LIFECYCLE_GRANDCHILD_IGNORE_STOP: '1' }))
    await waitForHeartbeat(heartbeatPath(beats, 'child'))
    await waitForHeartbeat(heartbeatPath(beats, 'grandchild'))
    const childPid = readOwnedPidFile(pidPath(beats, 'child'))
    const grandchildPid = readOwnedPidFile(pidPath(beats, 'grandchild'))
    runner.signalWorker('agent-orphan', false)
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
    const runner = trackRunner(new ProcessLifecycleController('pty', createDefaultProcessTreeSignaler()))
    spawnOwnedShell(runner, 'agent-ignore', root, heartbeatCommand(), heartbeatEnv(beats, { LIFECYCLE_IGNORE_STOP: '1' }))
    await waitForHeartbeat(heartbeatPath(beats, 'child'))
    const childPid = readOwnedPidFile(pidPath(beats, 'child'))
    await runner.shutdown({ timeoutMs: 8_000 })
    expect(runner.getActiveCount()).toBe(0)
    await waitUntilPidGone(childPid, 'posix ignore-stop child')
  }, 20_000)
})


describe('individual terminal termination', () => {
  it('escalates before exit and leaves other process admission and ownership intact', async () => {
    const controller = new ProcessLifecycleController('pty', { signal() {} })
    const stopped = new WorkerHandle('stopped', 'agent-a', 'pty')
    const other = new WorkerHandle('other', 'agent-b', 'pty')
    const signals: boolean[] = []
    controller.track({ id: 'stopped', agentId: 'agent-a', kind: 'pty', pid: undefined, handle: stopped, signaled: false,
      signalLocal(force) { signals.push(force); if (force) { stopped.recordExit(null, 'SIGKILL'); stopped.recordClose() } } })
    controller.track({ id: 'other', agentId: 'agent-b', kind: 'pty', pid: undefined, handle: other, signaled: false })
    const stopping = controller.stopWorker('stopped', { timeoutMs: 120 })
    expect(stopped.alive).toBe(true)
    expect(controller.snapshotRemaining()).toHaveLength(2)
    await stopping
    expect(signals).toEqual([false, true])
    expect(controller.snapshotRemaining()).toEqual([expect.objectContaining({ id: 'other', alive: true, signaled: false })])
    expect(() => controller.assertAdmits('create')).not.toThrow()
    other.recordExit(0, null); other.recordClose()
  })

  it('retains ownership when individual forced termination has no exit proof', async () => {
    const controller = new ProcessLifecycleController('pty', { signal() {} })
    const handle = new WorkerHandle('stuck', 'agent-a', 'pty')
    controller.track({ id: 'stuck', agentId: 'agent-a', kind: 'pty', pid: undefined, handle, signaled: false })
    await expect(controller.stopWorker('stuck', { timeoutMs: 120 })).rejects.toMatchObject({
      code: 'shutdown_timeout', remaining: [expect.objectContaining({ id: 'stuck', alive: true, closed: false })]
    })
    expect(handle.exit).toBeUndefined()
    expect(controller.getActiveCount()).toBe(1)
    handle.recordExit(0, null); handle.recordClose()
    await controller.stopWorker('stuck', { timeoutMs: 120 })
    expect(controller.getActiveCount()).toBe(0)
  })
})
