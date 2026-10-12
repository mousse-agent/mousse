import { expect } from 'vitest'
import type { Scenario } from '../types'

/**
 * The user steers while the reply streams. The provider takes the guidance inside the same run,
 * the steer lands in the canonical transcript between the prompt and the final reply, and no
 * second run starts.
 */
export const scenario: Scenario = {
  name: 'steer-mid-turn',
  prompt: 'Review the change',
  assert({ response, run, messages, llmMessages }) {
    expect(response.message).toBe('Working\n\nDone with tests')
    expect(run).toMatchObject({ status: 'completed' })
    const users = messages.filter((message) => message.role === 'user').map((message) => message.content)
    expect(users).toEqual(['Review the change', 'Focus on tests'])
    expect(messages.filter((message) => message.role === 'assistant' && !message.kind).at(-1)).toMatchObject({
      content: 'Working\n\nDone with tests',
      streaming: false
    })
    const roles = llmMessages.map((message) => message.role)
    expect(roles[0]).toBe('user')
    expect(roles.at(-1)).toBe('assistant')
    const steerIndex = llmMessages.findIndex((message) => message.role === 'user' && message.content === 'Focus on tests')
    expect(steerIndex).toBeGreaterThan(0)
    expect(steerIndex).toBeLessThan(llmMessages.length - 1)
  }
}
