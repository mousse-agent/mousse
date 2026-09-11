import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MousseMainService } from '../src/mms/MousseMainService'
import { ProviderAuthService } from '../src/mms/providers/ProviderAuthService'
import { LocalMmsClient, MmsProtocolServer } from '../src/mms/protocol'
import { WORKFLOW_DEFINITIONS_CAPABILITY } from '../src/shared/workflowPlatform'
import { WORKFLOW_RUN_CAPABILITY, type WorkflowRunView } from '../src/shared/workflowRunPlatform'
import { INTEGRATION_CAPABILITY } from '../src/shared/integrationPlatform'
import { createWorkflowDefinitionsClient } from '../src/renderer/services/workflowDefinitionsClient'
import { createWorkflowExecutionClient } from '../src/renderer/services/workflowExecutionClient'
import { createIntegrationPlatformClient } from '../src/renderer/services/integrationPlatformClient'
import type { WorkflowBundle } from '../src/shared/workflows'

const roots: string[] = []
const previousHome = process.env.MOUSSE_HOME
afterEach(() => {
  vi.restoreAllMocks()
  if (previousHome === undefined) delete process.env.MOUSSE_HOME
  else process.env.MOUSSE_HOME = previousHome
  for (const root of roots.splice(0)) {
    const path = relative(realpathSync(tmpdir()), realpathSync(root))
    if (isAbsolute(path) || !path.startsWith('mousse-workflow-integrations-') || path.includes('..')) throw new Error('Unexpected fixture root')
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

async function fixture() {
  vi.spyOn(ProviderAuthService.prototype, 'init').mockResolvedValue(undefined)
  const root = mkdtempSync(join(tmpdir(), 'mousse-workflow-integrations-')); roots.push(root)
  const homeDir = join(root, 'home'), callLog = join(root, 'mcp-calls.jsonl'), eventLog = join(root, 'mcp-events.jsonl')
  let main = await MousseMainService.create({ homeDir, repoRoot: root, requireOwnership: false, headless: true })
  const host = main.getInstallationHost()!
  const alice = host.manager.create({ displayName: 'Alice', slug: 'alice' })
  const bob = host.manager.create({ displayName: 'Bob', slug: 'bob' })
  let server: MmsProtocolServer | undefined
  const clients: LocalMmsClient[] = []
  const startServer = async () => {
    server = new MmsProtocolServer({ mms: main, ownerToken: 'fixture-owner' })
    return server.start()
  }
  let endpoint = await startServer()
  const close = async () => {
    await Promise.all(clients.splice(0).map((client) => client.close()))
    await server?.stop(); server = undefined
    await main.stop()
  }
  const connect = async (profileId = alice.id) => {
    const rpc = new LocalMmsClient({ homeDir, endpoint, ownerToken: 'fixture-owner', requestedCapabilities: ['profiles-v1', WORKFLOW_DEFINITIONS_CAPABILITY, WORKFLOW_RUN_CAPABILITY, INTEGRATION_CAPABILITY] })
    clients.push(rpc); await rpc.connect(); await rpc.request('profiles.bind', { profile: profileId })
    return { rpc, workflows: createWorkflowDefinitionsClient(rpc), runs: createWorkflowExecutionClient(rpc), integrations: createIntegrationPlatformClient(rpc) }
  }
  return {
    root, homeDir, callLog, eventLog, alice, bob, connect, close,
    services: (profileId = alice.id) => main.getProfileServices(profileId),
    restart: async () => { await close(); main = await MousseMainService.create({ homeDir, repoRoot: root, requireOwnership: false, headless: true }); endpoint = await startServer() },
    calls: () => existsSync(callLog) ? readFileSync(callLog, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []
  }
}
type Fixture = Awaited<ReturnType<typeof fixture>>
type Client = Awaited<ReturnType<Fixture['connect']>>

async function install(f: Fixture, client: Client) {
  const profileId = f.alice.id
  const skill = await client.integrations.createSkill({ profileId, scope: 'global', name: 'workflow-guide', description: 'Pinned fixture Skill', instructions: 'Original pinned instructions.', enable: true })
  const mcp = await client.integrations.createMcp({ profileId, scope: 'global', name: 'Workflow fixture', transport: 'stdio', command: process.execPath,
    args: [resolve('tests/fixtures/agent-platform/integrations/mcp-fixture-server.mjs')], env: { MCP_FIXTURE_CALL_LOG: f.callLog, MCP_FIXTURE_EVENT_LOG: f.eventLog }, enable: true })
  const services = await f.services(), integrations = services.settings.get().integrations
  services.settings.set({ integrations: { ...integrations,
    skills: { ...integrations.skills, enabled: true, enabledSkills: [skill.installationId], enableForAgents: { ...integrations.skills.enableForAgents, mousse: true } },
    mcp: { ...integrations.mcp, enabled: true, enabledServers: [mcp.installationId], enableForAgents: { ...integrations.mcp.enableForAgents, mousse: true } }
  } })
  return { skill, mcp }
}

async function publish(f: Fixture, client: Client, ids: Awaited<ReturnType<typeof install>>, options: { skillRevision?: string; text?: unknown; tool?: string } = {}) {
  const bundle: WorkflowBundle = { assets: [], manifest: {
    schemaVersion: 1, id: randomUUID(), name: 'Integration workflow', slug: 'integration-' + randomUUID().slice(0, 8), enabled: true,
    entryNodeId: 'start', inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, permissions: { capabilities: ['human.approval', 'skill.load', 'mcp.invoke'] },
    nodes: [
      { id: 'start', type: 'start', version: 1, config: {} },
      { id: 'approval', type: 'approval', version: 1, config: { action: 'Run the integration fixture' } },
      { id: 'denied', type: 'end', version: 1, config: {} },
      { id: 'skill', type: 'load-skill', version: 1, config: { skill: { id: ids.skill.installationId, ...(options.skillRevision ? { revision: options.skillRevision } : {}) } } },
      { id: 'mcp', type: 'mcp-tool', version: 1, config: { serverId: ids.mcp.installationId, toolName: options.tool ?? 'echo' },
        inputs: { text: options.text === undefined ? { ref: 'node', nodeId: 'skill', pointer: '/instructions' } : { literal: options.text } } },
      { id: 'end', type: 'end', version: 1, config: {}, inputs: { result: { ref: 'node', nodeId: 'mcp', pointer: '' } } }
    ], edges: [ { from: 'start', port: 'next', to: 'approval' }, { from: 'approval', port: 'denied', to: 'denied' }, { from: 'approval', port: 'approved', to: 'skill' }, { from: 'skill', port: 'success', to: 'mcp' }, { from: 'mcp', port: 'success', to: 'end' } ]
  } }
  const created = await client.workflows.create({ profileId: f.alice.id, bundle })
  await client.workflows.publish({ profileId: f.alice.id, id: created.id, expectedDraftSemanticHash: created.semanticHash })
  return { profileId: f.alice.id, definitionId: created.id, requestId: randomUUID(), input: {} }
}

async function waitFor(client: Client, profileId: string, runId: string, check: (view: WorkflowRunView) => void): Promise<WorkflowRunView> {
  let view!: WorkflowRunView
  await vi.waitFor(async () => { view = await client.runs.get({ profileId, runId }); check(view) }, { timeout: 8000, interval: 30 })
  return view
}
async function approve(client: Client, profileId: string, runId: string, nodeId: string) {
  const view = await waitFor(client, profileId, runId, (view) => { expect(view.state).toBe('waiting-approval'); expect(view.pendingApproval?.nodeId).toBe(nodeId) })
  const approval = view.pendingApproval!
  return client.runs.approve!({ profileId, runId, approvalId: approval.approvalId, nodeId, instanceKey: approval.instanceKey, attempt: approval.attempt, approved: true })
}

describe('production workflow Skill and MCP execution through framed MMS', () => {
  it('executes an admitted built-in project tool and honors live Settings revocation', async () => {
    const f = await fixture()
    try {
      const a = await f.connect(), services = await f.services()
      const projectPath = join(f.root, 'project-tool-workspace')
      const { mkdirSync, writeFileSync } = await import('node:fs')
      mkdirSync(projectPath)
      writeFileSync(join(projectPath, 'owned.txt'), 'profile-owned workflow bytes')
      const project = services.projects.openProject(projectPath)
      const settings = services.settings.get().integrations
      services.settings.set({ integrations: { ...settings, tools: { enabled: true, enabledTools: ['read'] } } })
      const bundle: WorkflowBundle = { assets: [], manifest: {
        schemaVersion: 1, id: randomUUID(), name: 'Built-in tool workflow', slug: 'builtin-' + randomUUID().slice(0, 8), enabled: true,
        entryNodeId: 'start', inputSchema: { type: 'object' }, outputSchema: {}, permissions: { capabilities: ['tool.invoke'] },
        nodes: [
          { id: 'start', type: 'start', version: 1, config: {} },
          { id: 'read', type: 'tool', version: 1, config: { tool: { id: 'read' } }, inputs: { path: { literal: 'owned.txt' } } },
          { id: 'end', type: 'end', version: 1, config: {}, inputs: { result: { ref: 'node', nodeId: 'read', pointer: '' } } }
        ],
        edges: [{ from: 'start', port: 'next', to: 'read' }, { from: 'read', port: 'success', to: 'end' }]
      } }
      const created = await a.workflows.create({ profileId: f.alice.id, bundle })
      await a.workflows.publish({ profileId: f.alice.id, id: created.id, expectedDraftSemanticHash: created.semanticHash })
      const request = { profileId: f.alice.id, projectId: project.id, definitionId: created.id, requestId: randomUUID(), input: {} }
      const started = await a.runs.start(request)
      await approve(a, f.alice.id, started.runId, 'read')
      const done = await waitFor(a, f.alice.id, started.runId, (view) => expect(view.state, view.error).toBe('succeeded'))
      expect(done.result).toContain('profile-owned workflow bytes')

      const changed = services.settings.get().integrations
      services.settings.set({ integrations: { ...changed, tools: { enabled: true, enabledTools: [] } } })
      await expect(a.runs.start({ ...request, requestId: randomUUID() })).rejects.toMatchObject({ code: 'capability_denied' })
      await expect(services.platform.workflowRuns.runtime.list({ profileId: f.alice.id })).resolves.toHaveLength(1)
    } finally { await f.close() }
  }, 25_000)

  it('rejects caller-supplied execution bindings and forged or inactive integration contexts', async () => {
    const f = await fixture()
    try {
      const a = await f.connect(), ids = await install(f, a), request = await publish(f, a, ids)
      await expect(a.rpc.request('workflowRuns.start', { ...request, executionBindings: { version: 1, profileId: f.alice.id, skills: [], mcpTools: [] } })).rejects.toMatchObject({ code: 'unknown_field' })
      const run = await a.runs.start(request)
      await waitFor(a, f.alice.id, run.runId, (view) => expect(view.state).toBe('waiting-approval'))
      const services = await f.services(), { manifest } = await services.platform.workflowRuns.runtime.get(run.runId, { profileId: f.alice.id })
      const context = { profileId: manifest.profileId, projectId: manifest.projectId, threadId: manifest.threadId, turnId: manifest.runId, runId: manifest.runId, actor: manifest.actor, source: manifest.source, policySnapshotId: manifest.policySnapshotId, cancellationId: manifest.cancellationId }
      const loader = services.platform.workflowIntegrations.skill
      await expect(loader.load({ context: { ...context, threadId: randomUUID() }, skillId: ids.skill.installationId })).rejects.toMatchObject({ code: 'thread_unavailable' })
      await expect(loader.load({ context: { ...context, turnId: randomUUID() }, skillId: ids.skill.installationId })).rejects.toMatchObject({ code: 'profile_mismatch' })
      await expect(loader.load({ context, skillId: ids.skill.installationId })).rejects.toMatchObject({ code: 'capability_denied' })
      expect(f.calls()).toEqual([])
    } finally { await f.close() }
  }, 20_000)

  it('revalidates a pinned MCP grant after asynchronous execution setup and before transport dispatch', async () => {
    const f = await fixture()
    try {
      const a = await f.connect(), ids = await install(f, a), services = await f.services()
      const actor = { kind: 'workflow' as const, agentType: 'mousse' as const, mcpServerIds: [ids.mcp.installationId], mcpToolIds: [ids.mcp.installationId + '/echo'] }
      const tool = (await services.mcpManager.getEnabledTools(undefined, actor)).find((tool) => tool.toolName === 'echo')!
      await expect(services.mcpManager.callTool(tool.providerName, { text: 'Must not dispatch' }, undefined, undefined, actor, {
        installationId: ids.mcp.installationId, toolName: 'echo', configRevision: tool.configRevision!, requireProfileSelection: true,
        assertExecutionActive: async () => {
          const settings = services.settings.get().integrations
          services.settings.set({ integrations: { ...settings, mcp: { ...settings.mcp, enabledServers: [] } } })
        }
      })).rejects.toMatchObject({ code: 'stale_revision' })
      expect(f.calls()).toEqual([])
    } finally { await f.close() }
  }, 20_000)

  it('starts only the MCP installation referenced by the admitted workflow', async () => {
    const f = await fixture()
    try {
      const a = await f.connect(), ids = await install(f, a)
      const unrelatedStartLog = join(f.root, 'unrelated-mcp-starts.jsonl')
      const unrelated = await a.integrations.createMcp({
        profileId: f.alice.id,
        scope: 'global',
        name: 'Unrelated workflow fixture',
        transport: 'stdio',
        command: process.execPath,
        args: [resolve('tests/fixtures/agent-platform/integrations/mcp-fixture-server.mjs')],
        env: { MCP_FIXTURE_START_LOG: unrelatedStartLog },
        enable: true
      })
      const services = await f.services()
      const integrations = services.settings.get().integrations
      services.settings.set({ integrations: {
        ...integrations,
        mcp: {
          ...integrations.mcp,
          enabled: true,
          enabledServers: [ids.mcp.installationId, unrelated.installationId],
          enableForAgents: { ...integrations.mcp.enableForAgents, mousse: true }
        }
      } })

      const request = await publish(f, a, ids)
      const run = await a.runs.start(request)
      await waitFor(a, f.alice.id, run.runId, (view) => expect(view.state).toBe('waiting-approval'))
      expect(existsSync(unrelatedStartLog)).toBe(false)
      expect(f.calls()).toEqual([])
    } finally { await f.close() }
  }, 20_000)

  it('cancels an in-flight stdio MCP call through the public run control without replaying its effect', async () => {
    const f = await fixture()
    try {
      const a = await f.connect(), ids = await install(f, a), request = await publish(f, a, ids, { tool: 'hang' })
      const run = await a.runs.start(request)
      await approve(a, f.alice.id, run.runId, 'approval'); await approve(a, f.alice.id, run.runId, 'mcp')
      await vi.waitFor(() => expect(f.calls()).toHaveLength(1), { timeout: 6000 })
      await a.runs.cancel!({ profileId: f.alice.id, runId: run.runId })
      await waitFor(a, f.alice.id, run.runId, (view) => expect(view.state).toBe('cancelled'))
      await vi.waitFor(() => expect(existsSync(f.eventLog) ? readFileSync(f.eventLog, 'utf8') : '').toContain('cancelled'), { timeout: 3000 })
      expect((await a.runs.start(request)).state).toBe('cancelled')
      expect(f.calls()).toHaveLength(1)
    } finally { await f.close() }
  }, 25_000)

  it('pins Skill bytes across host restart and an edit, executes real stdio MCP once, and isolates profiles', async () => {
    const f = await fixture()
    try {
      let a = await f.connect()
      const ids = await install(f, a), request = await publish(f, a, ids)
      const run = await a.runs.start(request)
      await waitFor(a, f.alice.id, run.runId, (view) => expect(view.state).toBe('waiting-approval'))
      await a.integrations.updateSkill({ profileId: f.alice.id, installationId: ids.skill.installationId, expectedRevision: ids.skill.revision, content: '---\nname: workflow-guide\ndescription: Changed fixture\n---\nChanged after admission.' })
      expect(f.calls()).toEqual([])
      await f.restart(); a = await f.connect()
      expect((await a.runs.start(request)).runId).toBe(run.runId)
      await approve(a, f.alice.id, run.runId, 'approval')
      await approve(a, f.alice.id, run.runId, 'mcp')
      const done = await waitFor(a, f.alice.id, run.runId, (view) => expect(view.state, view.error).toBe('succeeded'))
      expect(done.result).toMatchObject({ structuredContent: { echoed: expect.stringContaining('Original pinned instructions.') }, provenance: { profileId: f.alice.id, installationId: ids.mcp.installationId, toolName: 'echo' } })
      expect(JSON.stringify(done.result)).not.toContain('Changed after admission')
      expect(f.calls()).toHaveLength(1)
      expect((await a.runs.start(request)).runId).toBe(run.runId)
      expect(f.calls()).toHaveLength(1)
      const b = await f.connect(f.bob.id)
      await expect(b.runs.get({ profileId: f.bob.id, runId: run.runId })).rejects.toMatchObject({ code: 'run_not_found' })
      expect(await b.runs.list!({ profileId: f.bob.id })).toEqual([])
    } finally { await f.close() }
  }, 30_000)

  it.each(['skill-disabled', 'skill-unselected', 'mcp-reconfigured', 'mcp-unselected'] as const)('rejects %s after admission without invoking a tool', async (mutation) => {
    const f = await fixture()
    try {
      const a = await f.connect(), ids = await install(f, a), request = await publish(f, a, ids)
      const run = await a.runs.start(request)
      await waitFor(a, f.alice.id, run.runId, (view) => expect(view.state).toBe('waiting-approval'))
      const services = await f.services(), settings = services.settings.get().integrations
      if (mutation === 'skill-disabled') await a.integrations.enableSkill({ profileId: f.alice.id, installationId: ids.skill.installationId, enabled: false })
      if (mutation === 'skill-unselected') services.settings.set({ integrations: { ...settings, skills: { ...settings.skills, enabledSkills: [] } } })
      if (mutation === 'mcp-unselected') services.settings.set({ integrations: { ...settings, mcp: { ...settings.mcp, enabledServers: [] } } })
      if (mutation === 'mcp-reconfigured') await a.integrations.updateMcp({ profileId: f.alice.id, installationId: ids.mcp.installationId, expectedRevision: ids.mcp.revision, args: [resolve('tests/fixtures/agent-platform/integrations/mcp-fixture-server.mjs'), '--changed'] })
      await approve(a, f.alice.id, run.runId, 'approval')
      if (mutation.startsWith('mcp-')) await approve(a, f.alice.id, run.runId, 'mcp')
      const done = await waitFor(a, f.alice.id, run.runId, (view) => expect(['failed', 'unknown-effect']).toContain(view.state))
      expect(done.state).not.toBe('succeeded')
      expect(f.calls()).toEqual([])
    } finally { await f.close() }
  }, 25_000)

  it('validates admitted MCP arguments before dispatch and preserves an explicit historical Skill revision', async () => {
    const f = await fixture()
    try {
      const a = await f.connect(), ids = await install(f, a)
      await a.integrations.updateSkill({ profileId: f.alice.id, installationId: ids.skill.installationId, expectedRevision: ids.skill.revision, content: '---\nname: workflow-guide\ndescription: Changed fixture\n---\nChanged.' })
      const request = await publish(f, a, ids, { skillRevision: ids.skill.skill.contentHash, text: 42 })
      const run = await a.runs.start(request)
      await approve(a, f.alice.id, run.runId, 'approval'); await approve(a, f.alice.id, run.runId, 'mcp')
      await waitFor(a, f.alice.id, run.runId, (view) => expect(['failed', 'unknown-effect']).toContain(view.state))
      const snapshot = await (await f.services()).platform.workflowRuns.runtime.get(run.runId, { profileId: f.alice.id })
      expect(snapshot.outputs.skill).toMatchObject({ instructions: expect.stringContaining('Original pinned instructions.') })
      expect(f.calls()).toEqual([])
    } finally { await f.close() }
  }, 25_000)
})
