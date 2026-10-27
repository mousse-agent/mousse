import { expect } from 'vitest'
import type { Scenario } from '../types'

/**
 * A prompt that is a slash command goes to the agent as the first text block, exactly as typed, so
 * the agent expands it. (With a handed-over history the history follows as a second block; that
 * layout is pinned in `tests/harness/acpSession.test.ts`.)
 */
export const scenario: Scenario = {
  name: 'slash-command',
  prompt: '/review src/main.ts',
  adapters: ['acp'],
  assert({ response, run }) {
    expect(response.message).toBe('Reviewing src/main.ts')
    expect(run).toMatchObject({ status: 'completed' })
  }
}
