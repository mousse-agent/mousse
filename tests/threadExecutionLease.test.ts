import {
  mkdtempSync,
  openSync,
  closeSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  utimesSync,
  unlinkSync
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  isOwnerLive,
  isProcessAlive,
  PROCESS_INSTANCE_ID
} from '../src/mms/queue/processLiveness'
import {
  acquireExecutionLease,
  createLeaseToken,
  getExecutionLeasePath,
  getQueueMutationLockPath,
  heartbeatExecutionLease,
  isLeaseHeldByLivePeer,
  LOCK_CORRUPT_STALE_MS,
  LOCK_PUBLICATION_GRACE_MS,
  mayReclaimUnreadableLock,
  releaseExecutionLease,
  releaseExecutionLeaseHandle,
  tryAcquireExecutionLease,
  tryReclaimStaleLease,
  withQueueMutationLock,
  type ThreadLeaseOwner
} from '../src/mms/queue/ThreadExecutionLease'
import {
  claimNextNormalDurable,
  completeClaimDurable,
  mutateDurableQueue,
  readDurableQueue,
  reclaimAbandonedClaimsDurable,
  releaseClaimDurable
} from '../src/mms/queue/durableQueue'
import {
  clearPendingQueue,
  enqueueMessage,
  listPendingQueue,
  dropSteerItems,
  claimNextNormal
} from '../src/mms/queue/ThreadMessageQueue'
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
    expect(isOwnerLive({ pid: process.pid, processInstanceId: PROCESS_INSTANCE_ID })).toBe(true)
  })

  it('reports an unused high pid as dead', () => {
    // Extremely unlikely to be a live process.
    expect(isProcessAlive(2_147_000_000)).toBe(false)
    expect(isOwnerLive({ pid: 2_147_000_000, processInstanceId: 'x' })).toBe(false)
  })

  it('rejects non-positive pids', () => {
    expect(isProcessAlive(0)).toBe(false)
    expect(isProcessAlive(-1)).toBe(false)
  })

  it('treats same pid with a different process instance id as not live', () => {
    expect(
      isOwnerLive({ pid: process.pid, processInstanceId: 'not-this-process-instance' })
    ).toBe(false)
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
        processInstanceId: 'foreign-instance',
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
      processInstanceId: 'dead-instance',
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
      processInstanceId: PROCESS_INSTANCE_ID,
      acquiredAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString()
    }
    writeFileSync(getExecutionLeasePath(dir), JSON.stringify(forged, null, 2), 'utf-8')
    expect(heartbeatExecutionLease(handle)).toBe(false)
    releaseExecutionLease(dir, 'other')
  })

  it('acquireExecutionLease throws LeaseBusyError when busy (no busy-spin)', () => {
    const a = tryAcquireExecutionLease(dir, { token: 'busy' })!
    expect(() => acquireExecutionLease(dir, { token: 'waiter' })).toThrow(/busy|Lease/)
    releaseExecutionLeaseHandle(a)
  })

  it('createLeaseToken produces unique tokens', () => {
    const tokens = new Set(Array.from({ length: 20 }, () => createLeaseToken()))
    expect(tokens.size).toBe(20)
  })

  it('empty lock publication cannot be stolen during grace', () => {
    const lockPath = getExecutionLeasePath(dir)
    const fd = openSync(lockPath, 'wx')
    closeSync(fd) // empty file = mid-publication
    expect(mayReclaimUnreadableLock(lockPath)).toBe(false)
    expect(tryReclaimStaleLease(dir)).toBe(false)
    expect(tryAcquireExecutionLease(dir, { token: 'thief' })).toBeNull()
    expect(existsSync(lockPath)).toBe(true)
  })

  it('recent corrupt lock is held; old corrupt lock is reclaimed', () => {
    const lockPath = getExecutionLeasePath(dir)
    writeFileSync(lockPath, '{not-json', 'utf-8')
    const now = Date.now()
    // Recent corrupt: within stale threshold
    utimesSync(lockPath, new Date(now - LOCK_PUBLICATION_GRACE_MS - 100), new Date(now - LOCK_PUBLICATION_GRACE_MS - 100))
    expect(mayReclaimUnreadableLock(lockPath, now)).toBe(false)
    expect(tryReclaimStaleLease(dir)).toBe(false)

    // Old corrupt: past stale threshold
    const old = now - LOCK_CORRUPT_STALE_MS - 1_000
    utimesSync(lockPath, new Date(old), new Date(old))
    expect(mayReclaimUnreadableLock(lockPath, now)).toBe(true)
    expect(tryReclaimStaleLease(dir)).toBe(true)
    expect(existsSync(lockPath)).toBe(false)
    expect(tryAcquireExecutionLease(dir, { token: 'after-corrupt' })).not.toBeNull()
  })

  it('live owner is protected from reclaim and overwrite', () => {
    const a = tryAcquireExecutionLease(dir, { token: 'live-a' })!
    expect(tryReclaimStaleLease(dir)).toBe(false)
    expect(tryAcquireExecutionLease(dir, { token: 'live-b' })).toBeNull()
    expect(releaseExecutionLease(dir, 'not-a')).toBe(false)
    expect(existsSync(getExecutionLeasePath(dir))).toBe(true)
    releaseExecutionLeaseHandle(a)
  })

  it('release does not unlink unreadable/new partial publication', () => {
    const lockPath = getExecutionLeasePath(dir)
    const held = tryAcquireExecutionLease(dir, { token: 'mine' })!
    releaseExecutionLeaseHandle(held)
    // New empty publication appears (another owner's wx race).
    const fd = openSync(lockPath, 'wx')
    closeSync(fd)
    // Caller still has the old token; must not delete the new empty file.
    expect(releaseExecutionLease(dir, 'mine')).toBe(false)
    expect(existsSync(lockPath)).toBe(true)
    expect(readFileSync(lockPath, 'utf-8').trim()).toBe('')
  })

  it('heartbeat does not replace a foreign lease after path replacement', () => {
    const handle = tryAcquireExecutionLease(dir, { token: 'hb-owner' })!
    const lockPath = getExecutionLeasePath(dir)
    const foreign: ThreadLeaseOwner = {
      pid: 2_147_000_099,
      token: 'foreign-after-replace',
      processInstanceId: 'foreign',
      acquiredAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString()
    }
    // Path replaced by another owner between our acquire and heartbeat.
    writeFileSync(lockPath, JSON.stringify(foreign, null, 2), 'utf-8')
    expect(heartbeatExecutionLease(handle)).toBe(false)
    const still = JSON.parse(readFileSync(lockPath, 'utf-8')) as ThreadLeaseOwner
    expect(still.token).toBe('foreign-after-replace')
    // Cleanup foreign without ownership (manual unlink for test teardown).
    unlinkSync(lockPath)
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

  it('never mutates without the lock when a live peer owns it', () => {
    const threadDir = store.getThreadDir(store.createThread('Busy lock').id)
    const { spawn } = require('child_process') as typeof import('child_process')
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1000)'], {
      stdio: 'ignore',
      windowsHide: true
    })
    try {
      writeFileSync(
        getQueueMutationLockPath(threadDir),
        JSON.stringify({
          pid: child.pid,
          processInstanceId: 'foreign',
          token: 'foreign-queue-owner',
          acquiredAt: new Date().toISOString()
        })
      )
      let mutated = false
      expect(() =>
        withQueueMutationLock(threadDir, () => {
          mutated = true
        })
      ).toThrow(/mutation lock is busy/i)
      expect(mutated).toBe(false)
    } finally {
      child.kill()
    }
  })

  it('durable claim/release/complete preserve FIFO under the mutation lock', () => {
    const thread = store.createThread('Claim FIFO')
    mutateDurableQueue(store, thread.id, (items) => {
      let next = enqueueMessage(items, { threadId: thread.id, content: 'one' }).items
      next = enqueueMessage(next, { threadId: thread.id, content: 'two' }).items
      next = enqueueMessage(next, { threadId: thread.id, content: 'three' }).items
      return next
    })

    const first = claimNextNormalDurable(store, thread.id, {
      ownerPid: process.pid,
      ownerToken: 'owner-1'
    })
    expect(first?.content).toBe('one')
    expect(first?.order).toBe(0)
    expect(listPendingQueue(readDurableQueue(store, thread.id)).map((i) => i.content)).toEqual([
      'two',
      'three'
    ])

    // Live-owner protection: wrong token cannot release.
    expect(releaseClaimDurable(store, thread.id, first!.id, { ownerToken: 'nope' })).toBeNull()
    expect(readDurableQueue(store, thread.id).find((i) => i.id === first!.id)?.state).toBe(
      'claimed'
    )

    const released = releaseClaimDurable(store, thread.id, first!.id, { ownerToken: 'owner-1' })
    expect(released?.id).toBe(first!.id)
    expect(released?.order).toBe(0)
    expect(listPendingQueue(readDurableQueue(store, thread.id)).map((i) => i.content)).toEqual([
      'one',
      'two',
      'three'
    ])

    const claimed = claimNextNormalDurable(store, thread.id, {
      ownerPid: process.pid,
      ownerToken: 'owner-2'
    })
    completeClaimDurable(store, thread.id, claimed!.id, { ownerToken: 'owner-2' })
    expect(listPendingQueue(readDurableQueue(store, thread.id)).map((i) => i.content)).toEqual([
      'two',
      'three'
    ])
  })

  it('clearPendingQueue and reclaim leave live claims alone; abandon dead claims', () => {
    const thread = store.createThread('Claim reclaim')
    mutateDurableQueue(store, thread.id, (items) => {
      let next = enqueueMessage(items, { threadId: thread.id, content: 'dead' }).items
      next = enqueueMessage(next, { threadId: thread.id, content: 'live' }).items
      next = enqueueMessage(next, { threadId: thread.id, content: 'pending-clear' }).items
      return next
    })

    const dead = claimNextNormalDurable(store, thread.id, {
      ownerPid: 2_147_000_060,
      ownerToken: 'dead'
    })
    const live = claimNextNormalDurable(store, thread.id, {
      ownerPid: process.pid,
      ownerToken: 'live'
    })
    expect(dead?.content).toBe('dead')
    expect(live?.content).toBe('live')

    mutateDurableQueue(store, thread.id, (disk) => clearPendingQueue(disk))
    const afterClear = readDurableQueue(store, thread.id)
    expect(afterClear.map((i) => i.content).sort()).toEqual(['dead', 'live'])
    expect(afterClear.every((i) => i.state === 'claimed')).toBe(true)

    const reclaimed = reclaimAbandonedClaimsDurable(store, thread.id, {
      isOwnerLive: (claim) => claim.ownerToken === 'live',
      isAccepted: () => false
    })
    expect(reclaimed.released.map((i) => i.content)).toEqual(['dead'])
    expect(reclaimed.items.find((i) => i.id === live!.id)?.state).toBe('claimed')
    expect(reclaimed.items.find((i) => i.id === dead!.id)?.state).toBe('pending')
  })

  it('claimNextNormal under lock does not remove the item (atomic claim not remove-before-run)', () => {
    const thread = store.createThread('Atomic claim')
    mutateDurableQueue(store, thread.id, (items) =>
      enqueueMessage(items, { threadId: thread.id, content: 'stay' }).items
    )
    const after = mutateDurableQueue(store, thread.id, (disk) => {
      const result = claimNextNormal(disk, {
        ownerPid: process.pid,
        ownerToken: 't'
      })
      expect(result.claimed?.content).toBe('stay')
      expect(result.items).toHaveLength(1)
      expect(result.items[0].state).toBe('claimed')
      return result.items
    })
    expect(after).toHaveLength(1)
    expect(after[0].state).toBe('claimed')
  })

  it('reclaimAbandonedClaimsDurable aborts without save when transcript read throws', () => {
    const thread = store.createThread('Reclaim fail closed')
    mutateDurableQueue(store, thread.id, (items) =>
      enqueueMessage(items, { threadId: thread.id, content: 'held' }).items
    )
    const claimed = claimNextNormalDurable(store, thread.id, {
      ownerPid: 2_147_000_080,
      ownerToken: 'dead'
    })!
    // Plant acceptance so an empty-set fallback would wrongly complete; throw must abort instead.
    store.saveThreadData(thread.id, {
      messages: [
        {
          id: 'u',
          role: 'user',
          content: 'held',
          timestamp: new Date().toISOString(),
          queueItemId: claimed.id
        }
      ],
      agents: [],
      tasks: []
    })

    const loadSpy = vi.spyOn(store, 'loadThreadData').mockImplementation(() => {
      throw new Error('EIO: messages unreadable')
    })
    expect(() => reclaimAbandonedClaimsDurable(store, thread.id)).toThrow(/unreadable|EIO/i)
    loadSpy.mockRestore()

    expect(readDurableQueue(store, thread.id).find((i) => i.id === claimed.id)?.state).toBe(
      'claimed'
    )
  })

  it('reclaim loads provenance inside the queue mutation critical section', () => {
    const thread = store.createThread('In-lock provenance')
    mutateDurableQueue(store, thread.id, (items) =>
      enqueueMessage(items, { threadId: thread.id, content: 'late-accept' }).items
    )
    const claimed = claimNextNormalDurable(store, thread.id, {
      ownerPid: 2_147_000_081,
      ownerToken: 'dead'
    })!

    // No provenance on disk yet — a stale pre-lock snapshot would treat as not accepted and release.
    // Plant acceptance only when loadThreadData runs (inside mutator, after loadMessageQueue).
    const phase: string[] = []
    const realLoadQueue = store.loadMessageQueue.bind(store)
    const realLoadThread = store.loadThreadData.bind(store)
    const realSaveQueue = store.saveMessageQueue.bind(store)

    vi.spyOn(store, 'loadMessageQueue').mockImplementation((id) => {
      phase.push('loadQueue')
      return realLoadQueue(id)
    })
    vi.spyOn(store, 'loadThreadData').mockImplementation((id) => {
      phase.push('loadThread')
      // Simulate accept landing before this in-lock read (stale-read interleaving).
      store.saveThreadData(id, {
        messages: [
          {
            id: 'u-late',
            role: 'user',
            content: 'late-accept',
            timestamp: new Date().toISOString(),
            queueItemId: claimed.id
          }
        ],
        agents: [],
        tasks: []
      })
      return realLoadThread(id)
    })
    vi.spyOn(store, 'saveMessageQueue').mockImplementation((id, queue) => {
      phase.push('saveQueue')
      return realSaveQueue(id, queue)
    })

    const result = reclaimAbandonedClaimsDurable(store, thread.id)
    expect(result.completed.map((i) => i.id)).toEqual([claimed.id])
    expect(result.released).toHaveLength(0)
    expect(readDurableQueue(store, thread.id).find((i) => i.id === claimed.id)).toBeUndefined()

    // Provenance read happens inside the mutation (between loadQueue and saveQueue).
    const loadQueueIdx = phase.indexOf('loadQueue')
    const loadThreadIdx = phase.indexOf('loadThread')
    const saveQueueIdx = phase.indexOf('saveQueue')
    expect(loadQueueIdx).toBeGreaterThanOrEqual(0)
    expect(loadThreadIdx).toBeGreaterThan(loadQueueIdx)
    expect(saveQueueIdx).toBeGreaterThan(loadThreadIdx)

    vi.restoreAllMocks()
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
