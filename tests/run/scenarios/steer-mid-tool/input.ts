import { expect } from 'vitest'
import type { Scenario } from '../types'

/**
 * The user steers while a command runs (SPEC §13.6; docs/design/steer-and-interruptions.md §2.12). The command runs
 * to its end and keeps its result; the steer is read after it, inside the same run, and no second run starts. How it
 * gets there is the adapter's: Claude Code holds from the call's announcement and cuts after its result; Codex holds
 * through the release window after the result, then cuts; ACP agents and Cursor, whose gaps were never measured, hold
 * until the provider's own turn ends and send the steer as the next prompt or run; Pi takes it at its next step.
 */
export const scenario: Scenario = {
  name: 'steer-mid-tool',
  prompt: 'Run the tests',
  // Pi joins with its cut-in (steer PR 4); until then it takes a steer at its next step, which `steer-mid-turn` covers.
  adapters: ['acp', 'antigravity', 'claude-subscription', 'codex', 'cursor'],
  assert({ run, runs, messages, llmMessages }) {
    expect(run).toMatchObject({ status: 'completed' })
    expect(runs).toHaveLength(1)
    const users = messages.filter((message) => message.role === 'user').map((message) => message.content)
    expect(users).toEqual(['Run the tests', 'Use pnpm'])
    const at = (id: string) => messages.findIndex((message) => message.id === id)
    // The command's row is complete (it ran to its end, not cut) and sits above the steer.
    const tools = messages.filter((message) => message.toolCall)
    expect(tools).toHaveLength(1)
    expect(tools[0]!.toolCall).toMatchObject({ status: 'complete' })
    expect(JSON.stringify(tools[0])).not.toMatch(/interrupted|No result reported/i)
    const steer = messages.find((message) => message.role === 'user' && message.content === 'Use pnpm')!
    expect(at(tools[0]!.id)).toBeLessThan(at(steer.id))
    // The reply that answers the steer comes after it.
    const answer = messages.find((message) => message.role === 'assistant' && !message.kind && message.content.includes('pnpm'))!
    expect(answer).toBeDefined()
    expect(at(steer.id)).toBeLessThan(at(answer.id))
    // The model's context has the steer once, between the prompt and the final reply.
    const steers = llmMessages.filter((message) => message.role === 'user' && JSON.stringify(message.content).includes('Use pnpm'))
    expect(steers).toHaveLength(1)
    expect(llmMessages.at(-1)?.role).toBe('assistant')
  }
}
