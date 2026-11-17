// #595: the turn's secret masker reaches the Claude service, whose hook hides secrets in Claude Code's own tool results
// (tests/claudeSubscriptionProvider.test.ts) before its session file keeps them. A lookup, read at each result, so a
// secret given mid-turn is hidden too.
import { describe, expect, it, vi } from 'vitest'
import { ClaudeSubscriptionAdapter, type ClaudeSubscriptionClient } from '../../src/mms/harness/drivers/claudeCode/adapter'
import type { AdapterHost, TurnInput, TurnSink } from '../../src/mms/harness/adapter'
import type { ClaudeSubscriptionChatInput } from '../../src/mms/harness/vendors/claude/ClaudeSubscriptionProviderService'

const noop = () => {}
const sink = (): TurnSink => ({ text: noop, thinking: noop, tool: noop, nativeMessages: noop, compaction: noop, retry: noop, progress: noop, usage: noop, providerRef: noop, steerAccepted: noop, providerMetrics: noop, lineEdits: noop })
const turnInput: TurnInput = { runId: 'run-1', attemptId: 'a', threadId: 'thread-1', cwd: '/work', instanceId: 'claude', model: 'm', llmProvider: 'claude', modelPinned: true, mode: 'agent', prompt: 'hi', messages: [], signal: new AbortController().signal }

describe("a Claude turn's secret masker", () => {
  it('is handed to the service as the lookup the host gave, so each tool result reads the masker of that moment', async () => {
    const inputs: ClaudeSubscriptionChatInput[] = []
    const client = {
      chat: vi.fn(async (chat: ClaudeSubscriptionChatInput) => { inputs.push(chat); return 'done' }),
      commitConversation: vi.fn(),
      standaloneWorkspace: vi.fn(() => '/standalone'),
      configured: () => true
    } satisfies ClaudeSubscriptionClient
    let current: ((text: string) => string) | undefined
    const host: AdapterHost = {
      tools: { secretMasker: () => current },
      context: { recoverOverflow: () => null, prepareNativeContext: () => null, nativeHistoryAfterTurn: () => '' }
    }
    await new ClaudeSubscriptionAdapter(() => client).startTurn(turnInput, sink(), { drainSteer: () => undefined, heartbeat: noop }, host)
    const handed = inputs[0]!.secretMasker!
    expect(handed()).toBeUndefined()
    current = (text) => text.replace('tok', '[hidden]')
    expect(handed()?.('a tok')).toBe('a [hidden]')
  })
})
