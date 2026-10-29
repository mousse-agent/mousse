import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AssistantMessage, Message } from '../src/shared/transcript'
import { MousseMainService } from '../src/mms/MousseMainService'
import { ProviderAuthService } from '../src/mms/providers/ProviderAuthService'
import type { ProviderAdapter, TurnInput, TurnResult, TurnSink } from '../src/mms/harness/adapter'
import { normalizeProviderError } from '../src/mms/orchestrator/providerErrors'
import { testHarness } from '../src/mms/run/testkit/harness'
import { providerResponse } from './fixtures/agent-platform/agent-runtime-policy/helpers'
import { PI_TEST_CAPABILITIES } from './support/piStub'

const roots: string[] = []
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('orchestrator provider failure after a completed tool checkpoint', () => {
  it('persists the completed tool once and uses it in a manually resumed turn', async () => {
    const home = mkdtempSync(join(realpathSync(tmpdir()), 'mousse-orchestrator-checkpoint-')); roots.push(home)
    vi.spyOn(ProviderAuthService.prototype, 'init').mockResolvedValue(undefined)
    const main = await MousseMainService.create({ homeDir: home, headless: true, ownerKind: 'test' })
    await main.start()
    try {
      main.settings.set({ provider: { llmProvider: 'openai', model: 'fixture-model' },
        integrations: { ...main.settings.get().integrations, skills: { ...main.settings.get().integrations.skills, enabled: false } } })
      // The runtime runs its own tool loop and checkpoints its native transcript after each append; its
      // provider connection then drops before the model answers the tool result.
      let effects = 0
      const seen: Message[][] = []
      const adapter: ProviderAdapter = {
        driver: 'pi',
        capabilities: PI_TEST_CAPABILITIES,
        configured: () => true,
        async startTurn(input: TurnInput, sink: TurnSink): Promise<TurnResult> {
          seen.push(structuredClone(input.messages))
          const providerRef = { provider: input.llmProvider, model: input.model }
          sink.providerRef(providerRef)
          if (seen.length === 1) {
            const call = providerResponse([{ type: 'toolCall', id: 'effect-once', name: 'mcp_write', arguments: { value: 'one' } }], 'toolUse') as AssistantMessage
            effects += 1
            const result: Message = { role: 'toolResult', toolCallId: 'effect-once', toolName: 'mcp_write', content: [{ type: 'text', text: 'effect durably completed' }], isError: false, timestamp: Date.now() }
            sink.nativeMessages([...input.messages, call, result])
            // As Pi's engine reports a failed provider request.
            throw normalizeProviderError(new Error('ECONNRESET'), input.llmProvider)
          }
          const text = 'resumed with the completed effect'
          sink.text({ phase: 'complete', content: text, contentIndex: 0 })
          const reply = providerResponse([{ type: 'text', text }], 'stop') as AssistantMessage
          return { text, aborted: false, modelName: 'Scripted', totalResponseTimeMs: 1, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, contextSignature: 'scripted', nativeMessages: [...input.messages, reply], providerRef }
        },
        interrupt: async () => 'not_active'
      }
      main.orchestrator.setHarness(testHarness({ adapters: [adapter], profileHome: main.getProfileHomeDir() }))
      const thread = main.threads.createThread('Provider checkpoint fixture')
      const failed = await main.orchestrator.send({ content: 'perform fixture effect', mode: 'agent' }, false, { threadId: thread.id })
      expect(failed.error).toMatchObject({ code: 'provider_unavailable', errorInfo: { retryable: true } })
      expect(seen).toHaveLength(1)
      expect(effects).toBe(1)
      const checkpoint = main.orchestrator.getNativeContext(thread.id)
      expect(checkpoint.messages).toEqual(expect.arrayContaining([expect.objectContaining({ role: 'toolResult', toolCallId: 'effect-once', content: [{ type: 'text', text: 'effect durably completed' }] })]))
      const persisted = main.threads.loadThreadData(thread.id)
      expect(persisted.llmContext?.messages).toEqual(checkpoint.messages)
      expect(persisted.messages.at(-1)?.error).toMatchObject({ code: 'provider_unavailable' })

      const resumed = await main.orchestrator.send({ content: 'continue from the completed effect', mode: 'agent' }, false, { threadId: thread.id })
      expect(resumed.message).toBe('resumed with the completed effect')
      expect(effects).toBe(1)
      expect(seen[1]).toEqual(expect.arrayContaining([expect.objectContaining({ role: 'toolResult', toolCallId: 'effect-once' })]))
      expect(seen[1]!.filter((message) => message.role === 'toolResult')).toHaveLength(1)
    } finally { await main.stop() }
  }, 30_000)
})
