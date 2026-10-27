import { expect } from 'vitest'
import type { Scenario } from '../types'

/**
 * The agent ends the prompt with `cancelled` although Mousse asked for no cancel (the agent's own
 * UI stopped it): the run is interrupted like a Stop, the partial reply is kept, never a clean success.
 */
export const scenario: Scenario = {
  name: 'cancelled-by-agent',
  prompt: 'Run the migration',
  adapters: ['acp'],
  assert({ run, messages, llmMessages }) {
    expect(run).toMatchObject({ status: 'interrupted' })
    const replies = messages.filter((message) => message.role === 'assistant' && !message.kind)
    expect(replies).toEqual([expect.objectContaining({ content: 'Starting', streaming: false, incomplete: true })])
    expect(llmMessages.map((message) => message.role)).not.toContain('assistant')
  }
}
