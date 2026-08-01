import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isProcessAlive } from '../src/mms/queue/processLiveness'
import {
  acquireExecutionLease,
  createLeaseToken,
  getExecutionLeasePath,
  heartbeatExecutionLease,
  isLeaseHeldByLivePeer,
  releaseExecutionLease,
  releaseExecutionLeaseHandle,
  tryAcquireExecutionLease,
  tryReclaimStaleLease,
  withQueueMutationLock,
  type ThreadLeaseOwner
} from '../src/mms/queue/ThreadExecutionLease'
import { mutateDurableQueue, readDurableQueue } from '../src/mms/queue/durableQueue'
import { enqueueMessage, listPendingQueue, dropSteerItems } from '../src/mms/queue/ThreadMessageQueue'
import { ProjectManager } from '../src/mms/data/ProjectManager'
import { ThreadDataStore } from '../src/mms/data/ThreadDataStore'
import {
  classifySigint,
  createSigintState,
  DEFAULT_SIGINT_EXIT_WINDOW_MS
} from '../src/cli/interactive/sigintSemantics'

describe('process liveness', () => {
  it('reports the current process as alive', () => {
    expect(isProcessAlive(process.pid)).toBe(true)
  })

  it('reports an unused high pid as dead', () => {
    // Extremely unlikely to be a live process.
    expect(isProcessAlive(2_147_000_000)).toBe(false)
  })

  it('rejects non-positive pids', () => {
    expect(isProcessAlive(0)).toBe(false)
    expect(isProcessAlive(-1)).toBe(false)
  })
})

describe('ThreadExecutionLease', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mousse-lease-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('acquires atomically and refuses a second live owner', () => {
    const a = tryAcquireExecutionLease(dir, { source: 'owner-a', token: 'tok-a' })
    expect(a).not.toBeNull()
    expect(a!.owner.pid).toBe(process.pid)
    expect(a!.owner.token).toBe('tok-a')

    const b = tryAcquireExecutionLease(dir, { source: 'owner-b', token: 'tok-b' })
    expect(b).toBeNull()

    // Same-process held lease is not an *external* peer (orchestrator uses in-memory turn too).
    expect(isLeaseHeldByLivePeer(dir, 'other-token').held).toBe(false)
    expect(isLeaseHeldByLivePeer(dir, 'tok-a').held).toBe(false)

    // Simulate a live foreign owner via a short-lived child process pid.
    const { spawn } = require('child_process') as typeof import('child_process')
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1000)'], {
      stdio: 'ignore',
      windowsHide: true
    })
    try {
      const foreign: ThreadLeaseOwner = {
        pid: child.pid!,
        token: 'foreign-live',
        acquiredAt: new Date().toISOString(),
        heartbeatAt: new Date().toISOString(),
        source: 'peer'
      }
      // Release local first so file can be replaced for the peer simulation.
      releaseExecutionLeaseHandle(a!)
      writeFileSync(getExecutionLeasePath(dir), JSON.stringify(foreign, null, 2), 'utf-8')
      expect(isLeaseHeldByLivePeer(dir).held).toBe(true)
      expect(tryAcquireExecutionLease(dir, { token: 'us' })).toBeNull()
      // Must not delete a live foreign owner.
      expect(tryReclaimStaleLease(dir)).toBe(false)
    } finally {
      child.kill()
    }
  })

  it('ownership-checked release never deletes another owner lock', () => {
    const a = tryAcquireExecutionLease(dir, { token: 'mine' })!
    expect(releaseExecutionLease(dir, 'foreign-token')).toBe(false)
    expect(existsSync(getExecutionLeasePath(dir))).toBe(true)
    expect(releaseExecutionLease(dir, 'mine')).toBe(true)
    expect(existsSync(getExecutionLeasePath(dir))).toBe(false)
  })

  it('reclaims stale lease from a dead owner without touching live owners', () => {
    const lockPath = getExecutionLeasePath(dir)
    const stale: ThreadLeaseOwner = {
      pid: 2_147_000_001,
      token: 'dead-owner',
      acquiredAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
      source: 'stale'
    }
    writeFileSync(lockPath, JSON.stringify(stale, null, 2), 'utf-8')
    expect(tryReclaimStaleLease(dir)).toBe(true)
    expect(existsSync(lockPath)).toBe(false)

    const live = tryAcquireExecutionLease(dir, { token: 'live' })!
    // Simulate "reclaim" attempt against live owner — must fail.
    expect(tryReclaimStaleLease(dir)).toBe(false)
    expect(existsSync(lockPath)).toBe(true)
    // Second acquire while held must fail (same process, tracked token).
    expect(tryAcquireExecutionLease(dir, { token: 'other' })).toBeNull()
    releaseExecutionLeaseHandle(live)
  })

  it('heartbeats only when still the owner', () => {
    const handle = tryAcquireExecutionLease(dir, { token: 'hb' })!
    const before = handle.owner.heartbeatAt
    expect(heartbeatExecutionLease(handle)).toBe(true)
    expect(handle.owner.heartbeatAt >= before).toBe(true)

    // Forge a different owner file; heartbeat must refuse.
    const forged: ThreadLeaseOwner = {
      pid: process.pid,
      token: 'other',
      acquiredAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString()
    }
    writeFileSync(getExecutionLeasePath(dir), JSON.stringify(forged, null, 2), 'utf-8')
    expect(heartbeatExecutionLease(handle)).toBe(false)
    releaseExecutionLease(dir, 'other')
  })

  it('acquireExecutionLease throws LeaseBusyError when tryOnce and busy', () => {
    const a = tryAcquireExecutionLease(dir, { token: 'busy' })!
    expect(() => acquireExecutionLease(dir, { tryOnce: true, token: 'waiter' })).toThrow(
      /busy|Lease/
    )
    releaseExecutionLeaseHandle(a)
  })

  it('createLeaseToken produces unique tokens', () => {
    const tokens = new Set(Array.from({ length: 20 }, () => createLeaseToken()))
    expect(tokens.size).toBe(20)
  })
})

describe('queue mutation lock + durable FIFO across owners', () => {
  let home: string
  let store: ThreadDataStore

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'mousse-qmut-'))
    process.env.MOUSSE_HOME = home
    store = new ThreadDataStore(new ProjectManager())
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
    delete process.env.MOUSSE_HOME
  })

  it('serializes cross-owner enqueue RMW without lost updates', () => {
    const thread = store.createThread('Fifo')
    // Simulate two process identities writing under the mutation lock.
    const a = mutateDurableQueue(store, thread.id, (items) => {
      return enqueueMessage(items, {
        threadId: thread.id,
        content: 'from-owner-a',
        source: 'cli-a'
      }).items
    })
    const b = mutateDurableQueue(store, thread.id, (items) => {
      return enqueueMessage(items, {
        threadId: thread.id,
        content: 'from-owner-b',
        source: 'cli-b'
      }).items
    })
    expect(listPendingQueue(b).map((i) => i.content)).toEqual(['from-owner-a', 'from-owner-b'])
    expect(listPendingQueue(a)).toHaveLength(1)
    expect(readDurableQueue(store, thread.id).map((i) => i.content)).toEqual([
      'from-owner-a',
      'from-owner-b'
    ])
  })

  it('drops external steer items once (never as later normal messages)', () => {
    const thread = store.createThread('SteerOnce')
    mutateDurableQueue(store, thread.id, (items) => {
      let next = enqueueMessage(items, {
        threadId: thread.id,
        content: 'steer-me',
        intent: 'steer',
        source: 'peer'
      }).items
      next = enqueueMessage(next, {
        threadId: thread.id,
        content: 'normal-later',
        intent: 'normal'
      }).items
      return next
    })
    const before = readDurableQueue(store, thread.id)
    const steerId = before.find((i) => i.intent === 'steer')!.id
    const after = mutateDurableQueue(store, thread.id, (disk) => dropSteerItems(disk, [steerId]))
    expect(after.find((i) => i.id === steerId)).toBeUndefined()
    expect(listPendingQueue(after).map((i) => i.content)).toEqual(['normal-later'])
  })

  it('withQueueMutationLock is re-entrant for the same path', () => {
    const threadDir = store.getThreadDir(store.createThread('Reenter').id)
    const value = withQueueMutationLock(threadDir, () =>
      withQueueMutationLock(threadDir, () => 42)
    )
    expect(value).toBe(42)
  })
})

describe('Ctrl+C helper semantics', () => {
  it('first press stops turn; second within window exits', () => {
    const state = createSigintState()
    const t0 = 1_000_000
    expect(classifySigint(state, t0)).toBe('stop_turn')
    expect(classifySigint(state, t0 + DEFAULT_SIGINT_EXIT_WINDOW_MS - 1)).toBe('exit')
  })

  it('press after the window is another stop, not exit', () => {
    const state = createSigintState()
    const t0 = 1_000_000
    expect(classifySigint(state, t0)).toBe('stop_turn')
    expect(classifySigint(state, t0 + DEFAULT_SIGINT_EXIT_WINDOW_MS + 50)).toBe('stop_turn')
  })
})
