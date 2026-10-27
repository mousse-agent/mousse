/**
 * A `/skill` mention in a message another thread's agent wrote loads no skill (docs/run-engine/SPEC.md §15.1):
 * only a person invokes one. The Mousse MCP runtimes get the message without its text passed to skill loading
 * (`completeAppTurn`); the in-process pi loop reads the last user message itself, so the turn tells it not to.
 */
import { describe, expect, it, vi } from 'vitest'
import { PiLoopAdapter } from '../../src/mms/run/adapters/pi/PiLoopAdapter'
import type { TurnInput } from '../../src/mms/run/adapters/ProviderAdapter'

const noop = (): void => undefined
const sink = { text: noop, thinking: noop, tool: noop, nativeMessages: noop, compaction: noop, retry: noop, progress: noop, usage: noop, providerRef: noop, steerAccepted: noop, providerMetrics: noop, lineEdits: noop }
const control = { drainSteer: () => undefined, heartbeat: noop }
const host = { tools: {}, context: { recoverOverflow: () => null, prepareNativeContext: () => null, nativeHistoryAfterTurn: () => '' } } as never
const input = (extra: Partial<TurnInput> = {}): TurnInput =>
  ({ runId: 'r', attemptId: 'a', threadId: 't', cwd: null, instanceId: 'pi:p', model: 'm', llmProvider: 'p', modelPinned: true, mode: 'agent', permissionMode: 'ask', prompt: '/deploy now', messages: [], signal: new AbortController().signal, ...extra }) as TurnInput

async function chatOptions(turn: TurnInput): Promise<Record<string, unknown>> {
  const chat = vi.fn(async () => ({ message: 'ok', actions: [], aborted: false, modelName: 'm', totalResponseTimeMs: 1, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, contextSignature: 's', nativeMessages: [] }))
  await new PiLoopAdapter(() => ({ chat }) as never).startTurn(turn, sink as never, control as never, host).catch(() => undefined)
  expect(chat).toHaveBeenCalledTimes(1)
  return (chat.mock.calls[0] as unknown as unknown[])[2] as Record<string, unknown>
}

describe('skill mentions in an agent\'s message', () => {
  it('the pi loop is told to read none when the message is another thread\'s agent\'s, and reads them as before for a person\'s', async () => {
    expect((await chatOptions(input({ fromAgent: true }))).skillMentions).toBe(false)
    expect('skillMentions' in (await chatOptions(input()))).toBe(false)
  })
})
