import { expect } from 'vitest'
import type { Scenario } from '../types'

/** The agent answers the prompt with `refusal`: the turn fails and says the agent refused. */
export const scenario: Scenario = {
  name: 'refused-by-agent',
  prompt: 'Delete everything',
  adapters: ['acp'],
  assert({ response, run, messages, llmMessages, turnState }) {
    expect(run).toMatchObject({ status: 'failed' })
    expect(turnState.phase).toBe('failed')
    expect(response.error).toMatchObject({ code: 'acp_refusal' })
    expect(response.message).toContain('Replay agent refused this request')
    expect(messages.filter((message) => message.role === 'assistant' && !message.kind)).toEqual([])
    expect(llmMessages.map((message) => message.role)).toEqual(['user'])
  }
}
