import { expect } from 'vitest'
import type { Scenario } from '../types'

/** One prompt, one streamed reply, nothing else. */
export const scenario: Scenario = {
  name: 'plain-turn',
  prompt: 'Say hello',
  assert({ response, run, messages, llmMessages, turnState }) {
    expect(response.message).toBe('Hello from replay')
    expect(run).toMatchObject({ status: 'completed' })
    expect(turnState.phase).toBe('completed')
    const replies = messages.filter((message) => message.role === 'assistant' && !message.kind)
    expect(replies).toHaveLength(1)
    expect(replies[0]).toMatchObject({ content: 'Hello from replay', streaming: false })
    expect(replies[0].incomplete).toBeUndefined()
    expect(llmMessages.map((message) => message.role)).toEqual(['user', 'assistant'])
    expect(llmMessages[1].content).toEqual([{ type: 'text', text: 'Hello from replay' }])
  }
}
