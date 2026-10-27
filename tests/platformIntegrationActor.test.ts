import { describe, expect, it } from 'vitest'
import { getDefaultSettings } from '../src/shared/settings'
import { defaultIntegrationActor } from '../src/shared/integrations/actor'
import { resolveEffectiveSkills } from '../src/mms/integrations/catalog/EffectiveIntegrationResolver'
import type { SkillsRegistrySnapshot } from '../src/shared/integrations'
import { McpManager } from '../src/mms/integrations/mcp/McpManager'
import { injectedFactory, settingsStore, testServerConfig } from './fixtures/agent-platform/integrations/helpers'

describe('I01 actor grants and MCP gating', () => {
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
    settings.integrations.mcp.enabled = true
    settings.integrations.mcp.enableForMainAgent = false
    settings.integrations.mcp.enableForAgents.mousse = true
    settings.integrations.mcp.enabledServers = ['inst-echo']
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
    const child = await manager.getEnabledTools(undefined, 'mousse')
    expect(child.some((tool) => tool.providerName.startsWith('mcp__'))).toBe(true)
    const main = await manager.getEnabledTools(undefined, 'main')
    expect(main.some((tool) => tool.providerName.startsWith('mcp__'))).toBe(false)
  })
})
