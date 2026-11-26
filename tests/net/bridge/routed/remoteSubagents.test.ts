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
      const sent = await t.owner.runEngine.dispatch({ kind: 'send', threadId: opts!.threadId!, clientRequestId: opts!.clientRequestId!, source: opts!.source ?? 'gui', ...(opts!.agent ? { actor: opts!.agent } : {}) })
      if (sent.status !== 'accepted') throw new Error('not accepted')
      return { message: '', actions: [], runId: sent.runId, sequence: sent.sequence, accepted: true } as never
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
      // Both computers know the agent mark, so the owner took every call as an agent's (issue #1160): the thread records
      // the agent that started it, and the task runs as an agent's message, from this computer.
      expect(far).toMatchObject({ name: 'Remote tester', startedFrom: { node: t.callerNode, agent: { thread: parentThread.id, title: 'Parent', mode: 'accept_edits' } } })
      expect(far.permissionMode).toBe('accept_edits')
      expect(far.createdByThreadId).toBeUndefined()
      expect(t.caller.runEngine.remoteSubagents.get(accepted.delegationId)!.marked).toBe(true)
      expect(ownerSend.mock.calls[0][2]).toMatchObject({
        threadId: far.id,
        source: 'mcp',
        permissionMode: 'accept_edits',
        sentFrom: { node: t.callerNode },
        agent: { threadId: parentThread.id, runId: parent.runId, remote: { node: t.callerNode, title: 'Parent', mode: 'accept_edits' } }
      })
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
      // The reply is read from the thread's session (a real turn has one; the stand-in made none).
      t.owner.orchestrator.getOrCreateSession(far.id)
      t.owner.runEngine.markTerminal(launched.remoteRunId, 'completed')
      await service.pass()
      expect(t.caller.runEngine.delegations.get(accepted.delegationId)).toMatchObject({
        status: 'result_available',
        result: { runStatus: 'completed', text: 'Everything passes there.' }
      })
      expect(t.caller.runEngine.remoteSubagents.get(accepted.delegationId)!.state).toBe('done')
      // The notice the parent reads says where the subagent really worked: on the other computer, never in the parent's
      // own folder (its task was \`shared\`) or with snapshots of this computer.
      const where = (t.caller.orchestrator as unknown as { noticeContext(): { resultReport(payload: { delegationId: string }): string | undefined } })
        .noticeContext().resultReport({ delegationId: accepted.delegationId })
      const computer = t.caller.threads.getThread(accepted.childThreadId)!.runsOn!.computerName
      expect(where).toContain(`Worked on ${computer}`)
      expect(where).not.toMatch(/your own folder|Snapshots:/)
    } finally {
      vi.restoreAllMocks()
    }
  }, 120_000)

  it('delegate_task with computer: the task shows as the parent agent\'s on both computers, never as a person\'s', async () => {
    const service = serviceOf(t.caller)
    service.pause()
    const ownerSend = vi.spyOn(t.owner.orchestrator, 'send').mockImplementation(async (_input, _reuse, opts) => {
      const sent = await t.owner.runEngine.dispatch({ kind: 'send', threadId: opts!.threadId!, clientRequestId: opts!.clientRequestId!, source: opts!.source ?? 'gui', ...(opts!.agent ? { actor: opts!.agent } : {}) })
      if (sent.status !== 'accepted') throw new Error('not accepted')
      return { message: '', actions: [], runId: sent.runId, sequence: sent.sequence, accepted: true } as never
    })
    const access = t.caller.settings.get().agentAccess
    t.caller.settings.set({ agentAccess: { ...access, remoteSubagents: true, computers: [t.node] } } as never)
    // A remote task starts no turn here: the delegation tools only need the engine to say it can record one.
    vi.spyOn(t.caller.orchestrator as unknown as { effectsEnabled(): boolean }, 'effectsEnabled').mockReturnValue(true)
    try {
      const parentThread = t.caller.threads.createThread('Tool parent')
      const parent = await t.caller.runEngine.dispatch({ kind: 'send', threadId: parentThread.id, clientRequestId: 'tool-parent-send', source: 'gui' })
      if (parent.status !== 'accepted') throw new Error('parent not accepted')
      t.caller.runEngine.markStarting(parent.runId)
      t.caller.runEngine.markRunning(parent.runId)
      const orchestrator = t.caller.orchestrator as unknown as {
        getOrCreateSession(threadId: string): unknown
        delegationTools(session: unknown, runId: string): { delegateTask(input: Record<string, unknown>, call: { toolCallId: string }): Promise<Record<string, unknown>> }
      }
      const computer = portOf(t.caller)!.computers()[0]!.name
      const started = await orchestrator.delegationTools(orchestrator.getOrCreateSession(parentThread.id), parent.runId)
        .delegateTask({ title: 'Far reviewer', prompt: 'Review it there', computer, readOnly: true }, { toolCallId: 'far-1' })
      expect(started, JSON.stringify(started)).toMatchObject({ computer })
      // Here: the stand-in shows the task as the parent agent's, which opens the parent.
      const [asked] = t.caller.orchestrator.getMessages(started.childThreadId as string).filter((message) => message.role === 'user')
      expect(asked).toMatchObject({ content: 'Review it there', origin: { kind: 'agent', threadId: parentThread.id, runId: parent.runId, title: 'Tool parent' } })
      // There: the task is an agent's message from this computer.
      expect(ownerSend.mock.calls.at(-1)![2]).toMatchObject({ source: 'mcp', agent: { threadId: parentThread.id, remote: { title: 'Tool parent' } } })
    } finally {
      t.caller.settings.set({ agentAccess: access } as never)
      vi.restoreAllMocks()
    }
  }, 120_000)

  // Issue #1160: no fixed cap. The owner's limit for this computer is the only one past the parent's run.
  it('runs in Full access there once the owner raised its limit for this computer to Full access', async () => {
    const service = serviceOf(t.caller)
    service.pause()
    const ownerSend = vi.spyOn(t.owner.orchestrator, 'send').mockImplementation(async (_input, _reuse, opts) => {
      const sent = await t.owner.runEngine.dispatch({ kind: 'send', threadId: opts!.threadId!, clientRequestId: opts!.clientRequestId!, source: opts!.source ?? 'gui', ...(opts!.agent ? { actor: opts!.agent } : {}) })
      if (sent.status !== 'accepted') throw new Error('not accepted')
      return { message: '', actions: [], runId: sent.runId, sequence: sent.sequence, accepted: true } as never
    })
    await t.owner.net.request('bridge.policy', { node: t.callerNode, maxPermissionMode: 'full' })
    try {
      const parentThread = t.caller.threads.createThread('Full parent')
      const parent = await t.caller.runEngine.dispatch({ kind: 'send', threadId: parentThread.id, clientRequestId: 'full-parent-send', source: 'gui' })
      if (parent.status !== 'accepted') throw new Error('parent not accepted')
      t.caller.runEngine.markStarting(parent.runId)
      t.caller.runEngine.markRunning(parent.runId)
      const accepted = await t.caller.runEngine.requestDelegation({
        parentThreadId: parentThread.id,
        parentRunId: parent.runId,
        clientRequestId: 'delegation:remote-full',
        prompt: 'Build it there',
        workspace: 'isolated',
        role: 'implement',
        wake: 'always',
        title: 'Remote builder',
        remote: { node: t.node, prompt: 'Build it there', permissionMode: 'full', chatMode: 'agent', worktree: false, projectId: null, instanceId: null, model: null, deadlineAt: null }
      })
      const launched = await service.launch(accepted.delegationId)
      expect(launched, JSON.stringify(launched)).toMatchObject({ ok: true })
      if (launched.ok !== true) return
      // The owner set the thread to Full access and sent the task under a limit of Full access.
      expect(t.owner.threads.getThread(launched.remoteThreadId)!.permissionMode).toBe('full')
      expect(ownerSend.mock.calls.at(-1)![2]).toMatchObject({ threadId: launched.remoteThreadId, permissionMode: 'full', source: 'mcp' })
      // Marked as an agent's, and still no fixed cap: the thread an agent started there is held to Full access, no less.
      expect(t.owner.threads.getThread(launched.remoteThreadId)!.startedFrom?.agent?.mode).toBe('full')
    } finally {
      await t.owner.net.request('bridge.policy', { node: t.callerNode, maxPermissionMode: 'accept_edits' })
      vi.restoreAllMocks()
    }
  }, 120_000)

  // Issue #685: the owner counts the task's limit as running time and stops the run; its thread there expires with the
  // parent here.
  it('the owner keeps the limit and stops the run at it, and its thread there gets the parent\'s expiry', async () => {
    const service = serviceOf(t.caller)
    service.pause()
    vi.spyOn(t.owner.orchestrator, 'send').mockImplementation(async (_input, _reuse, opts) => {
      const sent = await t.owner.runEngine.dispatch({ kind: 'send', threadId: opts!.threadId!, clientRequestId: opts!.clientRequestId!, source: opts!.source ?? 'gui', ...(opts!.agent ? { actor: opts!.agent } : {}) })
      if (sent.status !== 'accepted') throw new Error('not accepted')
      return { message: '', actions: [], runId: sent.runId, sequence: sent.sequence, accepted: true } as never
    })
    try {
      const parentThread = t.caller.threads.createThread('Limited parent')
      const expiresAt = new Date(Date.now() + 2 * 60 * 60_000).toISOString()
      t.caller.threads.updateThreadMeta(parentThread.id, { expiresAt, expiryStopsRun: true }, { touch: false })
      const parent = await t.caller.runEngine.dispatch({ kind: 'send', threadId: parentThread.id, clientRequestId: 'limited-parent-send', source: 'gui' })
      if (parent.status !== 'accepted') throw new Error('parent not accepted')
      t.caller.runEngine.markStarting(parent.runId)
      t.caller.runEngine.markRunning(parent.runId)
      const accepted = await t.caller.runEngine.requestDelegation({
        parentThreadId: parentThread.id,
        parentRunId: parent.runId,
        clientRequestId: 'delegation:remote-limited',
        prompt: 'Soak it there',
        workspace: 'shared',
        role: 'research',
        wake: 'always',
        title: 'Remote soak',
        remote: {
          node: t.node, prompt: 'Soak it there', permissionMode: 'accept_edits', chatMode: 'plan', worktree: false, projectId: null, instanceId: null, model: null,
          deadlineAt: new Date(Date.now() + 5 * 60_000).toISOString(), limitMinutes: 5
        }
      })
      // What `delegate_task` does for a task on another computer: its expiry follows the parent from now on.
      ;(t.caller.orchestrator as unknown as { trackRemoteExpiry(child: string, node: string): void }).trackRemoteExpiry(accepted.childThreadId, t.node)
      const launched = await service.launch(accepted.delegationId)
      expect(launched, JSON.stringify(launched)).toMatchObject({ ok: true })
      if (launched.ok !== true) return

      // The owner took the limit: it counts it, so the caller no longer stops the task by the clock.
      expect(t.owner.runEngine.runTimeLimits.get(launched.remoteRunId)).toMatchObject({ threadId: launched.remoteThreadId, limitMs: 5 * 60_000, usedMs: 0 })
      expect(t.caller.runEngine.remoteSubagents.get(accepted.delegationId)).toMatchObject({ limitMinutes: 5, deadlineAt: null })
      // The thread there expires with the parent here.
      expect(t.owner.threads.getThread(launched.remoteThreadId)).toMatchObject({ expiresAt, expiryStopsRun: true })
      expect(t.caller.runEngine.remoteExpiry.get(accepted.childThreadId)).toMatchObject({ state: 'sent', lastError: null })

      // The run works there until its limit is used: the owner stops it and says why, and the parent's task ends with it.
      t.owner.runEngine.markStarting(launched.remoteRunId)
      t.owner.runEngine.markRunning(launched.remoteRunId)
      const limits = (t.owner.orchestrator as unknown as { runTimeLimits: { pass(): Promise<void>; deps: { now?: () => number } } }).runTimeLimits
      let now = Date.now()
      limits.deps.now = () => now
      await limits.pass()
      t.owner.runEngine.runTimeLimits.setUsed(launched.remoteRunId, 5 * 60_000 - 5_000)
      now += 10_000
      await limits.pass()
      const stopped = t.owner.runEngine.getRun(launched.remoteRunId)!
      expect(['cancelled', 'interrupted']).toContain(stopped.status)
      expect(stopped.outcome?.error).toBe('Stopped after its limit of 5 minutes of running time.')
      expect(stopped.outcome?.interruptedBy).not.toBe('user')
      await service.pass()
      const task = t.caller.runEngine.delegations.get(accepted.delegationId)!
      expect(task.result?.error).toMatch(/^On .+: Stopped after its limit of 5 minutes of running time\.$/)
    } finally {
      vi.restoreAllMocks()
    }
  }, 120_000)
})
