import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MousseMainService } from '../src/mms/MousseMainService'
import { ProviderAuthService } from '../src/mms/providers/ProviderAuthService'
import { LocalMmsClient, MmsProtocolServer } from '../src/mms/protocol'
import { AGENT_DEFINITION_CAPABILITY } from '../src/shared/agentPlatform'
import { WORKFLOW_DEFINITIONS_CAPABILITY } from '../src/shared/workflowPlatform'
import { INTEGRATION_CAPABILITY } from '../src/shared/integrationPlatform'
import { defaultAgentSettings } from '../src/shared/agents/defaults'
import { createAgentDefinitionsClient } from '../src/renderer/services/agentDefinitionsClient'
import { createWorkflowDefinitionsClient } from '../src/renderer/services/workflowDefinitionsClient'
import { createIntegrationPlatformClient } from '../src/renderer/services/integrationPlatformClient'
import { SharedAgentModelLookup } from '../src/mms/platform/SharedAgentModelLookup'

const roots: string[] = []
const previousHome = process.env.MOUSSE_HOME
afterEach(() => {
  vi.restoreAllMocks()
  if (previousHome === undefined) delete process.env.MOUSSE_HOME
  else process.env.MOUSSE_HOME = previousHome
  for (const root of roots.splice(0)) {
    const path = relative(realpathSync(tmpdir()), realpathSync(root))
    if (isAbsolute(path) || !path.startsWith('mousse-platform-host-') || path.includes('..')) throw new Error('Unexpected fixture root')
    rmSync(root, { recursive: true, force: true })
  }
})

async function fixture() {
  // Keep the real provider registry and shared credential store, without live
  // provider catalog refresh or model calls during a local persistence test.
  vi.spyOn(ProviderAuthService.prototype, 'init').mockResolvedValue(undefined)
  const root = mkdtempSync(join(tmpdir(), 'mousse-platform-host-')); roots.push(root)
  const homeDir = join(root, 'home')
  const main = await MousseMainService.create({ homeDir, repoRoot: root, requireOwnership: false, headless: true })
  const host = main.getInstallationHost()!
  const alice = host.manager.create({ displayName: 'Alice', slug: 'alice' })
  const bob = host.manager.create({ displayName: 'Bob', slug: 'bob' })
  const server = new MmsProtocolServer({ mms: main, ownerToken: 'fixture-owner' })
  const endpoint = await server.start()
  const clients: LocalMmsClient[] = []
  const connect = async (profile: string) => {
    const rpc = new LocalMmsClient({ homeDir, endpoint, ownerToken: 'fixture-owner', requestedCapabilities: [
      'profiles-v1', AGENT_DEFINITION_CAPABILITY, WORKFLOW_DEFINITIONS_CAPABILITY, INTEGRATION_CAPABILITY
    ] })
    clients.push(rpc)
    const hello = await rpc.connect()
    expect(hello.capabilities).toEqual(expect.arrayContaining([AGENT_DEFINITION_CAPABILITY, WORKFLOW_DEFINITIONS_CAPABILITY, INTEGRATION_CAPABILITY]))
    await rpc.request('profiles.bind', { profile })
    return { rpc, agents: createAgentDefinitionsClient(rpc), workflows: createWorkflowDefinitionsClient(rpc), integrations: createIntegrationPlatformClient(rpc) }
  }
  return { root, homeDir, main, host, alice, bob, connect, close: async () => {
    await Promise.all(clients.map((client) => client.close()))
    await server.stop()
    await main.stop()
  } }
}

describe('production platform composition through framed MMS', () => {
  it('registers editor domains, isolates personal definitions and integrations, and reloads their durable data', async () => {
    const f = await fixture()
    let agentId = '', workflowId = '', skillId = '', mcpId = ''
    try {
      const a = await f.connect(f.alice.id), b = await f.connect(f.bob.id)
      const settings = defaultAgentSettings({ name: 'Alice agent', slug: 'alice-agent' })
      const agent = await a.agents.create({ profileId: f.alice.id, settings, systemPrompt: 'Alice private instructions' })
      agentId = agent.id
      const workflow = await a.workflows.create({ profileId: f.alice.id, name: 'Alice workflow', slug: 'alice-workflow' })
      workflowId = workflow.id
      const skill = await a.integrations.createSkill({ profileId: f.alice.id, scope: 'global', name: 'alice-skill', description: 'Alice private skill', instructions: 'Private skill instructions', enable: false })
      skillId = skill.installationId
      const mcp = await a.integrations.createMcp({ profileId: f.alice.id, scope: 'global', name: 'Alice connection', transport: 'stdio', command: 'must-not-spawn-fixture', args: [], enable: false })
      mcpId = mcp.installationId
      expect(await b.agents.list({ profileId: f.bob.id })).toEqual([])
      expect(await b.workflows.list({ profileId: f.bob.id })).toEqual([])
      const snapshot = await b.integrations.snapshot({ profileId: f.bob.id })
      expect(snapshot.skills.skills.some((entry) => entry.installationId === skillId)).toBe(false)
      expect(snapshot.mcp.servers.some((entry) => entry.installationId === mcpId)).toBe(false)
      await expect(b.agents.get({ profileId: f.bob.id, id: agent.id })).rejects.toMatchObject({ code: 'AGENT_NOT_FOUND' })
      await expect(b.workflows.get({ profileId: f.alice.id, id: workflow.id })).rejects.toMatchObject({ code: 'profile_mismatch' })
      await expect(b.integrations.skillEditor({ profileId: f.bob.id, installationId: skillId })).rejects.toThrow()
      const aliceServices = await f.main.getProfileServices(f.alice.id), bobServices = await f.main.getProfileServices(f.bob.id)
      expect(aliceServices.providerAuth).toBe(bobServices.providerAuth)
      expect(aliceServices.platform).not.toBe(bobServices.platform)
    } finally { await f.close() }
    const reloaded = await MousseMainService.create({ homeDir: f.homeDir, repoRoot: f.root, requireOwnership: false, headless: true })
    try {
      const alice = await reloaded.getProfileServices(f.alice.id)
      expect(alice.platform.agentDefinitions.get(agentId).systemPrompt).toBe('Alice private instructions')
      expect(alice.platform.workflowDefinitions.get(workflowId).compiled.slug).toBe('alice-workflow')
      expect((await alice.platform.integrations.skillsSnapshot()).skills.some((entry) => entry.installationId === skillId)).toBe(true)
      expect((await alice.platform.integrations.mcpSnapshot()).servers.some((entry) => entry.installationId === mcpId)).toBe(true)
    } finally { await reloaded.stop() }
  }, 30_000)

  it('validates using the live shared model catalog and resolves current per-runtime integration gates', async () => {
    const f = await fixture()
    try {
      const services = await f.main.getProfileServices(f.alice.id)
      const client = await f.connect(f.alice.id)
      const provider = services.providerAuth.models.getProviders().find((entry) => services.providerAuth.models.getModels(entry.id).length > 0)!
      const model = services.providerAuth.models.getModels(provider.id)[0]
      const settings = defaultAgentSettings({ name: 'Catalog agent', slug: 'catalog-agent' })
      settings.primaryModel.ref = { providerId: provider.id, modelId: model.id }
      const created = await client.agents.create({ profileId: f.alice.id, settings, systemPrompt: 'System instructions' })
      expect((await client.agents.validate({ profileId: f.alice.id, id: created.id, expectedDraftHash: created.draftHash })).issues).toEqual([])
      const skill = await client.integrations.createSkill({ profileId: f.alice.id, scope: 'global', name: 'selected-skill', description: 'Selected skill', enable: true })
      const integrations = services.settings.get().integrations
      services.settings.set({ integrations: {
        ...integrations,
        skills: { ...integrations.skills, enabled: true, enableForAgents: { ...integrations.skills.enableForAgents, mousse: true, codex: false }, enabledSkills: [skill.installationId] },
        tools: { enabled: true, enabledTools: ['read', 'mousse_gui_evaluate', 'unknown-tool'] }
      } })
      const native = await services.platform.integrationLookup('mousse')
      const cli = await services.platform.integrationLookup('codex')
      expect(native.listProfileSkillIds()).toContain(skill.installationId)
      expect(cli.listProfileSkillIds()).toEqual([])
      expect(native.listProfileBuiltinToolIds()).toEqual(['read'])
      const pinned = await client.agents.publish({ profileId: f.alice.id, id: created.id, expectedDraftHash: created.draftHash })
      expect(pinned.revision).toBe(created.semanticHash)
      const lookup = new SharedAgentModelLookup(services.providerAuth)
      expect(lookup.resolve({ providerId: provider.id, modelId: 'absent-fixture-model' })).toBeNull()
      expect(lookup.resolve(settings.primaryModel.ref)?.capabilities).not.toContain('browser_native')
      const current = services.settings.get().integrations
      services.settings.set({ integrations: { ...current, tools: { ...current.tools, enabled: false } } })
      expect((await services.platform.integrationLookup('mousse')).listProfileBuiltinToolIds()).toEqual([])
      await services.stop()
      await expect(services.platform.agentDomain('agentDefinitions.list', {})).rejects.toMatchObject({ code: 'profile_unavailable' })
    } finally { await f.close() }
  }, 30_000)
})
