import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MousseMainService } from '../src/mms/MousseMainService'
import { ProviderAuthService } from '../src/mms/providers/ProviderAuthService'
import { LocalMmsClient, MmsProtocolServer } from '../src/mms/protocol'
import { AGENT_DEFINITION_CAPABILITY } from '../src/shared/agentPlatform'
import { WORKFLOW_DEFINITIONS_CAPABILITY } from '../src/shared/workflowPlatform'
import { WORKFLOW_RUN_CAPABILITY, type WorkflowRunView } from '../src/shared/workflowRunPlatform'
import type { WorkflowBundle } from '../src/shared/workflows'
import { INTEGRATION_CAPABILITY } from '../src/shared/integrationPlatform'
import { defaultAgentSettings } from '../src/shared/agents/defaults'
import { createAgentDefinitionsClient } from '../src/renderer/services/agentDefinitionsClient'
import { createWorkflowDefinitionsClient } from '../src/renderer/services/workflowDefinitionsClient'
import { createWorkflowExecutionClient } from '../src/renderer/services/workflowExecutionClient'
import { createIntegrationPlatformClient } from '../src/renderer/services/integrationPlatformClient'
import { SharedAgentModelLookup } from '../src/mms/platform/SharedAgentModelLookup'
import { createMcpPayload, draftFromMcp, updateMcpPayload } from '../src/renderer/components/integrations/mcpDraft'

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
      'profiles-v1', AGENT_DEFINITION_CAPABILITY, WORKFLOW_DEFINITIONS_CAPABILITY, WORKFLOW_RUN_CAPABILITY, INTEGRATION_CAPABILITY
    ] })
    clients.push(rpc)
    const hello = await rpc.connect()
    expect(hello.capabilities).toEqual(expect.arrayContaining([AGENT_DEFINITION_CAPABILITY, WORKFLOW_DEFINITIONS_CAPABILITY, WORKFLOW_RUN_CAPABILITY, INTEGRATION_CAPABILITY]))
    await rpc.request('profiles.bind', { profile })
    return { rpc, agents: createAgentDefinitionsClient(rpc), workflows: createWorkflowDefinitionsClient(rpc), runs: createWorkflowExecutionClient(rpc), integrations: createIntegrationPlatformClient(rpc) }
  }
  return { root, homeDir, main, host, alice, bob, connect, close: async () => {
    await Promise.all(clients.map((client) => client.close()))
    await server.stop()
    await main.stop()
  } }
}

describe('production platform composition through framed MMS', () => {
  it('runs pinned code through the app client, binds approvals to the connection, and isolates profile history', async () => {
    const f = await fixture()
    try {
      const a = await f.connect(f.alice.id), b = await f.connect(f.bob.id)
      const bundle: WorkflowBundle = { assets: [{ relativePath: 'scripts/echo.mjs', bytes: new TextEncoder().encode("let input='';for await(const chunk of process.stdin)input+=chunk;console.log(JSON.stringify({pinned:true,input:JSON.parse(input)}))") }], manifest: {
        schemaVersion: 1, id: randomUUID(), name: 'Production execution', slug: 'production-execution', entryNodeId: 'start',
        inputSchema: { type: 'object', properties: { count: { type: 'integer' } }, required: ['count'], additionalProperties: false }, outputSchema: { type: 'object' },
        permissions: { capabilities: ['script.trusted-local'] },
        nodes: [{ id: 'start', type: 'start', version: 1, config: {} },
          { id: 'script', type: 'script', version: 1, inputs: { count: { ref: 'input', pointer: '/count' } }, config: { runtime: 'node', file: 'scripts/echo.mjs', executionMode: 'trusted-local' } },
          { id: 'end', type: 'end', version: 1, config: {}, inputs: { result: { ref: 'node', nodeId: 'script', pointer: '' } } }],
        edges: [{ from: 'start', port: 'next', to: 'script' }, { from: 'script', port: 'success', to: 'end' }]
      } }
      const document = await a.workflows.create({ profileId: f.alice.id, bundle })
      const published = await a.workflows.publish({ profileId: f.alice.id, id: document.id, expectedDraftSemanticHash: document.semanticHash })
      const request = { profileId: f.alice.id, definitionId: document.id, requestId: randomUUID(), input: { count: 7 } }
      const accepted = await a.runs.start(request)
      let waiting: WorkflowRunView = accepted
      await vi.waitFor(async () => { waiting = await a.runs.get({ profileId: f.alice.id, runId: accepted.runId }); expect(waiting.state).toBe('waiting-approval') }, { timeout: 8000 })
      expect(waiting.result).toBeNull()
      expect(await b.runs.list!({ profileId: f.bob.id })).toEqual([])
      await expect(b.runs.get({ profileId: f.bob.id, runId: accepted.runId })).rejects.toMatchObject({ code: 'run_not_found' })
      await expect(b.runs.get({ profileId: f.alice.id, runId: accepted.runId })).rejects.toMatchObject({ code: 'profile_mismatch' })
      const changed = structuredClone(bundle)
      changed.assets[0].bytes = new TextEncoder().encode("throw new Error('changed after admission')")
      const draft = await a.workflows.saveDraft({ profileId: f.alice.id, id: document.id, expectedDraftSemanticHash: document.semanticHash, bundle: changed })
      await a.workflows.publish({ profileId: f.alice.id, id: document.id, expectedDraftSemanticHash: draft.semanticHash, expectedHeadRevisionId: published.head!.revisionId })
      expect((await a.runs.start(request)).runId).toBe(accepted.runId)
      const services = await f.main.getProfileServices(f.alice.id)
      expect(services.threads.listAllThreads()).toHaveLength(1)
      const approval = waiting.pendingApproval!
      await expect(a.runs.approve!({ profileId: f.alice.id, runId: accepted.runId, approvalId: approval.approvalId, nodeId: 'other', instanceKey: approval.instanceKey, attempt: approval.attempt, approved: true })).rejects.toMatchObject({ code: 'stale_approval' })
      // Send the exact public DTO; descriptive fields are display-only.
      await a.runs.approve!({ profileId: f.alice.id, runId: accepted.runId, approvalId: approval.approvalId, nodeId: approval.nodeId, instanceKey: approval.instanceKey, attempt: approval.attempt, approved: true })
      let completed: WorkflowRunView = accepted
      await vi.waitFor(async () => { completed = await a.runs.get({ profileId: f.alice.id, runId: accepted.runId }); expect(completed.state).toBe('succeeded') }, { timeout: 8000 })
      expect(completed.result).toEqual({ pinned: true, input: { count: 7 } })
      expect(completed.revisionId).toBe(published.head!.revisionId)
      expect(completed.origin).toBe('host')
      const decision = services.platform.workflowRuns.approvals.get(approval.approvalId, f.alice.id)!
      expect(decision.decision).toBe('approved')
      expect(decision.decidedBy).toBeTruthy()
      const repeatedPeer = await f.connect(f.alice.id)
      expect((await repeatedPeer.runs.start(request)).runId).toBe(accepted.runId)
      expect((await services.platform.workflowRuns.runtime.get(accepted.runId, { profileId: f.alice.id })).manifest.source).toBe('cli')
    } finally { await f.close() }
  }, 30_000)

  it('accepts renderer MCP edits, preserves omitted secrets and exact argv, clears cwd, and rejects stale revisions', async () => {
    const f = await fixture()
    try {
      const a = await f.connect(f.alice.id)
      const draft = draftFromMcp()
      Object.assign(draft, { name: 'Editor roundtrip', command: 'must-not-spawn-fixture', cwd: f.root, enabled: false,
        args: JSON.stringify(['', ' spaced argument ', '--token=${FIXTURE_ENV}']), replaceEnv: true,
        env: JSON.stringify({ FIXTURE_ENV: 'fixture-secret-never-log' }), replaceHeaders: true,
        headers: JSON.stringify({ 'X-Fixture': 'fixture-header' }), clientSecret: 'fixture-client-secret' })
      const identity = { profileId: f.alice.id }
      const created = await a.integrations.createMcp(createMcpPayload(draft, identity, 'global'))
      const edit = draftFromMcp(created.server)
      edit.name = 'Renamed connection'; edit.cwd = ''
      const payload = updateMcpPayload(edit, identity, created.installationId, created.revision)
      expect(payload).not.toHaveProperty('scope')
      for (const key of ['env', 'headers', 'auth']) expect(payload).not.toHaveProperty(key)
      const updated = await a.integrations.updateMcp(payload)
      expect(updated.server.args).toEqual(['', ' spaced argument ', '--token=${FIXTURE_ENV}'])
      expect(updated.server.cwd ?? '').toBe('')
      await expect(a.integrations.updateMcp(payload)).rejects.toMatchObject({ code: 'revision_conflict' })
      const services = await f.main.getProfileServices(f.alice.id)
      const raw = await services.mcpRegistry.discover({ redactSecrets: false })
      const actual = raw.servers.find((item) => item.installationId === created.installationId)!
      expect(actual.env).toEqual({ FIXTURE_ENV: 'fixture-secret-never-log' })
      expect(actual.headers).toEqual({ 'X-Fixture': 'fixture-header' })
      expect(actual.auth?.clientSecret).toBe('fixture-client-secret')
      expect(JSON.stringify(updated)).not.toContain('fixture-secret-never-log')
    } finally { await f.close() }
  }, 30_000)
  it('cancels only the departing connection auth attempt on rebind/close and cancels remaining attempts on profile disposal', async () => {
    const f = await fixture()
    try {
      const a = await f.connect(f.alice.id), peer = await f.connect(f.alice.id)
      const services = await f.main.getProfileServices(f.alice.id)
      const signals: AbortSignal[] = []
      vi.spyOn(services.mcpManager, 'authenticateServer').mockImplementation(async (_id, _projectPath, signal) => {
        if (!signal) throw new Error('Missing auth cancellation signal')
        signals.push(signal)
        return await new Promise((resolve) => {
          const done = () => resolve({ success: false, error: 'Cancelled', errorCategory: 'cancelled' })
          if (signal.aborted) done()
          else signal.addEventListener('abort', done, { once: true })
        })
      })
      const one = a.integrations.beginMcpAuth({ profileId: f.alice.id, installationId: 'fixture-one' }).catch((error: unknown) => error)
      const two = peer.integrations.beginMcpAuth({ profileId: f.alice.id, installationId: 'fixture-two' }).catch((error: unknown) => error)
      await vi.waitFor(() => expect(signals).toHaveLength(2))
      await a.rpc.request('profiles.bind', { profile: f.bob.id })
      await vi.waitFor(() => expect(signals.filter((signal) => signal.aborted)).toHaveLength(1))
      await one
      await peer.rpc.close()
      await vi.waitFor(() => expect(signals.every((signal) => signal.aborted)).toBe(true))
      await two
      const remaining = await f.connect(f.alice.id)
      const three = remaining.integrations.beginMcpAuth({ profileId: f.alice.id, installationId: 'fixture-three' }).catch((error: unknown) => error)
      await vi.waitFor(() => expect(signals).toHaveLength(3))
      await f.host.disposeProfile(f.alice.id)
      await vi.waitFor(() => expect(signals[2].aborted).toBe(true))
      await three
    } finally { await f.close() }
  }, 30_000)

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
