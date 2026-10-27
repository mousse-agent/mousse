import { expect } from 'vitest'
import type { Scenario } from '../types'

/** The provider fails mid-reply: the run fails, the partial reply is kept as incomplete. */
export const scenario: Scenario = {
  name: 'provider-error',
  prompt: 'Summarise the repository',
  assert({ adapterId, response, run, messages, llmMessages, turnState }) {
    expect(run).toMatchObject({ status: 'failed' })
    expect(turnState.phase).toBe('failed')
    // A provider failure without a typed error surfaces as a sanitised turn failure. The Pi RPC
    // engine types every failed request from Pi's error text (`normalizeProviderError`).
    const code = adapterId === 'pi-rpc' ? 'provider_unknown' : 'orchestrator_turn_failed'
    expect(response.error).toMatchObject({ code })
    expect(response.message.startsWith(`[${code}] `)).toBe(true)
    const replies = messages.filter((message) => message.role === 'assistant' && !message.kind)
    expect(replies).toEqual([expect.objectContaining({ content: 'Partial', streaming: false, incomplete: true })])
    const failure = messages.at(-1)
    expect(failure).toMatchObject({ role: 'system', content: response.message, error: response.error })
    // A failed turn adds no assistant reply to the canonical transcript.
    expect(llmMessages.map((message) => message.role)).toEqual(['user'])
  }
}
