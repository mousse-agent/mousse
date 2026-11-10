import { expect } from 'vitest'
import type { Scenario } from '../types'

/**
 * The user steers while the reply streams. The provider takes the guidance inside the same run (Codex by
 * cutting its server turn and starting the next with it), the steer lands in the canonical transcript
 * between the prompt and the final reply, and no second run starts.
 */
export const scenario: Scenario = {
  name: 'steer-mid-turn',
  prompt: 'Review the change',
  assert({ response, run, messages, llmMessages }) {
    expect(response.message).toBe('Working\n\nDone with tests')
    expect(run).toMatchObject({ status: 'completed' })
    const users = messages.filter((message) => message.role === 'user').map((message) => message.content)
    expect(users).toEqual(['Review the change', 'Focus on tests'])
    // The reply as a whole is what it was. A provider that takes the steer while it runs ends the row it was
    // writing there, so the reply goes on below the steered message: the steer sits between the two parts.
    const replies = messages.filter((message) => message.role === 'assistant' && !message.kind)
    expect(replies.map((message) => message.content).join('\n\n')).toBe('Working\n\nDone with tests')
    for (const reply of replies) expect(reply).toMatchObject({ streaming: false })
    if (replies.length > 1) {
      const at = (id: string) => messages.findIndex((message) => message.id === id)
      const steer = messages.find((message) => message.role === 'user' && message.content === 'Focus on tests')!
      expect(replies.map((message) => message.content)).toEqual(['Working', 'Done with tests'])
      expect(at(replies[0]!.id)).toBeLessThan(at(steer.id))
      expect(at(steer.id)).toBeLessThan(at(replies[1]!.id))
    }
    const roles = llmMessages.map((message) => message.role)
    expect(roles[0]).toBe('user')
    expect(roles.at(-1)).toBe('assistant')
    const steerIndex = llmMessages.findIndex((message) => message.role === 'user' && message.content === 'Focus on tests')
    expect(steerIndex).toBeGreaterThan(0)
    expect(steerIndex).toBeLessThan(llmMessages.length - 1)
  }
}
