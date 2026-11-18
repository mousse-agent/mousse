/**
 * A parent whose turn is over waits on a subagent a usage limit paused. The parent has no pause of its own, so its
 * notice stands for the subagent, and its Try now sends the subagent's own Resume now (`runs.resumeNow` for the
 * subagent's run). A real `OrchestratorService`, Run Engine and effect worker with a scripted pi adapter.
 */
import { describe, expect, it, vi } from 'vitest'
import { usageLimitError } from '../../src/mms/orchestrator/providerErrors'
import { waitFor } from './phase6Fixture'
import { useSubagentWorld } from './subagentWorld'

vi.setConfig({ testTimeout: 30_000 })

describe('a parent waiting on a subagent the usage limit paused', () => {
  const world = useSubagentWorld()

  it('stays waiting until Try now resumes the subagent, then gets its result', async () => {
    let limited = true
    const { d, parent, steps, out, say, start, settled, reconciler } = world((input) => {
      if (limited) {
        limited = false
        // An hour ahead, and auto-resume is off: nothing continues the subagent by itself.
        throw usageLimitError({ provider: 'claude', resetsAt: new Date(Date.now() + 3_600_000).toISOString(), estimated: false, limitKind: 'five_hour' })
      }
      return `done: ${input.prompt.split('\n').at(-1)}`
    })
    steps['go'] = async (tools) => { out.child = await start(tools, 'API reviewer') }
    const first = await say('go')
    await settled(first.runId!)
    const childThreadId = out.child.childThreadId as string
    await waitFor(() => d.engine.store.getPausedRun(childThreadId) !== null, 'the subagent to pause')

    // The parent's turn is over and it is not paused itself; its task waits on the paused subagent.
    const parentRuns = () => d.engine.listRuns(parent.id)
    expect(d.engine.store.getPausedRun(parent.id)).toBeNull()
    expect(d.orch.getTurnState(parent.id).phase).not.toBe('paused')
    expect(d.orch.getTurnState(childThreadId)).toMatchObject({ phase: 'paused', pause: { autoResume: false } })
    expect(d.engine.delegations.get(out.child.delegationId)).toMatchObject({ status: 'running' })
    // Nothing wakes the parent: there is no result to give it.
    expect(d.engine.inbox.listPending(parent.id)).toEqual([])
    expect(reconciler.runOnce().wakes.wakes).toEqual([])
    expect(parentRuns()).toHaveLength(1)

    // The parent's Try now: the paused subagent's own resume.
    const paused = d.engine.store.getPausedRun(childThreadId)!
    await d.orch.resumePausedRun(paused.runId)

    await waitFor(() => d.engine.delegations.get(out.child.delegationId)?.status !== 'running', 'the task to finish')
    expect(d.engine.delegations.get(out.child.delegationId)).toMatchObject({ result: { runStatus: 'completed', text: expect.stringContaining('done:') } })
    // The parent's wait ends: it is woken with the result and answers it.
    expect(d.engine.inbox.listPending(parent.id)).toHaveLength(1)
    const [wakeRunId] = reconciler.runOnce().wakes.wakes
    expect(wakeRunId).toBeTruthy()
    await settled(wakeRunId)
    expect(d.engine.getRun(wakeRunId)).toMatchObject({ threadId: parent.id, source: 'wake', status: 'completed' })
    expect(d.engine.store.getPausedRun(childThreadId)).toBeNull()
  })
})
