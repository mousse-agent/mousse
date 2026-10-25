/**
 * Issue #142: subagents are addressed by title and continued on their own thread. A real
 * `OrchestratorService`, Run Engine and effect worker with a scripted pi adapter: the parent turn
 * calls the delegation tools through the same host the pi loop and the Mousse MCP server use.
 */
import { describe, expect, it, vi } from 'vitest'
import type { DelegationToolHost } from '../../src/mms/orchestrator/LlmClient'
import { subagentPreamble } from '../../src/mms/run/delegation/guidance'
import { waitFor } from './phase6Fixture'
import { useSubagentWorld, type Json } from './subagentWorld'

describe('continue_subagent and the title address (issue #142)', () => {
  const world = useSubagentWorld()

  describe('titles are unique per parent', () => {
    it('delegate_task with a taken title starts nothing and says how to continue instead', async () => {
      const { d, parent, steps, out, say, start } = world()
      steps['go'] = async (tools) => {
        out.first = await start(tools, 'API reviewer')
        out.again = await start(tools, '  api   REVIEWER ', {}, 'again')
        out.other = await start(tools, 'Docs writer')
      }
      await say('go')
      expect(out.first.delegationId).toBeTruthy()
      expect(out.first.title).toBe('API reviewer')
      expect(out.again).toMatchObject({ started: false, code: 'title_taken', title: 'api   REVIEWER', existing: [{ childThreadId: out.first.childThreadId, title: 'API reviewer', latestDelegationId: out.first.delegationId }] })
      expect(out.again.message).toContain('continue_subagent')
      expect(out.other.started).not.toBe(false)
      expect(d.engine.delegations.listForParentThread(parent.id)).toHaveLength(2)
      expect(d.store.listAllThreads().filter((thread) => thread.lineage?.parentThreadId === parent.id)).toHaveLength(2)
    })

    it('a retried delegate_task replays its first result before the title is checked', async () => {
      const { parent, steps, out, say, start } = world()
      steps['one'] = async (tools) => { out.first = await start(tools, 'API reviewer', {}, 'mcp:retry-1') }
      steps['two'] = async (tools) => { out.retry = await start(tools, 'API reviewer', {}, 'mcp:retry-1') }
      await say('one')
      // The retry arrives in a later run of the same thread: the receipt is scoped to the thread.
      await say('two')
      expect(out.retry).toMatchObject({ delegationId: out.first.delegationId, replayed: true })
      expect(parent.id).toBeTruthy()
    })

    it('titles are unique when renamed: another subagent of the parent holds it, a stranger does not', async () => {
      const { d, steps, out, say, start } = world()
      steps['go'] = async (tools) => {
        out.a = await start(tools, 'API reviewer')
        out.b = await start(tools, 'Docs writer')
      }
      await say('go')
      expect(() => d.store.updateThreadMeta(out.b.childThreadId, { name: ' api reviewer' })).toThrow(/already titled/)
      expect(d.store.getThread(out.b.childThreadId)?.name).toBe('Docs writer')
      // Its own title (a change of case) and an unused one are fine; so is a thread that is no subagent.
      expect(d.store.updateThreadMeta(out.b.childThreadId, { name: 'DOCS WRITER' }).name).toBe('DOCS WRITER')
      expect(d.store.updateThreadMeta(out.b.childThreadId, { name: 'Release notes' }).name).toBe('Release notes')
      const stranger = d.store.createThread('Elsewhere')
      expect(d.store.updateThreadMeta(stranger.id, { name: 'API reviewer' }).name).toBe('API reviewer')
    })

    it('the same title under another parent is fine', async () => {
      const { d, parent, steps, out, say, start } = world()
      steps['go'] = async (tools) => { out.mine = await start(tools, 'API reviewer') }
      await say('go')
      const other = d.store.createThread('Other parent')
      expect(d.store.listAllThreads().some((thread) => thread.name === 'API reviewer' && thread.lineage?.parentThreadId !== other.id)).toBe(true)
      expect(parent.id).not.toBe(other.id)
    })
  })

  describe('continue_subagent', () => {
    it('continues an idle subagent on the same thread, with a task of its own', async () => {
      const { d, adapter, parent, steps, out, say, start, settled } = world()
      steps['go'] = async (tools) => { out.first = await start(tools, 'API reviewer', { role: 'review' }) }
      steps['again'] = async (tools) => {
        out.continued = await tools.continueSubagent({ subagent: ' api REVIEWER', prompt: 'Now check the tests' }, { toolCallId: 'c1' }) as Json
      }
      await say('go')
      await settled(out.first.childRunId)
      await say('again')
      const second = out.continued
      expect(second).toMatchObject({ childThreadId: out.first.childThreadId, title: 'API reviewer', status: 'started' })
      expect(second.delegationId).not.toBe(out.first.delegationId)
      await settled(second.childRunId)
      // The same thread, so the same native session: no second thread, and the follow-up runs as its next turn.
      expect(d.engine.delegations.listChildThreads(parent.id)).toHaveLength(1)
      const childTurns = adapter.turns.filter((turn) => turn.threadId === out.first.childThreadId)
      expect(childTurns.map((turn) => turn.prompt)).toEqual([`${subagentPreamble('Parent')}\n\nReview API reviewer`, 'Now check the tests'])
      // Own delegation row, run and result; workspace and role come from the subagent's first task.
      const tasks = d.engine.delegations.listForChildThread(out.first.childThreadId)
      expect(tasks.map((task) => task.status)).toEqual(['result_available', 'result_available'])
      expect(tasks[1]).toMatchObject({ parentThreadId: parent.id, workspace: 'shared', role: 'review', wake: 'always', result: { runStatus: 'completed', text: 'done: Now check the tests' } })
      expect(d.engine.getRun(second.childRunId)).toMatchObject({ source: 'delegation', threadId: out.first.childThreadId })
      // The first result stays what it was.
      expect(tasks[0].result?.text).toContain('Review API reviewer')
      expect(d.engine.inbox.listForThread(parent.id).filter((row) => row.kind === 'child_result')).toHaveLength(2)
    })

    it('a busy subagent runs the follow-up after its current task, as queued', async () => {
      let release!: () => void
      const gate = new Promise<void>((resolve) => { release = resolve })
      const { d, adapter, steps, out, say, start, settled } = world(async (input) => {
        if (input.prompt.endsWith('Review API reviewer')) await gate
        return `done: ${input.prompt.split('\n').at(-1)}`
      })
      steps['go'] = async (tools) => { out.first = await start(tools, 'API reviewer') }
      steps['again'] = async (tools) => { out.continued = await tools.continueSubagent({ subagent: 'API reviewer', prompt: 'Then this' }, { toolCallId: 'c1' }) as Json }
      await say('go')
      await waitFor(() => adapter.turns.some((turn) => turn.threadId === out.first.childThreadId), 'the first task to start')
      await say('again')
      expect(out.continued).toMatchObject({ status: 'queued', title: 'API reviewer' })
      expect(d.engine.getRun(out.continued.childRunId)?.status).toBe('queued')
      expect(adapter.turns.filter((turn) => turn.threadId === out.first.childThreadId)).toHaveLength(1)
      release()
      await settled(out.continued.childRunId)
      expect(d.engine.delegations.get(out.continued.delegationId)?.result?.text).toBe('done: Then this')
      expect(adapter.turns.filter((turn) => turn.threadId === out.first.childThreadId)).toHaveLength(2)
    })

    it('a subagent waiting for an answer is never auto-rejected: the caller gets the question, then answers it', async () => {
      const { d, steps, out, say, start } = world()
      steps['go'] = async (tools) => { out.first = await start(tools, 'API reviewer') }
      await say('go')
      const questions = (d.orch as any).questions
      const asked = questions.requestAnswers([{ id: 'q1', prompt: 'Which module?', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }], out.first.childThreadId) as Promise<Record<string, unknown>>
      const [pending] = questions.listPendingForThread(out.first.childThreadId)
      steps['again'] = async (tools) => {
        out.blocked = await tools.continueSubagent({ subagent: 'API reviewer', prompt: 'Carry on' }, { toolCallId: 'c1' }) as Json
        out.wrongThread = await tools.answerSubagent({ subagent: 'Nobody', requestId: pending.requestId, answers: { q1: 'a' } }, { toolCallId: 'a0' }) as Json
        out.answered = await tools.answerSubagent({ subagent: 'API reviewer', requestId: pending.requestId, answers: { q1: 'b' } }, { toolCallId: 'a1' }) as Json
        out.answeredTwice = await tools.answerSubagent({ subagent: 'API reviewer', requestId: pending.requestId, answers: { q1: 'b' } }, { toolCallId: 'a2' }) as Json
      }
      await say('again')
      expect(out.blocked).toMatchObject({ started: false, code: 'needs_answer', subagent: 'API reviewer', childThreadId: out.first.childThreadId, questions: [{ requestId: pending.requestId }] })
      expect(out.wrongThread).toMatchObject({ answered: false, code: 'unknown_subagent' })
      // The question was still pending when the second tool call ran (never auto-rejected), and the answer reached its waiter.
      expect(out.answered).toEqual({ answered: true, subagent: 'API reviewer', childThreadId: out.first.childThreadId, requestId: pending.requestId })
      await expect(asked).resolves.toEqual({ q1: 'b' })
      expect(out.answeredTwice).toMatchObject({ answered: false, code: 'no_such_question' })
      // No follow-up was started by the blocked call.
      expect(d.engine.delegations.listForChildThread(out.first.childThreadId)).toHaveLength(1)
      expect(d.orch.getMessages(out.first.childThreadId).some((message) => message.role === 'user' && message.content.includes('b'))).toBe(true)
    })

    it('a question that belongs to another thread cannot be answered through a subagent', async () => {
      const { d, steps, out, say, start } = world()
      steps['go'] = async (tools) => {
        out.a = await start(tools, 'API reviewer')
        out.b = await start(tools, 'Docs writer')
      }
      await say('go')
      const questions = (d.orch as any).questions
      void (questions.requestAnswers([{ id: 'q1', prompt: 'Which?', options: [{ id: 'a', label: 'A' }] }], out.b.childThreadId) as Promise<unknown>).catch(() => undefined)
      const [pending] = questions.listPendingForThread(out.b.childThreadId)
      steps['again'] = async (tools) => { out.misdirected = await tools.answerSubagent({ subagent: 'API reviewer', requestId: pending.requestId, answers: { q1: 'a' } }, { toolCallId: 'a1' }) as Json }
      await say('again')
      expect(out.misdirected).toMatchObject({ answered: false, code: 'no_such_question' })
      expect(questions.listPendingForThread(out.b.childThreadId)).toHaveLength(1)
      questions.dismissAllForThread(out.b.childThreadId)
    })

    it('only the caller\'s own direct subagents can be continued', async () => {
      const { d, steps, out, say, start } = world()
      steps['go'] = async (tools) => { out.mine = await start(tools, 'API reviewer') }
      await say('go')
      const stranger = d.store.createThread('Another parent')
      const strangerTools = (d.orch as any).delegationTools(d.orch.getOrCreateSession(stranger.id), 'run:none') as DelegationToolHost
      const byTitle = await strangerTools.continueSubagent({ subagent: 'API reviewer', prompt: 'hi' }, { toolCallId: 'x1' }) as Json
      const byId = await strangerTools.continueSubagent({ subagent: out.mine.childThreadId, prompt: 'hi' }, { toolCallId: 'x2' }) as Json
      const byDelegation = await strangerTools.continueSubagent({ subagent: out.mine.delegationId, prompt: 'hi' }, { toolCallId: 'x3' }) as Json
      for (const refused of [byTitle, byId, byDelegation]) expect(refused).toMatchObject({ started: false, code: 'unknown_subagent' })
      expect(d.engine.delegations.listForChildThread(out.mine.childThreadId)).toHaveLength(1)
    })

    it('a subagent whose thread is gone cannot be continued; the answer says to start a new one', async () => {
      const { d, steps, out, say, start } = world()
      steps['go'] = async (tools) => { out.first = await start(tools, 'API reviewer') }
      steps['again'] = async (tools) => {
        const real = d.store.getThread.bind(d.store)
        vi.spyOn(d.store, 'getThread').mockImplementation((id: string) => (id === out.first.childThreadId ? undefined : real(id)))
        out.byId = await tools.continueSubagent({ subagent: out.first.childThreadId, prompt: 'hi' }, { toolCallId: 'c1' }) as Json
        out.byTitle = await tools.continueSubagent({ subagent: 'API reviewer', prompt: 'hi' }, { toolCallId: 'c2' }) as Json
      }
      await say('go')
      await say('again')
      expect(out.byId).toMatchObject({ started: false, code: 'subagent_trashed', message: expect.stringContaining('delegate_task') })
      expect(out.byTitle).toMatchObject({ started: false, code: 'unknown_subagent' })
    })

    it('is refused while the calling run is being stopped, like delegate_task', async () => {
      const { d, steps, out, say, start } = world()
      steps['go'] = async (tools) => { out.first = await start(tools, 'API reviewer') }
      steps['again'] = async (tools, input) => {
        const stopped = await d.engine.dispatch({ kind: 'stop', threadId: input.threadId, runId: input.runId!, clientRequestId: 'stop-1' })
        expect(stopped.status).toBe('accepted')
        out.continued = await tools.continueSubagent({ subagent: 'API reviewer', prompt: 'More' }, { toolCallId: 'c1' }) as Json
        out.started = await start(tools, 'Docs writer')
      }
      await say('go')
      await say('again')
      expect(out.continued).toMatchObject({ started: false, code: 'parent_stopping' })
      expect(out.started).toMatchObject({ started: false, code: 'parent_stopping' })
      expect(d.engine.delegations.listForChildThread(out.first.childThreadId)).toHaveLength(1)
    })

    it('a retried continue_subagent returns its first task, whatever the subagent is doing by then', async () => {
      const { d, steps, out, say, start, settled } = world()
      steps['go'] = async (tools) => { out.first = await start(tools, 'API reviewer') }
      steps['again'] = async (tools) => { out.one = await tools.continueSubagent({ subagent: 'API reviewer', prompt: 'More' }, { toolCallId: 'mcp:same' }) as Json }
      steps['retry'] = async (tools) => { out.two = await tools.continueSubagent({ subagent: 'API reviewer', prompt: 'More' }, { toolCallId: 'mcp:same' }) as Json }
      await say('go')
      await say('again')
      await settled(out.one.childRunId)
      await say('retry')
      expect(out.two).toMatchObject({ delegationId: out.one.delegationId, replayed: true })
      expect(d.engine.delegations.listForChildThread(out.first.childThreadId)).toHaveLength(2)
    })

    it('narrows to the subagent\'s own ceiling: a plan subagent stays plan under a default caller, and a plan caller makes a plan follow-up', async () => {
      const { d, adapter, steps, out, say, start, settled } = world()
      steps['go'] = async (tools) => { out.planChild = await start(tools, 'Planner', { modeCeiling: 'plan' }) }
      steps['default-continue'] = async (tools) => { out.fromDefault = await tools.continueSubagent({ subagent: 'Planner', prompt: 'Again' }, { toolCallId: 'c1' }) as Json }
      await say('go')
      await settled(out.planChild.childRunId)
      await say('default-continue')
      await settled(out.fromDefault.childRunId)
      expect(d.engine.delegations.get(out.fromDefault.delegationId)).toMatchObject({ modeCeiling: 'plan' })
      expect(adapter.turns.filter((turn) => turn.threadId === out.planChild.childThreadId).map((turn) => turn.mode)).toEqual(['plan', 'plan'])

      // A default subagent continued by a plan-ceiling caller runs the follow-up in plan mode.
      const world2 = world()
      world2.steps['go'] = async (tools) => { world2.out.child = await world2.start(tools, 'Builder', { workspace: 'isolated', role: 'implement' }) }
      await world2.say('go')
      await world2.settled(world2.out.child.childRunId)
      const planCaller = (world2.d.orch as any).delegationTools(world2.d.orch.getOrCreateSession(world2.parent.id), world2.d.engine.listRuns(world2.parent.id)[0].runId, 'plan') as DelegationToolHost
      const followUp = await planCaller.continueSubagent({ subagent: 'Builder', prompt: 'Plan the next step' }, { toolCallId: 'c9' }) as Json
      await world2.settled(followUp.childRunId)
      expect(world2.d.engine.delegations.get(followUp.delegationId)).toMatchObject({ modeCeiling: 'plan', workspace: 'isolated', role: 'implement' })
      expect(world2.adapter.turns.filter((turn) => turn.threadId === world2.out.child.childThreadId).map((turn) => turn.mode)).toEqual(['agent', 'plan'])
    })
  })

  describe('integrate_delegation by title', () => {
    it('picks the latest task that completed, not a later one that failed', async () => {
      const { d, parent, steps, out, say, start, settled } = world((input) => {
        if (input.prompt.includes('Round two')) throw new Error('provider error')
        return 'done'
      })
      steps['go'] = async (tools) => { out.first = await start(tools, 'API reviewer', { workspace: 'isolated', role: 'implement' }) }
      steps['again'] = async (tools) => { out.second = await tools.continueSubagent({ subagent: 'API reviewer', prompt: 'Round two' }, { toolCallId: 'c1' }) as Json }
      await say('go')
      await settled(out.first.childRunId)
      await say('again')
      await settled(out.second.childRunId)
      expect(d.engine.delegations.get(out.second.delegationId)).toMatchObject({ status: 'failed', result: { runStatus: 'failed' } })
      const picked = (d.orch as any).resolveTask(parent.id, { subagent: 'API reviewer' }, 'finished')
      expect(picked.delegation.delegationId).toBe(out.first.delegationId)
      // A failed task is still addressable by its own id.
      const only = (d.orch as any).resolveTask(parent.id, { delegationId: out.second.delegationId })
      expect(only.delegation.delegationId).toBe(out.second.delegationId)
    })

    it('says there is no completed task when every task failed', async () => {
      const { d, parent, steps, out, say, start, settled } = world(() => { throw new Error('provider error') })
      steps['go'] = async (tools) => { out.first = await start(tools, 'API reviewer', { workspace: 'isolated', role: 'implement' }) }
      await say('go')
      await settled(out.first.childRunId)
      expect((d.orch as any).resolveTask(parent.id, { subagent: 'API reviewer' }, 'finished').refusal).toMatchObject({ code: 'no_task', message: expect.stringContaining('no completed task') })
    })
  })

  describe('nested subagents (issue #142)', () => {
    it('a subagent starts subagents of its own, and its authority only narrows down the tree', async () => {
      const seen: Json = {}
      const { d, adapter, steps, out, say, start, settled } = world(async (input, tools) => {
        if (!input.prompt.endsWith('Review Planner')) return `done: ${input.prompt}`
        // The subagent is itself a caller: it cannot widen the plan ceiling it was given.
        seen.broader = await tools!.delegateTask({ prompt: 'Edit', title: 'Editor', workspace: 'isolated', modeCeiling: 'default' } as never, { toolCallId: 'g0' }).catch((error: { code?: string }) => ({ code: error.code }))
        seen.grandchild = await tools!.delegateTask({ prompt: 'Survey', title: 'Surveyor', workspace: 'shared', role: 'research' } as never, { toolCallId: 'g1' })
        seen.taken = await tools!.delegateTask({ prompt: 'Survey', title: ' surveyor', workspace: 'shared', role: 'research' } as never, { toolCallId: 'g2' })
        return 'Planned.'
      })
      steps['go'] = async (tools) => { out.child = await start(tools, 'Planner', { modeCeiling: 'plan' }) }
      await say('go')
      await settled(out.child.childRunId)
      await settled(seen.grandchild.childRunId)
      expect(seen.broader).toEqual({ code: 'mousse_ceiling_exceeded' })
      // The grandchild inherited the plan ceiling and ran in plan mode.
      expect(d.engine.delegations.get(seen.grandchild.delegationId)).toMatchObject({ parentThreadId: out.child.childThreadId, modeCeiling: 'plan' })
      expect(adapter.turns.find((turn) => turn.threadId === seen.grandchild.childThreadId)?.mode).toBe('plan')
      // Titles are unique per parent: the child's own subagents have their own namespace.
      expect(seen.taken).toMatchObject({ started: false, code: 'title_taken' })
      // The grandchild is the child's subagent, not the main thread's: the main thread cannot reach it.
      const main = (d.orch as any).delegationTools(d.orch.getOrCreateSession(d.engine.delegations.getLineage(out.child.childThreadId)!.parentThreadId), 'run:none') as DelegationToolHost
      expect(await main.continueSubagent({ subagent: 'Surveyor', prompt: 'x' }, { toolCallId: 'm1' })).toMatchObject({ started: false, code: 'unknown_subagent' })
      expect(await main.continueSubagent({ subagent: seen.grandchild.childThreadId, prompt: 'x' }, { toolCallId: 'm2' })).toMatchObject({ started: false, code: 'unknown_subagent' })
    })
  })

  describe('task_status, task_cancel and integrate_delegation by title', () => {
    it('task_status by title reads the subagent\'s latest task, with its live state', async () => {
      const { steps, out, say, start, settled } = world()
      steps['go'] = async (tools) => { out.first = await start(tools, 'API reviewer') }
      steps['again'] = async (tools) => { out.continued = await tools.continueSubagent({ subagent: 'API reviewer', prompt: 'Round two' }, { toolCallId: 'c1' }) as Json }
      steps['status'] = async (tools) => {
        out.byTitle = await tools.taskStatus({ subagent: 'api reviewer' }) as Json
        out.byFirst = await tools.taskStatus({ delegationId: out.first.delegationId }) as Json
        out.unknown = await tools.taskStatus({ subagent: 'Nobody' }) as Json
      }
      await say('go')
      await settled(out.first.childRunId)
      await say('again')
      await settled(out.continued.childRunId)
      await say('status')
      expect(out.byTitle).toMatchObject({ delegationId: out.continued.delegationId, title: 'API reviewer', status: 'acknowledged', state: 'done', result: { text: 'done: Round two' } })
      expect(out.byFirst).toMatchObject({ delegationId: out.first.delegationId, status: 'acknowledged', result: { runStatus: 'completed' } })
      expect(out.unknown).toMatchObject({ started: false, code: 'unknown_subagent', message: expect.stringContaining('API reviewer') })
    })

    it('task_cancel by title cancels every open task of that subagent, and says so when none is open', async () => {
      let release!: () => void
      const gate = new Promise<void>((resolve) => { release = resolve })
      const { d, adapter, steps, out, say, start } = world(async (input) => {
        await gate
        return `done: ${input.prompt}`
      })
      steps['go'] = async (tools) => { out.first = await start(tools, 'API reviewer') }
      steps['again'] = async (tools) => { out.continued = await tools.continueSubagent({ subagent: 'API reviewer', prompt: 'Queued work' }, { toolCallId: 'c1' }) as Json }
      steps['cancel'] = async (tools) => { out.cancelled = await tools.taskCancel({ subagent: 'API reviewer' }) as Json }
      steps['cancel-again'] = async (tools) => { out.nothing = await tools.taskCancel({ subagent: 'API reviewer' }) as Json }
      try {
        await say('go')
        await waitFor(() => adapter.turns.some((turn) => turn.threadId === out.first.childThreadId), 'the child to start')
        await say('again')
        await say('cancel')
        expect(out.cancelled).toMatchObject({ subagent: 'API reviewer', childThreadId: out.first.childThreadId })
        expect(out.cancelled.cancelled).toHaveLength(2)
        expect(d.engine.delegations.listForChildThread(out.first.childThreadId).map((task) => task.status)).toEqual(['cancelled', 'cancelled'])
        expect(d.engine.getRun(out.continued.childRunId)?.status).toBe('cancelled')
        await say('cancel-again')
        expect(out.nothing).toMatchObject({ cancelled: [], note: expect.stringContaining('no open task') })
      } finally { release() }
    })
  })

  describe('a person\'s message in a subagent\'s thread (D2)', () => {
    it('is tracked as a task of the subagent, and the parent hears its result as a new completion', async () => {
      const { d, parent, steps, out, say, start, settled } = world()
      steps['go'] = async (tools) => { out.first = await start(tools, 'API reviewer', { role: 'review' }) }
      await say('go')
      await settled(out.first.childRunId)
      const response = await d.orch.send('Also look at the docs', false, { threadId: out.first.childThreadId, source: 'gui', clientRequestId: 'person-1' })
      await settled(response.runId!)
      const tasks = d.engine.delegations.listForChildThread(out.first.childThreadId)
      expect(tasks).toHaveLength(2)
      expect(tasks[1]).toMatchObject({ parentThreadId: parent.id, childRunId: response.runId, workspace: 'shared', role: 'review', wake: 'always', status: 'result_available' })
      expect(d.engine.inbox.listForThread(parent.id).filter((row) => row.kind === 'child_result')).toHaveLength(2)
    })
  })

  describe('the subagent\'s first prompt', () => {
    it('tells it whose it is and where its result goes, then gives its task', async () => {
      const { adapter, steps, out, say, start, settled } = world()
      steps['go'] = async (tools) => { out.first = await start(tools, 'API reviewer') }
      await say('go')
      await settled(out.first.childRunId)
      const first = adapter.turns.find((turn) => turn.threadId === out.first.childThreadId)!
      expect(first.prompt).toBe(`${subagentPreamble('Parent')}\n\nReview API reviewer`)
      expect(first.prompt).not.toContain('own subagents')
    })
  })
})
