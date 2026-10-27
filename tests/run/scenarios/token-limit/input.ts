import { expect } from 'vitest'
import type { Scenario } from '../types'

/**
 * The agent ends the prompt with `max_tokens` after part of a reply: the turn fails with a message
 * that the reply is incomplete, and the part it wrote is kept as an incomplete reply.
 */
export const scenario: Scenario = {
  name: 'token-limit',
  prompt: 'Write the full report',
  adapters: ['acp'],
  assert({ response, run, messages, llmMessages, turnState }) {
    expect(run).toMatchObject({ status: 'failed' })
    expect(turnState.phase).toBe('failed')
    expect(response.error).toMatchObject({ code: 'acp_incomplete_reply' })
    expect(response.message).toContain('Replay agent stopped before it finished')
    expect(messages.filter((message) => message.role === 'assistant' && !message.kind)).toEqual([
      expect.objectContaining({ content: 'The first half', streaming: false, incomplete: true })
    ])
    expect(llmMessages.map((message) => message.role)).toEqual(['user'])
  }
}
