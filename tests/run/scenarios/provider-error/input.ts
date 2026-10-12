import { expect } from 'vitest'
import type { Scenario } from '../types'

/** The provider fails mid-reply: the run fails, the partial reply is kept as incomplete. */
export const scenario: Scenario = {
  name: 'provider-error',
  prompt: 'Summarise the repository',
  assert({ response, run, messages, llmMessages, turnState }) {
    expect(run).toMatchObject({ status: 'failed' })
    expect(turnState.phase).toBe('failed')
    // A provider failure without a typed error surfaces as a sanitised turn failure.
    expect(response.error).toMatchObject({ code: 'orchestrator_turn_failed' })
    expect(response.message).toMatch(/^\[orchestrator_turn_failed\] /)
    const replies = messages.filter((message) => message.role === 'assistant' && !message.kind)
    expect(replies).toEqual([expect.objectContaining({ content: 'Partial', streaming: false, incomplete: true })])
    const failure = messages.at(-1)
    expect(failure).toMatchObject({ role: 'system', content: response.message, error: response.error })
    // A failed turn adds no assistant reply to the canonical transcript.
    expect(llmMessages.map((message) => message.role)).toEqual(['user'])
  }
}
