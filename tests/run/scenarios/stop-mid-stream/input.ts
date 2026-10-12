import { expect } from 'vitest'
import type { Scenario } from '../types'

/** Stop arrives while the reply streams: the run is interrupted and the partial reply is kept. */
export const scenario: Scenario = {
  name: 'stop-mid-stream',
  prompt: 'Write a long essay',
  assert({ response, run, messages, turnState }) {
    expect(run).toMatchObject({ status: 'interrupted' })
    expect(turnState.phase).toBe('stopped')
    expect(response.message).toBe('Partial')
    const replies = messages.filter((message) => message.role === 'assistant' && !message.kind)
    expect(replies).toHaveLength(1)
    expect(replies[0]).toMatchObject({ content: 'Partial', streaming: false, incomplete: true })
    expect(messages.at(-1)).toMatchObject({ role: 'system', content: 'Turn stopped.' })
  }
}
