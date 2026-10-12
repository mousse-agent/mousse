import { expect } from 'vitest'
import type { Scenario } from '../types'

/**
 * SPEC §16.2: a thread is forked after its first run; nothing reaches the provider until the fork's
 * first message, which carries the source conversation as a portable `full_summary` (pi receives
 * it as transcript messages, asserted in the outbound chat frame) and consumes the fork transfer.
 */
export const scenario: Scenario = {
  name: 'fork-first-message',
  prompt: 'Try the recursive variant',
  adapters: ['pi'],
  before: [{ adapter: 'pi', prompt: 'Plan the parser' }],
  fork: true,
  assert({ response, run, runs, handoffs, transfers, llmMessages }) {
    expect(response.message).toBe('Recursive variant sketched.')
    expect(run).toMatchObject({ status: 'completed', ordinal: 1 })
    expect(runs).toHaveLength(1)
    expect(transfers).toHaveLength(1)
    expect(transfers[0]).toMatchObject({ type: 'fork', status: 'consumed', sourceRunOrdinal: 1, payload: { forkStrategy: 'portable', strategy: 'full_summary' } })
    expect(handoffs).toMatchObject([{ strategy: 'full_summary', status: 'delivered', coveredFromOrdinal: 1, coveredToOrdinal: 1, selectedItems: 2 }])
    // The fork keeps the handed-over context in its own transcript.
    expect(llmMessages.map((message) => message.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
  }
}
