import { expect } from 'vitest'
import type { Scenario } from '../types'

/**
 * SPEC §16.1: a thread answered by pi switches to Claude. Claude never ran on the thread, so its
 * first turn gets a `full_summary` handoff: the `<handoff>` block in front of the prompt (asserted
 * in the outbound SDK frame) and no raw history preamble.
 */
export const scenario: Scenario = {
  name: 'provider-switch',
  prompt: 'Now refactor it',
  adapters: ['claude-subscription'],
  before: [{ adapter: 'pi', prompt: 'Write a parser' }],
  assert({ response, run, runs, handoffs, messages }) {
    expect(response.message).toBe('Refactored with the earlier parser in mind.')
    expect(run).toMatchObject({ status: 'completed', ordinal: 2 })
    expect(runs.map((entry) => entry.status)).toEqual(['completed', 'completed'])
    expect(handoffs).toHaveLength(1)
    expect(handoffs[0]).toMatchObject({
      targetRunId: run.runId,
      strategy: 'full_summary',
      status: 'delivered',
      coveredFromOrdinal: 1,
      coveredToOrdinal: 1,
      selectedItems: 2,
      omittedItems: 0,
      fromRef: { provider: 'openai', model: 'gpt-replay' },
      toRef: { provider: 'claude-subscription', model: 'sonnet' }
    })
    const marker = messages.find((message) => message.kind === 'context_handoff')
    expect(marker?.contextHandoff).toMatchObject({ handoffId: handoffs[0].handoffId, strategy: 'full_summary', selectedItems: 2, omittedItems: 0 })
  }
}
