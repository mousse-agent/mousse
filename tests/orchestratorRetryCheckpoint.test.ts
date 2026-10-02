import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@earendil-works/pi-ai'
import { MousseMainService } from '../src/mms/MousseMainService'
import { ProviderAuthService } from '../src/mms/providers/ProviderAuthService'
import { fixtureModel, providerResponse, streamOf } from './fixtures/agent-platform/agent-runtime-policy/helpers'

const roots: string[] = []
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('orchestrator provider failure after a completed tool checkpoint', () => {
  it('persists the completed tool once and uses it in a manually resumed turn', async () => {
    const home = mkdtempSync(join(realpathSync(tmpdir()), 'mousse-orchestrator-checkpoint-')); roots.push(home)
    vi.spyOn(ProviderAuthService.prototype, 'init').mockResolvedValue(undefined)
    const main = await MousseMainService.create({ homeDir: home, headless: true, ownerKind: 'test' })
    await main.start()
    try {
      main.settings.set({ provider: { llmProvider: 'fixture-provider', model: 'fixture-model' },
        integrations: { ...main.settings.get().integrations, skills: { ...main.settings.get().integrations.skills, enabled: false } } })
      vi.spyOn(main.providerAuth, 'has').mockReturnValue(true)
      vi.spyOn(main.providerAuth.models, 'getModel').mockImplementation((provider, id) => fixtureModel(provider, id) as never)
      vi.spyOn(main.providerAuth.models, 'getAuth').mockResolvedValue({ apiKey: 'fixture' } as never)
      vi.spyOn(main.mcpManager, 'getEnabledTools').mockResolvedValue([{ id: 'mcp', serverId: 'fixture-server', serverName: 'Fixture', toolName: 'write', providerName: 'mcp_write', inputSchema: { type: 'object' } }] as never)
      vi.spyOn(main.mcpManager, 'isToolCallAllowed').mockResolvedValue({ allowed: true })
      const effect = vi.spyOn(main.mcpManager, 'callTool').mockResolvedValue({ text: 'effect durably completed', isError: false } as never)
      const contexts: Context[] = []
      const stream = vi.spyOn(main.providerAuth.models, 'streamSimple').mockImplementation((_model, context) => {
        contexts.push(structuredClone(context))
        if (contexts.length === 1) return streamOf(providerResponse([{ type: 'toolCall', id: 'effect-once', name: 'mcp_write', arguments: { value: 'one' } }], 'toolUse')) as never
        if (contexts.length === 2) return {
          async *[Symbol.asyncIterator]() {
            yield { type: 'thinking_start', contentIndex: 0, partial: providerResponse([], 'error') }
            throw new Error('ECONNRESET')
          }, result: async () => providerResponse([], 'error', 4, 0, { errorMessage: 'ECONNRESET' })
        } as never
        return streamOf(providerResponse([{ type: 'text', text: 'resumed with the completed effect' }], 'stop')) as never
      })
      const thread = main.threads.createThread('Provider checkpoint fixture')
      const failed = await main.orchestrator.send({ content: 'perform fixture effect', mode: 'agent' }, false, { threadId: thread.id })
      expect(failed.error).toMatchObject({ code: 'provider_unavailable', errorInfo: { retryable: true } })
      expect(stream).toHaveBeenCalledTimes(2)
      expect(effect).toHaveBeenCalledOnce()
      const checkpoint = main.orchestrator.getNativeContext(thread.id)
      expect(checkpoint.messages).toEqual(expect.arrayContaining([expect.objectContaining({ role: 'toolResult', toolCallId: 'effect-once', content: [{ type: 'text', text: 'effect durably completed' }] })]))
      const persisted = main.threads.loadThreadData(thread.id)
      expect(persisted.llmContext?.messages).toEqual(checkpoint.messages)
      expect(persisted.messages.at(-1)?.error).toMatchObject({ code: 'provider_unavailable' })

      const resumed = await main.orchestrator.send({ content: 'continue from the completed effect', mode: 'agent' }, false, { threadId: thread.id })
      expect(resumed.message).toBe('resumed with the completed effect')
      expect(effect).toHaveBeenCalledOnce()
      expect(contexts[2]!.messages).toEqual(expect.arrayContaining([expect.objectContaining({ role: 'toolResult', toolCallId: 'effect-once' })]))
      expect(contexts[2]!.messages.filter((message) => message.role === 'toolResult')).toHaveLength(1)
    } finally { await main.stop() }
  }, 30_000)
})
