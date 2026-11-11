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
    store = new ThreadDataStore(new ProjectManager())
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
})
