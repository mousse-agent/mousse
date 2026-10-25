import { expect } from 'vitest'
import type { Scenario } from '../types'

/**
 * SPEC §14: the parent turn calls `delegate_task`; the child runs on its own thread; its
 * completion lands in the parent's inbox; rule 4 wakes the idle parent, whose wake turn reads the
 * result with `task_status` (acknowledging it).
 */
export const scenario: Scenario = {
  name: 'delegate-child',
  prompt: 'Count the modules with a helper',
  adapters: ['pi'],
  delegates: true,
  assert({ response, run, runs, delegations, messages }) {
    expect(response.message).toBe('Delegated the count.')
    expect(run).toMatchObject({ status: 'completed' })
    expect(runs.map((entry) => [entry.source, entry.status])).toEqual([['protocol', 'completed'], ['wake', 'completed']])
    expect(delegations).toHaveLength(1)
    expect(delegations[0]).toMatchObject({
      status: 'acknowledged',
      parentRunId: run.runId,
      result: { runStatus: 'completed', text: 'Three modules: run, agents, orchestrator.' }
    })
    const notice = messages.find((message) => message.role === 'user' && message.content.startsWith('Subagent'))
    expect(notice?.content).toBe(
      `Subagent "Module counter" (thread ${delegations[0].childThreadId}) finished task ${delegations[0].delegationId}.\nThree modules: run, agents, orchestrator.\nFull result above.`
    )
    // The message carries what it reports, so the app never parses the text.
    expect(notice?.subagentNotice).toEqual([
      { delegationId: delegations[0].delegationId, childThreadId: delegations[0].childThreadId, title: 'Module counter', runStatus: 'completed', fullyShown: true }
    ])
    expect(messages.at(-1)).toMatchObject({ role: 'assistant', content: 'The helper found three modules.' })
  }
}
