/**
 * Every turn a device causes is marked with the device, so blocking it stops them all, and the
 * clean-up is finished at start for a device blocked while Bridge was off or before a restart.
 */
import { afterAll, describe, expect, it, vi } from 'vitest'
import { cleanupAll, linked } from './routerFixture'

afterAll(cleanupAll)

type Loose = Record<string, any>

const senders = (t: Awaited<ReturnType<typeof linked>>, threadId: string): Array<{ run: string; node: string }> =>
  (t.owner.runEngine.store.db
    .statement("SELECT run_id, payload FROM thread_events WHERE thread_id = ? AND type = 'run.sent_from'")
    .all(threadId) as Array<{ run_id: string; payload: string }>).map((row) => ({
    run: row.run_id,
    node: JSON.parse(row.payload).node
  }))

describe('the turns a device causes', () => {
  it('marks a queued message when it drains into a turn, and a block stops that turn', async () => {
    const t = await linked()
    const thread = t.thread('Drains')
    const id = t.qualified(thread.id)
    // The turn itself is not run (no provider here): what matters is that the drain names the sender.
    const start = vi
      .spyOn(t.owner.orchestrator as unknown as Loose, 'startTurn')
      .mockResolvedValue({ message: '', actions: [] })
    vi.spyOn(t.owner.orchestrator, 'enqueueAndDrain').mockImplementation(((threadId: string, input: never, source: string, opts: never) =>
      t.owner.orchestrator.enqueueForThread(threadId, input, source as never, opts)) as never)
    const queued = await t.dispatch('queue.enqueue', { threadId: id, content: 'drains', requestId: 'drain-1' })
    // The queue drains: the thread is idle, so the item is claimed and its turn starts.
    ;(t.owner.orchestrator as unknown as Loose).scheduleQueueDrain(t.owner.orchestrator.getOrCreateSession(thread.id))
    await vi.waitFor(() => expect(start).toHaveBeenCalled(), { timeout: 15_000 })
    expect(queued.item.id).toBeDefined()
    const marked = senders(t, thread.id)
    expect(marked.length).toBeGreaterThan(0)
    expect(marked.every((row) => row.node === t.callerNode)).toBe(true)

    // The turn is running when the device is blocked: it is stopped.
    const stop = vi.spyOn(t.owner.orchestrator, 'stopThread').mockResolvedValue({ ok: true } as never)
    vi.spyOn(t.owner.runEngine.store, 'getActiveRun').mockImplementation(
      (threadId: string) => (threadId === thread.id ? ({ runId: marked[0].run } as never) : null) as never
    )
    await t.owner.net.request('bridge.policy', { node: t.callerNode, blocked: true })
    await t.insideOwner.routes.cleanedUp()
    expect(stop).toHaveBeenCalledWith(thread.id, 'remote')
    vi.restoreAllMocks()
  }, 120_000)

  it('marks the continuation of an approval a device answered, and a steer that became a turn', async () => {
    const t = await linked()
    const thread = t.thread('Carries on')
    const orchestrator = t.owner.orchestrator as unknown as Loose
    const send = vi.spyOn(t.owner.orchestrator, 'send').mockResolvedValue({ accepted: true } as never)
    orchestrator.startApprovalContinuation(
      { threadId: thread.id, runId: 'run-1', requestIds: [], uncertain: false },
      { kind: 'user', via: 'bridge', node: t.callerNode }
    )
    expect(send.mock.calls[0][2]).toMatchObject({ source: 'gui', sentFrom: { node: t.callerNode } })
    // A phone answers without a computer: nothing to mark.
    orchestrator.startApprovalContinuation(
      { threadId: thread.id, runId: 'run-2', requestIds: [], uncertain: false },
      { kind: 'user', via: 'bridge' }
    )
    expect(send.mock.calls[1][2]).not.toHaveProperty('sentFrom')
    send.mockRestore()

    // A steer the running turn has not read keeps its sender, so the turn it becomes is the device's.
    const session = t.owner.orchestrator.getOrCreateSession(thread.id)
    session.activeTurn = { abort: new AbortController(), pendingSteer: [] } as never
    t.owner.orchestrator.steerThread(thread.id, 'steer text', undefined, undefined, undefined, 'ask', undefined, {
      node: t.callerNode
    })
    expect(session.activeTurn!.pendingSteer[0]).toMatchObject({ sentFrom: { node: t.callerNode }, permissionMode: 'ask' })
    session.activeTurn = null
    // A steer that had to wait is a queued item with the sender on it.
    const waiting = t.owner.orchestrator.enqueueExternalSteer(thread.id, 'waits', {
      permissionMode: 'ask',
      sentFrom: { node: t.callerNode }
    })
    expect(waiting?.sentFrom).toEqual({ node: t.callerNode })
  }, 120_000)

  it('finishes the clean-up when Bridge starts, for a device blocked when no listener was there', async () => {
    const t = await linked()
    const thread = t.thread('Left behind')
    vi.spyOn(t.owner.orchestrator, 'enqueueAndDrain').mockImplementation(((threadId: string, input: never, source: string, opts: never) =>
      t.owner.orchestrator.enqueueForThread(threadId, input, source as never, opts)) as never)
    await t.dispatch('queue.enqueue', { threadId: t.qualified(thread.id), content: 'left', requestId: 'left-1' })
    expect(t.owner.orchestrator.listQueue(thread.id).map((row) => row.content)).toEqual(['left'])
    // The block is written straight to the table: no change event, as when Bridge was off or the daemon restarted.
    t.owner.net
      .runtime()
      .db.database.prepare(
        'INSERT INTO net_node_policy(node,blocked,max_permission_mode,terminal,created_at) VALUES(?,1,?,0,?) ON CONFLICT(node) DO UPDATE SET blocked=1'
      )
      .run(t.callerNode, 'accept_edits', Date.now())
    expect(t.owner.orchestrator.listQueue(thread.id)).toHaveLength(1)
    t.insideOwner.routes.cleanUpBlockedDevices()
    await t.insideOwner.routes.cleanedUp()
    expect(t.owner.orchestrator.listQueue(thread.id)).toHaveLength(0)
    // Again: nothing is left to do and nothing fails.
    t.insideOwner.routes.cleanUpBlockedDevices()
    await expect(t.insideOwner.routes.cleanedUp()).resolves.toBeUndefined()
    vi.restoreAllMocks()
  }, 120_000)
})
