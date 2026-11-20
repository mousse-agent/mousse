import { expect } from 'vitest'
import type { Scenario } from '../types'

/**
 * Adapters whose fixture has the person's steer stop the running command (SPEC §13.3: a person's steer cuts in at
 * once): the generic ACP agent gets `session/cancel` while the command runs, and the steer goes in as the next prompt.
 */
const STOPS_COMMAND = new Set(['acp'])

/**
 * The user steers while a command runs (SPEC §13.6; docs/design/steer-and-interruptions.md). The steer is read once,
 * inside the same run, and no second run starts. Whether the command keeps its result is the adapter's:
 * - ACP agents cancel the running prompt, so the command is stopped and its row reads interrupted;
 * - Antigravity 1.5.0 and newer takes the steer as a second `session/prompt` with no cancel, so the command runs to
 *   its end and keeps its result;
 * - the Claude Code, Codex and Cursor fixtures have the steer reach the adapter after the command's result.
 * Pi takes it at its next step, which `steer-mid-turn` covers.
 */
export const scenario: Scenario = {
  name: 'steer-mid-tool',
  prompt: 'Run the tests',
  adapters: ['acp', 'antigravity', 'claude-subscription', 'codex', 'cursor'],
  assert({ adapterId, run, runs, messages, llmMessages }) {
    expect(run).toMatchObject({ status: 'completed' })
    expect(runs).toHaveLength(1)
    const users = messages.filter((message) => message.role === 'user').map((message) => message.content)
    expect(users).toEqual(['Run the tests', 'Use pnpm'])
    const at = (id: string) => messages.findIndex((message) => message.id === id)
    // The command's row sits above the steer: stopped by it, or complete when it ran to its end.
    const tools = messages.filter((message) => message.toolCall)
    expect(tools).toHaveLength(1)
    if (STOPS_COMMAND.has(adapterId)) expect(tools[0]!.activity).toMatchObject({ status: 'interrupted' })
    else {
      expect(tools[0]!.toolCall).toMatchObject({ status: 'complete' })
      expect(JSON.stringify(tools[0])).not.toMatch(/interrupted|No result reported/i)
    }
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
