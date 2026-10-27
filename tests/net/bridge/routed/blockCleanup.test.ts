/**
 * Blocking a device takes away what it left on this computer: the messages it queued that no turn
 * has started, the "Always for this thread" rules a person on it made, and the turns it started.
 */
import { afterAll, describe, expect, it, vi } from 'vitest'
import { cleanUpBlockedDevice } from '../../../../src/mms/bridge/routed/blockCleanup'
import type { OwnerRoutes } from '../../../../src/mms/bridge/routed/OwnerRoutes'
import { cleanupAll, linked } from './routerFixture'

afterAll(cleanupAll)

describe('a blocked device', () => {
  it('loses its queued messages and its rules, and the owner’s own are kept', async () => {
    const t = await linked()
    const thread = t.thread('Shared')
    const id = t.qualified(thread.id)
    const db = t.owner.runEngine.store.db
    // Hold the queue still: nothing drains while the test looks at it.
    vi.spyOn(t.owner.orchestrator, 'enqueueAndDrain').mockImplementation(((threadId: string, input: never, source: string, opts: never) =>
      t.owner.orchestrator.enqueueForThread(threadId, input, source as never, opts)) as never)
    const mine = t.owner.orchestrator.enqueueForThread(thread.id, 'the owner’s own' as never, 'gui' as never, {} as never)
    await t.dispatch('queue.enqueue', { threadId: id, content: 'from the device', requestId: 'b1' })
    await t.dispatch('queue.enqueue', { threadId: id, content: 'and another', requestId: 'b2' })
    const queued = () => t.owner.orchestrator.listQueue(thread.id).map((row) => row.content)
    expect(queued()).toEqual(expect.arrayContaining(['from the device', 'and another']))

    // Two rules: one a person on the device made, one the owner made at their own window.
    const request = (requestId: string, answeredBy: unknown) =>
      db
        .statement(
          `INSERT INTO approval_requests(request_id, thread_id, instance_id, provider, action, permission_key, fingerprint, questions, answer_path, status, answered_by, created_at)
           VALUES(?, ?, 'i', 'p', 'command', 'bash', ?, '[]', 'live', 'answered', ?, '2026-01-01T00:00:00Z')`
        )
        .run(requestId, thread.id, `fp-${requestId}`, JSON.stringify(answeredBy))
    request('r-device', { kind: 'user', via: 'bridge', node: t.callerNode })
    request('r-owner', { kind: 'user', via: 'gui' })
    for (const requestId of ['r-device', 'r-owner'])
      db.statement(
        `INSERT INTO approval_rules(thread_id, fingerprint, permission_key, action, summary, granted_under, source_request_id, created_at)
         VALUES(?, ?, 'bash', 'command', 'ls', 'accept_edits', ?, '2026-01-01T00:00:00Z')`
      ).run(thread.id, `fp-${requestId}`, requestId)
    expect(t.owner.orchestrator.listApprovalRules(thread.id)).toHaveLength(2)

    await t.owner.net.request('bridge.policy', { node: t.callerNode, blocked: true })
    await (t.insideOwner.routes as OwnerRoutes).cleanedUp()

    expect(queued()).toEqual(['the owner’s own'])
    expect(mine.id).toBeDefined()
    expect(t.owner.orchestrator.listApprovalRules(thread.id).map((rule) => rule.id)).toEqual(['fp-r-owner'])
    vi.restoreAllMocks()
  }, 120_000)

  it('is also taken from the turns it started, and a failing step does not stop the others', async () => {
    const stopped: string[] = []
    const removed: string[] = []
    const services = {
      threads: { listAllThreads: () => [{ id: 'busy' }, { id: 'idle' }, { id: 'broken' }] },
      orchestrator: {
        listQueue: (threadId: string) => {
          if (threadId === 'broken') throw new Error('unreadable queue')
          return threadId === 'busy'
            ? [
                { id: 'a', state: 'pending', sentFrom: { node: 'nod_x' } },
                { id: 'b', state: 'claimed', sentFrom: { node: 'nod_x' } },
                { id: 'c', state: 'pending', sentFrom: { node: 'nod_other' } }
              ]
            : []
        },
        removeQueuedItem: (threadId: string, itemId: string) => {
          removed.push(`${threadId}/${itemId}`)
          return {}
        },
        stopThread: async (threadId: string) => {
          stopped.push(threadId)
        },
        clearApprovalRulesMadeBy: () => 3
      },
      runEngine: {
        store: {
          getActiveRun: (threadId: string) => (threadId === 'busy' ? { runId: 'run-1' } : null),
          db: { statement: () => ({ get: () => ({ found: 1 }) }) }
        }
      }
    }
    const done = await cleanUpBlockedDevice(services as never, 'nod_x')
    // Only what still waits goes: the claimed message has started.
    expect(removed).toEqual(['busy/a'])
    expect(stopped).toEqual(['busy'])
    expect(done).toEqual({ queued: 1, rules: 3, turns: 1 })
  })
})
