/**
 * Issue #469 over two real daemons linked by Bridge: an agent's remote subagent on the owner. The caller's
 * remote subagents use the router's own client, so the owner receives the routed calls a window could
 * make and applies its own limits to them. The owner's turn is stood in for (its send records a run that
 * the test ends), so no provider runs.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { RemoteSubagents } from '../../../../src/mms/orchestrator/RemoteSubagents'
import type { RemoteComputersPort } from '../../../../src/mms/protocol/remoteComputersPort'
import { cleanupAll, linked } from './routerFixture'

let t: Awaited<ReturnType<typeof linked>>
beforeAll(async () => {
  t = await linked()
}, 120_000)
afterAll(cleanupAll)

const portOf = (services: typeof t.caller) => (services.orchestrator as unknown as { remoteComputers?: RemoteComputersPort }).remoteComputers
const serviceOf = (services: typeof t.caller) => (services.orchestrator as unknown as { remoteSubagents: RemoteSubagents }).remoteSubagents

describe('remote subagents over Bridge (issue #469)', () => {
  it('Bridge gives the orchestrator the user\'s other computers', () => {
    const port = portOf(t.caller)
    expect(port).toBeDefined()
    expect(port!.computers()).toEqual([expect.objectContaining({ node: t.node, online: true })])
  })

  it('the owner takes the calls, narrows the mode to its limit, and the result comes back to the parent', async () => {
    const service = serviceOf(t.caller)
    service.pause()
    // The owner stands in for the far turn: its send records a run; the test ends it with a reply.
    const ownerSend = vi.spyOn(t.owner.orchestrator, 'send').mockImplementation(async (_input, _reuse, opts) => {
      const sent = await t.owner.runEngine.dispatch({ kind: 'send', threadId: opts!.threadId!, clientRequestId: opts!.clientRequestId!, source: 'gui' })
      if (sent.status !== 'accepted') throw new Error('not accepted')
      return { message: '', actions: [], runId: sent.runId, accepted: true } as never
    })
    try {
      // A parent run on the caller with a remote task.
      const parentThread = t.caller.threads.createThread('Parent')
      const parent = await t.caller.runEngine.dispatch({ kind: 'send', threadId: parentThread.id, clientRequestId: 'parent-send', source: 'gui' })
      if (parent.status !== 'accepted') throw new Error('parent not accepted')
      t.caller.runEngine.markStarting(parent.runId)
      t.caller.runEngine.markRunning(parent.runId)
      const accepted = await t.caller.runEngine.requestDelegation({
        parentThreadId: parentThread.id,
        parentRunId: parent.runId,
        clientRequestId: 'delegation:remote-1',
        prompt: 'Run the tests there',
        workspace: 'shared',
        role: 'research',
        wake: 'always',
        title: 'Remote tester',
        remote: {
          node: t.node,
          prompt: 'Run the tests there',
          // Wider than the limit the owner set for this computer (Auto-accept edits by default).
          permissionMode: 'auto',
          chatMode: 'plan',
          worktree: false,
          projectId: null,
          instanceId: null,
          model: null,
          deadlineAt: null
        }
      })
      const launched = await service.launch(accepted.delegationId)
      expect(launched, JSON.stringify(launched)).toMatchObject({ ok: true })
      if (launched.ok !== true) return
      // The owner made the thread, recorded where it was started from, and kept to its own limit.
      const far = t.owner.threads.getThread(launched.remoteThreadId)!
      expect(far).toMatchObject({ name: 'Remote tester', startedFrom: { node: t.callerNode } })
      expect(far.permissionMode).toBe('accept_edits')
      expect(ownerSend.mock.calls[0][2]).toMatchObject({ threadId: far.id, source: 'gui', sentFrom: { node: t.callerNode } })
      expect(t.caller.threads.getThread(accepted.childThreadId)!.runsOn).toMatchObject({ node: t.node, ref: t.qualified(far.id) })

      // Still running there: the task stays open and its row says it is working.
      t.owner.runEngine.markStarting(launched.remoteRunId)
      t.owner.runEngine.markRunning(launched.remoteRunId)
      await service.pass()
      expect(t.caller.runEngine.delegations.get(accepted.delegationId)!.status).toBe('running')
      expect(service.overlay(accepted.childThreadId)).toMatchObject({ online: true, activity: 'working' })

      // The run there ends with a reply: the parent's task publishes it.
      vi.spyOn(t.owner.orchestrator, 'getMessages').mockImplementation((threadId) =>
        threadId === far.id
          ? [{ id: 'm1', role: 'assistant', content: 'Everything passes there.', timestamp: new Date().toISOString() }] as never
          : []
      )
      t.owner.runEngine.markTerminal(launched.remoteRunId, 'completed')
      await service.pass()
      expect(t.caller.runEngine.delegations.get(accepted.delegationId)).toMatchObject({
        status: 'result_available',
        result: { runStatus: 'completed', text: 'Everything passes there.' }
      })
      expect(t.caller.runEngine.remoteSubagents.get(accepted.delegationId)!.state).toBe('done')
    } finally {
      vi.restoreAllMocks()
    }
  }, 120_000)
})
