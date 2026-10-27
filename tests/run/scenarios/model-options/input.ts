import { expect } from 'vitest'
import type { Scenario } from '../types'

/**
 * A session that lists several `model` selects, one with an empty default value: the session
 * opens and the turn runs on the agent's own default (no model is set).
 */
export const scenario: Scenario = {
  name: 'model-options',
  prompt: 'Say hello',
  adapters: ['acp'],
  assert({ response, run, messages }) {
    expect(response.message).toBe('Hello from the default model')
    expect(run).toMatchObject({ status: 'completed' })
    expect(messages.filter((message) => message.role === 'assistant' && !message.kind)).toEqual([
      expect.objectContaining({ content: 'Hello from the default model', streaming: false })
    ])
  }
}
