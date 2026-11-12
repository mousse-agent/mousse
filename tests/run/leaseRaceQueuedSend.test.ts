// A message sent while other work holds the thread's execution lease (a git operation, a workspace restore, a peer
// process) waits in the queue and runs once, as soon as the lease is free: no restart, no Send now.
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProjectManager } from '../../src/mms/data/ProjectManager'
import { ThreadDataStore } from '../../src/mms/data/ThreadDataStore'
import { OrchestratorService } from '../../src/mms/orchestrator/OrchestratorService'
import { holdQueueAfterStop, listPendingQueue } from '../../src/mms/queue/ThreadMessageQueue'
import { mutateDurableQueue } from '../../src/mms/queue/durableQueue'
import {
  getExecutionLeasePath,
  releaseExecutionLeaseHandle,
  tryAcquireExecutionLease
} from '../../src/mms/queue/ThreadExecutionLease'
import { createOrchestrator, piAdapter, waitFor, type ScriptedAdapter } from './phase6Fixture'

describe('a send that lost the race for the thread lease', () => {
  let home: string
  let store: ThreadDataStore
  let orch: OrchestratorService
  let adapter: ScriptedAdapter

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'mousse-lease-race-'))
    // Each test's threads live in its own home: a restart recovers only this test's queues.
    store = new ThreadDataStore(new ProjectManager(), home)
    adapter = piAdapter(() => 'ok')
    orch = createOrchestrator(home, store, [adapter])
    orch.setPersistCallback((threadId) => {
      if (!threadId) return
      const existing = store.loadThreadData(threadId)
      store.saveThreadData(threadId, {
        messages: orch.getMessages(threadId),
        agents: existing.agents,
        tasks: existing.tasks,
        llmContext: orch.getNativeContext(threadId)
      })
    })
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await orch.shutdown(5_000)
    rmSync(home, { recursive: true, force: true })
    delete process.env.MOUSSE_HOME
  })

  const prompts = (): string[] => adapter.turns.map((turn) => turn.prompt)
  const ran = (text: string): number => prompts().filter((prompt) => prompt.includes(text)).length
  const settle = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

  it('runs once as soon as background work in this process releases the lease', async () => {
    const thread = store.createThread('Lease race')
    const lease = tryAcquireExecutionLease(store.getThreadDir(thread.id), { source: 'agent-workspace' })!
    expect(lease).not.toBeNull()

    const result = await orch.send('LEASE-A while the job runs', false, { threadId: thread.id })
    expect(result.queued).toBe(true)
    expect(result.queueItem?.source).toBe('lease-race')
    expect(result.queueItem?.heldAfterStop).toBeUndefined()
    await settle(50)
    expect(adapter.turns).toHaveLength(0)

    releaseExecutionLeaseHandle(lease)
    await waitFor(() => ran('LEASE-A') === 1, 'the queued message to run after the lease is released', 2_000)
    await waitFor(() => listPendingQueue(store.loadMessageQueue(thread.id)).length === 0, 'an empty queue', 2_000)
    await settle(100)
    expect(ran('LEASE-A')).toBe(1)
    expect(adapter.turns).toHaveLength(1)
  })

  it('keeps the order of messages queued behind the lease, each running once', async () => {
    const thread = store.createThread('Lease race order')
    const lease = tryAcquireExecutionLease(store.getThreadDir(thread.id), { source: 'git-operation' })!
    await orch.send('LEASE-1 first', false, { threadId: thread.id })
    await orch.send('LEASE-2 second', false, { threadId: thread.id })
    expect(listPendingQueue(store.loadMessageQueue(thread.id)).map((item) => item.content)).toEqual(['LEASE-1 first', 'LEASE-2 second'])

    releaseExecutionLeaseHandle(lease)
    await waitFor(() => ran('LEASE-2') === 1, 'both queued messages to run', 3_000)
    await settle(100)
    expect(prompts().filter((prompt) => prompt.includes('LEASE-')).map((prompt) => (prompt.includes('LEASE-1') ? 1 : 2))).toEqual([1, 2])
    expect(adapter.turns).toHaveLength(2)
  })

  it('runs a lease-race message first in a queue a Stop holds, and never marks it held', async () => {
    const thread = store.createThread('Lease race after Stop')
    orch.enqueueForThread(thread.id, 'HELD-OLD queued before the Stop')
    mutateDurableQueue(store, thread.id, holdQueueAfterStop)
    const lease = tryAcquireExecutionLease(store.getThreadDir(thread.id), { source: 'workspace-restore' })!

    const result = await orch.send('LEASE-S sent after the Stop', false, { threadId: thread.id })
    expect(result.queueItem?.source).toBe('lease-race')
    expect(store.loadMessageQueue(thread.id).find((item) => item.id === result.queueItem?.id)?.heldAfterStop).toBeUndefined()

    releaseExecutionLeaseHandle(lease)
    await waitFor(() => ran('LEASE-S') === 1, 'the lease-race message to run without Send now', 2_000)
    await settle(100)
    expect(prompts()[0]).toContain('LEASE-S')
    expect(ran('LEASE-S')).toBe(1)
  })

  it('runs once when another process held the lease and releases it', async () => {
    const thread = store.createThread('Lease race across processes')
    const leasePath = getExecutionLeasePath(store.getThreadDir(thread.id))
    const now = new Date().toISOString()
    // A live peer (this test's parent process) owns the lease, as the app's other process would.
    writeFileSync(leasePath, JSON.stringify({ pid: process.ppid, token: 'peer-token', processInstanceId: 'peer-instance', acquiredAt: now, heartbeatAt: now, source: 'git-operation' }))
    // The peer took the lease after this send looked: the send loses the race at the lease itself.
    const peek = vi.spyOn(orch, 'isThreadLeaseHeldExternally').mockReturnValue(false)
    const raced = await orch.send('LEASE-X1 raced', false, { threadId: thread.id })
    expect(raced.queueItem?.source).toBe('lease-race')
    peek.mockRestore()
    // And one sent while the peer visibly holds it.
    const queued = await orch.send('LEASE-X2 behind the peer', false, { threadId: thread.id })
    expect(queued.queued).toBe(true)
    await settle(50)
    expect(adapter.turns).toHaveLength(0)

    unlinkSync(leasePath)
    await waitFor(() => ran('LEASE-X2') === 1, 'both messages to run after the peer released the lease', 5_000)
    await settle(100)
    expect(ran('LEASE-X1')).toBe(1)
    expect(prompts()[0]).toContain('LEASE-X1')
    expect(adapter.turns).toHaveLength(2)
  })

  type LeaseWait = { itemIds: Set<string>; poll: NodeJS.Timeout | null }
  const leaseWaits = (): Map<string, LeaseWait> => (orch as unknown as { leaseWaits: Map<string, LeaseWait> }).leaseWaits
  /** A live peer (this test's parent process) holds the thread's lease, as the app's other process would. */
  const holdAsPeer = (threadId: string): string => {
    const leasePath = getExecutionLeasePath(store.getThreadDir(threadId))
    const now = new Date().toISOString()
    writeFileSync(leasePath, JSON.stringify({ pid: process.ppid, token: 'peer-token', processInstanceId: 'peer-instance', acquiredAt: now, heartbeatAt: now, source: 'cli-turn' }))
    return leasePath
  }

  it('keeps a message held when a Stop comes after it started waiting for another process', async () => {
    const thread = store.createThread('Lease wait then Stop')
    const leasePath = holdAsPeer(thread.id)
    const result = await orch.send('LEASE-H behind the peer', false, { threadId: thread.id })
    expect(result.queued).toBe(true)
    expect(leaseWaits().has(thread.id)).toBe(true)

    // The person stops the peer's turn: what waits in the queue, this message included, is held.
    mutateDurableQueue(store, thread.id, holdQueueAfterStop)
    unlinkSync(leasePath)
    await settle(1_200)

    expect(adapter.turns).toHaveLength(0)
    const pending = listPendingQueue(store.loadMessageQueue(thread.id))
    expect(pending.map((item) => [item.content, item.heldAfterStop])).toEqual([['LEASE-H behind the peer', true]])
    expect(leaseWaits().has(thread.id)).toBe(false)
  })

  it('runs nothing a Stop held when the waiting message cannot be moved first', async () => {
    const thread = store.createThread('Lease wait reorder fails')
    orch.enqueueForThread(thread.id, 'HELD-OLD queued before the Stop')
    mutateDurableQueue(store, thread.id, holdQueueAfterStop)
    const lease = tryAcquireExecutionLease(store.getThreadDir(thread.id), { source: 'git-operation' })!
    await orch.send('LEASE-F sent after the Stop', false, { threadId: thread.id })

    const save = store.saveMessageQueue.bind(store)
    let refused = 0
    vi.spyOn(store, 'saveMessageQueue').mockImplementation((threadId, items) => {
      if (threadId === thread.id && listPendingQueue(items)[0]?.content.includes('LEASE-F')) {
        refused++
        throw new Error('the disk is full')
      }
      return save(threadId, items)
    })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    releaseExecutionLeaseHandle(lease)
    await settle(400)

    expect(refused).toBe(1)
    expect(adapter.turns).toHaveLength(0)
    const pending = listPendingQueue(store.loadMessageQueue(thread.id))
    expect(pending.map((item) => [item.content, item.state, item.heldAfterStop])).toEqual([
      ['HELD-OLD queued before the Stop', 'pending', true],
      ['LEASE-F sent after the Stop', 'pending', undefined]
    ])
  })

  it('polls only for a holder in another process, without loading the waiting thread', async () => {
    const local = store.createThread('Lease wait local holder')
    const lease = tryAcquireExecutionLease(store.getThreadDir(local.id), { source: 'terminal' })!
    await orch.send('LEASE-L local holder', false, { threadId: local.id })
    expect(leaseWaits().get(local.id)?.poll).toBeNull()

    const peer = store.createThread('Lease wait peer holder')
    const leasePath = holdAsPeer(peer.id)
    await orch.send('LEASE-P peer holder', false, { threadId: peer.id })
    expect(leaseWaits().get(peer.id)?.poll).not.toBeNull()

    const load = vi.spyOn(orch, 'getOrCreateSession')
    await settle(1_200)
    expect(load).not.toHaveBeenCalled()
    expect(adapter.turns).toHaveLength(0)

    unlinkSync(leasePath)
    await waitFor(() => ran('LEASE-P') === 1, 'the peer-held message to run', 2_000)
    releaseExecutionLeaseHandle(lease)
    await waitFor(() => ran('LEASE-L') === 1, 'the locally held message to run', 2_000)
  })

  it('stops waiting when the message is removed while the lease is still held', async () => {
    const thread = store.createThread('Lease wait removed')
    const leasePath = holdAsPeer(thread.id)
    const result = await orch.send('LEASE-R removed', false, { threadId: thread.id })
    expect(orch.removeQueuedItem(thread.id, result.queueItem!.id)).not.toBeNull()
    await waitFor(() => !leaseWaits().has(thread.id), 'the wait to end while the peer still holds the lease', 2_000)

    unlinkSync(leasePath)
    await settle(800)
    expect(adapter.turns).toHaveLength(0)
  })

  it('stops waiting when the thread is deleted, and waits again once it is restored', async () => {
    const thread = store.createThread('Lease wait deleted')
    const leasePath = holdAsPeer(thread.id)
    const result = await orch.send('LEASE-D deleted then restored', false, { threadId: thread.id })
    const queued = store.loadMessageQueue(thread.id)

    orch.markThreadDeleted(thread.id)
    expect(leaseWaits().has(thread.id)).toBe(false)
    await settle(200)
    // The trash keeps the thread's queue; a restore brings it back.
    store.saveMessageQueue(thread.id, queued)
    orch.markThreadRestored(thread.id)
    expect(leaseWaits().get(thread.id)?.itemIds.has(result.queueItem!.id)).toBe(true)
    expect(leaseWaits().get(thread.id)?.poll).not.toBeNull()

    unlinkSync(leasePath)
    await waitFor(() => ran('LEASE-D') === 1, 'the restored message to run after the peer released the lease', 2_000)
    await settle(100)
    expect(ran('LEASE-D')).toBe(1)
  })

  it('runs nothing a Stop held when the waiting message is gone by the time the queue is locked', async () => {
    const thread = store.createThread('Lease wait message gone')
    orch.enqueueForThread(thread.id, 'HELD-OLD queued before the Stop')
    mutateDurableQueue(store, thread.id, holdQueueAfterStop)
    const lease = tryAcquireExecutionLease(store.getThreadDir(thread.id), { source: 'git-operation' })!
    const result = await orch.send('LEASE-G sent after the Stop', false, { threadId: thread.id })

    // Another process removes the message after the wake read the queue and before the reorder takes the queue lock.
    type Refresh = (session: { threadId: string }) => void
    const internals = orch as unknown as { refreshSessionQueueFromDisk: Refresh }
    const refresh = internals.refreshSessionQueueFromDisk.bind(orch)
    let removed = false
    vi.spyOn(internals, 'refreshSessionQueueFromDisk').mockImplementation((session) => {
      refresh(session)
      if (removed || session.threadId !== thread.id) return
      removed = true
      mutateDurableQueue(store, thread.id, (items) => items.filter((item) => item.id !== result.queueItem!.id))
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    releaseExecutionLeaseHandle(lease)
    await settle(400)

    expect(removed).toBe(true)
    expect(adapter.turns).toHaveLength(0)
    expect(warn).not.toHaveBeenCalled()
    const pending = listPendingQueue(store.loadMessageQueue(thread.id))
    expect(pending.map((item) => [item.content, item.state, item.heldAfterStop])).toEqual([['HELD-OLD queued before the Stop', 'pending', true]])
    expect(leaseWaits().has(thread.id)).toBe(false)
  })

  it('waits for the lease again after a restart while another process holds it', async () => {
    const thread = store.createThread('Lease wait across a restart')
    orch.enqueueForThread(thread.id, 'HELD-OLD queued before the Stop')
    mutateDurableQueue(store, thread.id, holdQueueAfterStop)
    const leasePath = holdAsPeer(thread.id)
    const result = await orch.send('LEASE-B before the restart', false, { threadId: thread.id })
    expect(result.queued).toBe(true)

    await orch.shutdown(5_000)
    orch = createOrchestrator(home, store, [adapter])
    orch.recoverAndDrainPendingQueues()
    orch.scheduleStartupQueueRecovery()
    await settle(100)
    expect([...(leaseWaits().get(thread.id)?.itemIds ?? [])]).toEqual([result.queueItem!.id])
    expect(leaseWaits().get(thread.id)?.poll).not.toBeNull()

    // While the peer holds the lease, the wait never loads the thread to look.
    const load = vi.spyOn(orch, 'getOrCreateSession')
    await settle(1_200)
    expect(load).not.toHaveBeenCalled()
    expect(adapter.turns).toHaveLength(0)

    unlinkSync(leasePath)
    await waitFor(() => ran('LEASE-B') === 1, 'the message to run once the peer released the lease', 3_000)
    // It goes first, and its turn lifts the Stop's hold, as it does without a restart.
    await waitFor(() => ran('HELD-OLD') === 1, 'the held message to run after it', 3_000)
    await settle(200)
    expect(prompts().map((prompt) => (prompt.includes('LEASE-B') ? 'B' : 'OLD'))).toEqual(['B', 'OLD'])
  })

  it('runs a message that waited for the lease first after a restart that finds the lease free, in a queue a Stop holds', async () => {
    const thread = store.createThread('Lease free at restart')
    orch.enqueueForThread(thread.id, 'HELD-OLD queued before the Stop')
    mutateDurableQueue(store, thread.id, holdQueueAfterStop)
    // A git operation in the old process holds the lease when the message is sent.
    const leasePath = getExecutionLeasePath(store.getThreadDir(thread.id))
    const now = new Date().toISOString()
    writeFileSync(leasePath, JSON.stringify({ pid: process.ppid, token: 'old-token', processInstanceId: 'old-instance', acquiredAt: now, heartbeatAt: now, source: 'git-operation' }))
    const result = await orch.send('LEASE-FR before the restart', false, { threadId: thread.id })
    expect(result.queued).toBe(true)
    expect(result.queueItem?.heldAfterStop).toBeUndefined()
    // Saved as queued behind the lease: that is what lets it go first after the restart.
    expect(store.loadMessageQueue(thread.id).find((item) => item.id === result.queueItem?.id)?.waitsForLease).toBe(true)

    // The old process dies holding it: the new one finds a dead owner's lease, reclaims it, and the lease is free.
    await orch.shutdown(5_000)
    writeFileSync(leasePath, JSON.stringify({ pid: 2_147_000_123, token: 'old-token', processInstanceId: 'old-instance', acquiredAt: now, heartbeatAt: now, source: 'git-operation' }))
    orch = createOrchestrator(home, store, [adapter])
    orch.recoverAndDrainPendingQueues()
    orch.scheduleStartupQueueRecovery()

    await waitFor(() => ran('LEASE-FR') === 1, 'the message to run without Send now', 3_000)
    // Its turn lifts the Stop's hold, as it does when the lease is let go without a restart.
    await waitFor(() => ran('HELD-OLD') === 1, 'the held message to run after it', 3_000)
    await settle(200)
    expect(prompts().map((prompt) => (prompt.includes('LEASE-FR') ? 'B' : 'OLD'))).toEqual(['B', 'OLD'])
    expect(leaseWaits().has(thread.id)).toBe(false)
  })

  it('runs nothing a Stop held after a restart that finds the lease free and nothing that waited for it', async () => {
    const thread = store.createThread('Only held at restart')
    orch.enqueueForThread(thread.id, 'HELD-ONLY queued before the Stop')
    mutateDurableQueue(store, thread.id, holdQueueAfterStop)

    await orch.shutdown(5_000)
    orch = createOrchestrator(home, store, [adapter])
    orch.recoverAndDrainPendingQueues()
    orch.scheduleStartupQueueRecovery()
    await settle(400)

    expect(adapter.turns).toHaveLength(0)
    expect(leaseWaits().has(thread.id)).toBe(false)
    const pending = listPendingQueue(store.loadMessageQueue(thread.id))
    expect(pending.map((item) => [item.content, item.heldAfterStop])).toEqual([['HELD-ONLY queued before the Stop', true]])
  })

  it('runs nothing after a restart into a queue a Stop held when a message was only added after the Stop', async () => {
    const thread = store.createThread('Added after the Stop')
    orch.enqueueForThread(thread.id, 'HELD-OLD before the Stop')
    mutateDurableQueue(store, thread.id, holdQueueAfterStop)
    // Queued from another window or computer after the Stop: nothing drains it while the app runs.
    orch.enqueueForThread(thread.id, 'ADDED after the Stop')
    await settle(400)
    expect(adapter.turns).toHaveLength(0)

    await orch.shutdown(5_000)
    orch = createOrchestrator(home, store, [adapter])
    orch.recoverAndDrainPendingQueues()
    orch.scheduleStartupQueueRecovery()
    await settle(600)

    expect(adapter.turns).toHaveLength(0)
    expect(leaseWaits().has(thread.id)).toBe(false)
    const pending = listPendingQueue(store.loadMessageQueue(thread.id))
    expect(pending.map((item) => [item.content, item.heldAfterStop])).toEqual([['HELD-OLD before the Stop', true], ['ADDED after the Stop', undefined]])
  })

  it('runs nothing added after a Stop when another process holds the lease at restart and then lets go', async () => {
    const thread = store.createThread('Added after the Stop, peer at restart')
    orch.enqueueForThread(thread.id, 'HELD-OLD before the Stop')
    mutateDurableQueue(store, thread.id, holdQueueAfterStop)
    orch.enqueueForThread(thread.id, 'ADDED after the Stop')

    await orch.shutdown(5_000)
    const leasePath = holdAsPeer(thread.id)
    orch = createOrchestrator(home, store, [adapter])
    orch.recoverAndDrainPendingQueues()
    orch.scheduleStartupQueueRecovery()
    await settle(200)
    expect(leaseWaits().has(thread.id)).toBe(false)

    unlinkSync(leasePath)
    await settle(800)
    expect(adapter.turns).toHaveLength(0)
    expect(listPendingQueue(store.loadMessageQueue(thread.id)).map((item) => item.content)).toEqual(['HELD-OLD before the Stop', 'ADDED after the Stop'])
  })

  it('drains threads whose lease wait began at startup a few at a time', async () => {
    // Every thread has a Stop-held queue and a message that waited for the lease of the old process.
    const threads = Array.from({ length: 5 }, (_, index) => store.createThread(`Startup lease wait ${index}`))
    const now = new Date().toISOString()
    for (const [index, thread] of threads.entries()) {
      orch.enqueueForThread(thread.id, `HELD-OLD-${index}`)
      mutateDurableQueue(store, thread.id, holdQueueAfterStop)
      const leasePath = getExecutionLeasePath(store.getThreadDir(thread.id))
      writeFileSync(leasePath, JSON.stringify({ pid: process.ppid, token: `old-${index}`, processInstanceId: 'old-instance', acquiredAt: now, heartbeatAt: now, source: 'git-operation' }))
      await orch.send(`LEASE-C${index}`, false, { threadId: thread.id })
      writeFileSync(leasePath, JSON.stringify({ pid: 2_147_000_124, token: `old-${index}`, processInstanceId: 'old-instance', acquiredAt: now, heartbeatAt: now, source: 'git-operation' }))
    }
    await orch.shutdown(5_000)

    let running = 0
    let most = 0
    const gates: Array<() => void> = []
    const gated = piAdapter(() => {
      running++
      most = Math.max(most, running)
      return new Promise<string>((resolve) => gates.push(() => { running--; resolve('ok') }))
    })
    orch = createOrchestrator(home, store, [gated])
    orch.recoverAndDrainPendingQueues()
    orch.scheduleStartupQueueRecovery()
    await waitFor(() => gates.length >= 2, 'the first startup turns', 3_000)
    await settle(400)
    expect(running).toBe(2)

    // Let every turn end as it comes, until each thread ran its own message and then its held one.
    const deadline = Date.now() + 10_000
    while (gated.turns.length < 10 || running > 0) {
      if (Date.now() > deadline) throw new Error(`timed out with ${gated.turns.length} turns`)
      gates.splice(0).forEach((open) => open())
      await settle(20)
    }
    await settle(200)
    expect(most).toBe(2)
    for (const index of threads.keys()) {
      const order = gated.turns.map((turn) => turn.prompt).filter((prompt) => prompt.includes(`HELD-OLD-${index}`) || prompt.includes(`LEASE-C${index}`))
      expect(order.map((prompt) => (prompt.includes('LEASE') ? 'B' : 'OLD'))).toEqual(['B', 'OLD'])
    }
  }, 20_000)

  it('waits for the lease when another process takes it between the startup look and the startup drain', async () => {
    const thread = store.createThread('Lease taken before the startup drain')
    orch.enqueueForThread(thread.id, 'LEASE-PU queued before the restart')

    await orch.shutdown(5_000)
    orch = createOrchestrator(home, store, [adapter])
    // The startup look finds the lease free and schedules the drain; a peer takes the lease before the drain runs.
    type Internals = { considerStartupDrain: (threadId: string) => void }
    const internals = orch as unknown as Internals
    const consider = internals.considerStartupDrain.bind(orch)
    let leasePath = ''
    vi.spyOn(internals, 'considerStartupDrain').mockImplementation((threadId) => {
      consider(threadId)
      if (threadId === thread.id) leasePath = holdAsPeer(thread.id)
    })
    orch.recoverAndDrainPendingQueues()
    expect(leasePath).not.toBe('')
    await settle(800)
    expect(adapter.turns).toHaveLength(0)
    expect(leaseWaits().get(thread.id)?.poll).not.toBeNull()

    unlinkSync(leasePath)
    await waitFor(() => ran('LEASE-PU') === 1, 'the message to run once the peer released the lease', 3_000)
    await settle(300)
    expect(ran('LEASE-PU')).toBe(1)
    expect(listPendingQueue(store.loadMessageQueue(thread.id))).toHaveLength(0)
    expect(leaseWaits().has(thread.id)).toBe(false)
  })

  it('stops polling once the lease passes from another process to this one', async () => {
    const thread = store.createThread('Lease wait passes to this process')
    const leasePath = holdAsPeer(thread.id)
    await orch.send('LEASE-T peer then local', false, { threadId: thread.id })
    expect(leaseWaits().get(thread.id)?.poll).not.toBeNull()

    // The peer lets go and this process takes the lease before the wait looks again.
    unlinkSync(leasePath)
    const lease = tryAcquireExecutionLease(store.getThreadDir(thread.id), { source: 'terminal' })!
    expect(lease).not.toBeNull()
    await waitFor(() => leaseWaits().get(thread.id)?.poll === null, 'the poll to stop', 2_000)
    expect(adapter.turns).toHaveLength(0)

    releaseExecutionLeaseHandle(lease)
    await waitFor(() => ran('LEASE-T') === 1, 'the message to run once this process released the lease', 2_000)
    await settle(100)
    expect(ran('LEASE-T')).toBe(1)
  })

  it('stops waiting while another process still holds the lease once a Stop held the message', async () => {
    const thread = store.createThread('Lease wait held while polling')
    const leasePath = holdAsPeer(thread.id)
    await orch.send('LEASE-W behind the peer', false, { threadId: thread.id })
    expect(leaseWaits().get(thread.id)?.poll).not.toBeNull()

    mutateDurableQueue(store, thread.id, holdQueueAfterStop)
    await waitFor(() => !leaseWaits().has(thread.id), 'the poll to end while the peer still holds the lease', 2_000)

    unlinkSync(leasePath)
    await settle(800)
    expect(adapter.turns).toHaveLength(0)
    const pending = listPendingQueue(store.loadMessageQueue(thread.id))
    expect(pending.map((item) => [item.content, item.heldAfterStop])).toEqual([['LEASE-W behind the peer', true]])
  })

  it('runs the message when a turn admitted meanwhile ends before it takes the lease', async () => {
    const thread = store.createThread('Lease wait admitted turn fails')
    const lease = tryAcquireExecutionLease(store.getThreadDir(thread.id), { source: 'git-operation' })!
    await orch.send('LEASE-AD while a turn is set up', false, { threadId: thread.id })

    // A turn of the thread is being set up when the lease is released.
    const session = orch.getOrCreateSession(thread.id)
    session.turnAdmitted = true
    releaseExecutionLeaseHandle(lease)
    await settle(100)
    expect(adapter.turns).toHaveLength(0)
    expect(leaseWaits().has(thread.id)).toBe(true)

    // It fails while it is set up, before it takes the lease: no release follows.
    session.turnAdmitted = false
    await waitFor(() => ran('LEASE-AD') === 1, 'the message to run after the admitted turn failed', 2_000)
    await settle(100)
    expect(ran('LEASE-AD')).toBe(1)
    expect(leaseWaits().has(thread.id)).toBe(false)
  })

  it('looks less often while a turn of the thread is only admitted, and ends once it takes the lease', async () => {
    const thread = store.createThread('Lease wait backs off while admitted')
    const lease = tryAcquireExecutionLease(store.getThreadDir(thread.id), { source: 'git-operation' })!
    await orch.send('LEASE-BO while a turn waits on its folders', false, { threadId: thread.id })

    // A turn of the thread is admitted and waits for its folders (a drive unplugged) when the lease is released.
    const session = orch.getOrCreateSession(thread.id)
    session.turnAdmitted = true
    const wake = vi.spyOn(orch as unknown as { wakeLeaseWait: (threadId: string) => void }, 'wakeLeaseWait')
    releaseExecutionLeaseHandle(lease)
    await settle(4_000)
    // 500 ms, then 1 s, 2 s and 4 s apart: a look every 500 ms would be eight.
    expect(wake.mock.calls.length).toBeLessThanOrEqual(4)
    expect(adapter.turns).toHaveLength(0)
    expect(leaseWaits().get(thread.id)?.poll).not.toBeNull()

    // The turn takes the lease: the wait stops polling, and the turn's end drains the queue.
    const turnLease = tryAcquireExecutionLease(store.getThreadDir(thread.id), { source: 'cli-turn' })!
    await waitFor(() => leaseWaits().get(thread.id)?.poll === null, 'the poll to stop once the turn holds the lease', 6_000)
    session.turnAdmitted = false
    releaseExecutionLeaseHandle(turnLease)
    await waitFor(() => ran('LEASE-BO') === 1, 'the message to run after the lease is let go', 2_000)
    await settle(100)
    expect(ran('LEASE-BO')).toBe(1)
    expect(leaseWaits().has(thread.id)).toBe(false)
  }, 20_000)

  it('looks every 500 ms again once a peer holds the lease after an admitted turn', async () => {
    const thread = store.createThread('Lease wait back to the short poll')
    const lease = tryAcquireExecutionLease(store.getThreadDir(thread.id), { source: 'git-operation' })!
    await orch.send('LEASE-SP short poll again', false, { threadId: thread.id })
    const session = orch.getOrCreateSession(thread.id)
    session.turnAdmitted = true
    releaseExecutionLeaseHandle(lease)
    await settle(2_000)
    type Timed = { pollMs?: number }
    expect((leaseWaits().get(thread.id) as Timed | undefined)?.pollMs).toBeGreaterThan(500)

    // The admitted turn fails, and a peer takes the lease before the wait looks again.
    session.turnAdmitted = false
    const leasePath = holdAsPeer(thread.id)
    await waitFor(() => (leaseWaits().get(thread.id) as Timed | undefined)?.pollMs === 500, 'the short poll', 6_000)
    unlinkSync(leasePath)
    await waitFor(() => ran('LEASE-SP') === 1, 'the message to run once the peer released the lease', 2_000)
    await settle(100)
    expect(ran('LEASE-SP')).toBe(1)
  }, 20_000)

  it('forgets what a deleted thread waited for once it is deleted for good, and keeps only the latest deletes', async () => {
    type Internals = { leaseWaitsOfDeleted: Map<string, Set<string>>; endLeaseWait: (threadId: string, opts?: { deleted?: boolean }) => void }
    const internals = orch as unknown as Internals
    const thread = store.createThread('Lease wait purged')
    holdAsPeer(thread.id)
    await orch.send('LEASE-PG purged', false, { threadId: thread.id })
    orch.markThreadDeleted(thread.id)
    expect(internals.leaseWaitsOfDeleted.has(thread.id)).toBe(true)
    orch.markThreadDeleted(thread.id, { purged: true })
    expect(internals.leaseWaitsOfDeleted.has(thread.id)).toBe(false)

    for (let index = 0; index < 300; index++) {
      leaseWaits().set(`deleted-${index}`, { threadDir: home, itemIds: new Set(['item']), poll: null, wakeQueued: false } as LeaseWait)
      internals.endLeaseWait(`deleted-${index}`, { deleted: true })
    }
    expect(internals.leaseWaitsOfDeleted.size).toBe(256)
    expect(internals.leaseWaitsOfDeleted.has('deleted-299')).toBe(true)
    expect(internals.leaseWaitsOfDeleted.has('deleted-0')).toBe(false)
  })

  it('stops waiting on shutdown', async () => {
    const thread = store.createThread('Lease wait shutdown')
    holdAsPeer(thread.id)
    await orch.send('LEASE-Q shutdown', false, { threadId: thread.id })
    expect(leaseWaits().get(thread.id)?.poll).not.toBeNull()
    await orch.shutdown(5_000)
    expect(leaseWaits().size).toBe(0)
  })
})
