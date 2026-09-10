import { describe, expect, it } from 'vitest'
import type { AssistantMessage, Context } from '@earendil-works/pi-ai'
import { LlmClient } from '../src/mms/orchestrator/LlmClient'
import { userMessage } from '../src/mms/orchestrator/nativeContext'
import { getDefaultSettings } from '../src/shared/settings'
import { defaultIntegrationActor } from '../src/shared/integrations/actor'
import { resolveEffectiveSkills } from '../src/mms/integrations/catalog/EffectiveIntegrationResolver'
import type { SkillsRegistrySnapshot } from '../src/shared/integrations'
import { McpManager } from '../src/mms/integrations/mcp/McpManager'
import { injectedFactory, settingsStore, testServerConfig } from './fixtures/agent-platform/integrations/helpers'

const emptyCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }

function response(
  content: AssistantMessage['content'],
  stopReason: AssistantMessage['stopReason']
): AssistantMessage {
  return {
    role: 'assistant',
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: 'claude-test',
    content,
    stopReason,
    timestamp: Date.now(),
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: emptyCost }
  } as AssistantMessage
}

function streamOf(message: AssistantMessage) {
  return {
    async *[Symbol.asyncIterator]() {},
    result: async () => message
  }
}

describe('I01 actor grants and LlmClient gating', () => {
  it('does not expose a disabled skill to the main actor while a child grant can still see an enabled one', () => {
    const snapshot: SkillsRegistrySnapshot = {
      sources: [],
      diagnostics: [],
      skills: [
        {
          id: 'mousse-profile:one',
          installationId: 'mousse-profile:one',
          name: 'one',
          description: 'Enabled',
          rootPath: '/tmp/one',
          skillPath: '/tmp/one/SKILL.md',
          scope: 'global',
          source: 'mousse-profile',
          enabled: true,
          isActive: true
        },
        {
          id: 'mousse-profile:two',
          installationId: 'mousse-profile:two',
          name: 'two',
          description: 'Disabled',
          rootPath: '/tmp/two',
          skillPath: '/tmp/two/SKILL.md',
          scope: 'global',
          source: 'mousse-profile',
          enabled: false,
          isActive: true
        }
      ]
    }
    const settings = getDefaultSettings().integrations.skills
    settings.enabled = true
    settings.enableForMainAgent = true
    settings.enableForAgents.mousse = true
    settings.enabledSkills = ['mousse-profile:one', 'mousse-profile:two']
    const main = resolveEffectiveSkills({
      snapshot,
      settings,
      actor: defaultIntegrationActor(false)
    })
    expect(main.map((skill) => skill.name)).toEqual(['one'])
  })

  it('refuses an MCP tool at call time after the installation is disabled', async () => {
    const store = settingsStore((settings) => {
      settings.integrations.mcp.enabled = true
      settings.integrations.mcp.enableForMainAgent = true
      settings.integrations.mcp.enabledServers = ['inst-echo']
    })
    const manager = new McpManager(
      {
        discover: async () => ({
          servers: [testServerConfig()],
          sources: [],
          diagnostics: []
        })
      } as never,
      store as never,
      async () => {},
      { clientFactory: injectedFactory() }
    )
    const tools = await manager.getEnabledTools(undefined, 'main')
    expect(tools).toHaveLength(1)
    store.get().integrations.mcp.enabledServers = []
    const allowed = await manager.isToolCallAllowed(
      tools[0]!.providerName,
      undefined,
      defaultIntegrationActor(false)
    )
    expect(allowed.allowed).toBe(false)
  })

  it('refuses a tool descriptor after its server configuration revision changes', async () => {
    let revision = 'rev1'
    const store = settingsStore((settings) => {
      settings.integrations.mcp.enabled = true
      settings.integrations.mcp.enableForMainAgent = true
      settings.integrations.mcp.enabledServers = ['inst-echo']
    })
    const manager = new McpManager(
      {
        discover: async () => ({
          servers: [testServerConfig({ configRevision: revision })],
          sources: [],
          diagnostics: []
        })
      } as never,
      store as never,
      async () => {},
      { clientFactory: injectedFactory() }
    )
    const tools = await manager.getEnabledTools(undefined, 'main')
    revision = 'rev2'
    const allowed = await manager.isToolCallAllowed(
      tools[0]!.providerName,
      undefined,
      defaultIntegrationActor(false)
    )
    expect(allowed).toMatchObject({
      allowed: false,
      reason: 'MCP server configuration changed. Refresh tools before calling it.'
    })
  })

  it('offers MCP tools to a Mousse child when only child grants are enabled', async () => {
    const settings = getDefaultSettings()
    settings.provider = { llmProvider: 'anthropic', model: 'claude-test' }
    settings.integrations.skills.enabled = false
    settings.integrations.mcp.enabled = true
    settings.integrations.mcp.enableForMainAgent = false
    settings.integrations.mcp.enableForAgents.mousse = true
    settings.integrations.mcp.enabledServers = ['inst-echo']
    const captured: Context[] = []
    const manager = new McpManager(
      {
        discover: async () => ({
          servers: [testServerConfig()],
          sources: [],
          diagnostics: []
        })
      } as never,
      { get: () => settings } as never,
      async () => {},
      { clientFactory: injectedFactory() }
    )
    const models = {
      getModel: (provider: string, id: string) => ({
        id,
        name: id,
        api: 'anthropic-messages',
        provider,
        baseUrl: '',
        reasoning: false,
        input: ['text'],
        cost: emptyCost,
        contextWindow: 128_000,
        maxTokens: 8_000
      }),
      getAuth: async () => ({ apiKey: 'test' }),
      streamSimple: (_model: unknown, context: Context) => {
        captured.push(structuredClone(context))
        return streamOf(response([{ type: 'text', text: 'ok' }], 'stop'))
      }
    }
    const client = new LlmClient(
      { get: () => settings } as never,
      { has: () => true, credentials: { listProviderIds: () => ['anthropic'] }, models } as never,
      manager
    )
    await client.chat([userMessage('hello')], undefined, { mode: 'agent', subagent: true })
    const names = captured[0]?.tools?.map((tool) => tool.name) ?? []
    expect(names.some((name) => name.startsWith('mcp__'))).toBe(true)

    captured.length = 0
    await client.chat([userMessage('hello')], undefined, { mode: 'agent', subagent: false })
    const mainNames = captured[0]?.tools?.map((tool) => tool.name) ?? []
    expect(mainNames.some((name) => name.startsWith('mcp__'))).toBe(false)
  })
})
