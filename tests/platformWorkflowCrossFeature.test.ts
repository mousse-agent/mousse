import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { MousseMainService } from '../src/mms/MousseMainService'
import { ProviderAuthService } from '../src/mms/providers/ProviderAuthService'
import { LocalMmsClient, MmsProtocolServer } from '../src/mms/protocol'
import { FileArtifactStore } from '../src/mms/execution/ArtifactStore'
import { defaultAgentSettings } from '../src/shared/agents/defaults'
import { WORKFLOW_DEFINITIONS_CAPABILITY } from '../src/shared/workflowPlatform'
import { WORKFLOW_RUN_CAPABILITY, type WorkflowRunView } from '../src/shared/workflowRunPlatform'
import type { WorkflowBundle, WorkflowGraph } from '../src/shared/workflows'
import { createWorkflowDefinitionsClient } from '../src/renderer/services/workflowDefinitionsClient'
import { createWorkflowExecutionClient } from '../src/renderer/services/workflowExecutionClient'
import { providerResponse, streamOf } from './fixtures/agent-platform/agent-runtime-policy/helpers'

const roots: string[] = []
const previousHome = process.env.MOUSSE_HOME
afterEach(() => {
  vi.restoreAllMocks()
  if (previousHome === undefined) delete process.env.MOUSSE_HOME
  else process.env.MOUSSE_HOME = previousHome
  for (const root of roots.splice(0)) {
    const rel = relative(realpathSync(tmpdir()), realpathSync(root))
    if (isAbsolute(rel) || !rel.startsWith('mousse-cross-feature-') || rel.includes('..')) throw new Error('Unexpected fixture root')
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

it('E2E04 executes script, condition, isolated mutating Agents, deterministic join and durable artifact through MMS', async () => {
  vi.spyOn(ProviderAuthService.prototype, 'init').mockResolvedValue(undefined)
  const root = mkdtempSync(join(tmpdir(), 'mousse-cross-feature-')); roots.push(root)
  const repo = join(root, 'repo'), homeDir = join(root, 'home')
  process.env.MOUSSE_HOME = homeDir
  mkdirSync(repo)
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true }).trim()
  git('init'); git('config', 'user.name', 'Mousse Fixture'); git('config', 'user.email', 'fixture@example.invalid')
  const sentinel = 'workspace-sentinel-' + randomUUID()
  writeFileSync(join(repo, 'sentinel.txt'), sentinel)
  git('add', 'sentinel.txt'); git('commit', '-m', 'Fixture baseline')
  const originalHead = git('rev-parse', 'HEAD'), originalBranch = git('branch', '--show-current')
  const main = await MousseMainService.create({ homeDir, repoRoot: repo, requireOwnership: false, headless: true })
  const server = new MmsProtocolServer({ mms: main, ownerToken: 'cross-feature-owner' })
  let rpc: LocalMmsClient | undefined
  try {
    const alice = main.getInstallationHost()!.manager.create({ displayName: 'Alice', slug: 'alice' })
    const services = await main.getProfileServices(alice.id)
    const provider = services.providerAuth.models.getProviders().find((entry) => services.providerAuth.models.getModels(entry.id).length > 0)!
    const model = services.providerAuth.models.getModels(provider.id)[0]
    vi.spyOn(services.providerAuth, 'has').mockReturnValue(true)
    vi.spyOn(services.providerAuth.models, 'getAuth').mockResolvedValue({ apiKey: 'fixture' } as never)
    const calls: Record<string, string[]> = { a: [], z: [] }
    vi.spyOn(services.providerAuth.models, 'streamSimple').mockImplementation((_model, context) => {
      const system = context.systemPrompt ?? ''
      const id = system.includes('BRANCH_A_ONLY') ? 'a' : system.includes('BRANCH_Z_ONLY') ? 'z' : undefined
      if (!id) throw new Error('Unrecognized published Agent prompt')
      expect(system).not.toContain(id === 'a' ? 'BRANCH_Z_ONLY' : 'BRANCH_A_ONLY')
      const serialized = JSON.stringify(context)
      expect(serialized).toContain(sentinel)
      calls[id].push(serialized)
      // Only model I/O is scripted. Native tool dispatch must perform the write.
      return streamOf(calls[id].length === 1
        ? providerResponse([{ type: 'toolCall', id: 'write-' + id, name: 'write', arguments: { path: 'branch-output.txt', content: 'branch-' + id } }], 'toolUse')
        : providerResponse([{ type: 'text', text: JSON.stringify({ branch: id, sentinel }) }], 'stop')) as never
    })
    const current = services.settings.get().integrations
    services.settings.set({ provider: { llmProvider: provider.id, model: model.id }, integrations: { ...current, tools: { enabled: true, enabledTools: ['read', 'write'] } } })
    const project = services.projects.openProject(repo)
    const thread = services.threads.createThread('Cross-feature workflow', project.id, repo, { worktreeEnabled: true })
    const branch = (id: 'a' | 'z'): WorkflowGraph => {
      const settings = defaultAgentSettings({ name: 'Branch ' + id, slug: 'branch-' + id })
      settings.primaryModel.ref = { providerId: provider.id, modelId: model.id }
      settings.context.includeProjectInstructions = false
      settings.context.includeCurrentThread = false
      settings.context.selectedFiles = []
      settings.context.sources = []
      settings.tools = { mode: 'explicit', allowlist: ['read', 'write'] }
      settings.approval.policy = 'inherit'
      settings.recovery.retryCount = 0
      const saved = services.platform.agentDefinitions.createDraft({ settings, systemPrompt: id === 'a' ? 'BRANCH_A_ONLY' : 'BRANCH_Z_ONLY' })
      services.platform.agentDefinitions.publish(saved.id, saved.draftHash)
      return {
        entryNodeId: 'agent-' + id, nodes: [
          { id: 'agent-' + id, type: 'agent', version: 1, config: { agent: { kind: 'user', definitionId: saved.id }, instructions: 'Write branch-output.txt, then return the supplied sentinel and branch as JSON.', outputSchema: { type: 'object', required: ['branch', 'sentinel'] } }, inputs: { sentinel: { ref: 'node', nodeId: 'script', pointer: '/sentinel' } } },
          { id: 'end-' + id, type: 'end', version: 1, config: {}, inputs: { result: { ref: 'node', nodeId: 'agent-' + id, pointer: '' } } }
        ], edges: [{ from: 'agent-' + id, port: 'success', to: 'end-' + id }]
      }
    }
    const script = `import {readFileSync,writeFileSync} from 'node:fs';const sentinel=readFileSync('sentinel.txt','utf8');writeFileSync('script-proof.txt',sentinel);console.log(JSON.stringify({sentinel,cwd:process.cwd()}));`
    const bundle: WorkflowBundle = {
      assets: [{ relativePath: 'scripts/proof.mjs', bytes: new TextEncoder().encode(script) }],
      manifest: {
        schemaVersion: 1, id: randomUUID(), name: 'Full pipeline', slug: 'full-pipeline', entryNodeId: 'start', inputSchema: { type: 'object' }, outputSchema: { type: 'object' },
        permissions: { capabilities: ['script.trusted-local', 'workspace.read', 'model.invoke', 'artifact.write'] }, limits: { maxConcurrency: 2, maxSteps: 30 },
        nodes: [
          { id: 'start', type: 'start', version: 1, config: {} },
          { id: 'script', type: 'script', version: 1, config: { runtime: 'node', file: 'scripts/proof.mjs', executionMode: 'trusted-local', workingDirectory: 'thread-workspace', timeoutMs: 10000 } },
          { id: 'condition', type: 'condition', version: 1, config: { expression: { op: 'eq', args: [{ ref: 'node', nodeId: 'script', pointer: '/sentinel' }, { literal: sentinel }] } } },
          { id: 'parallel', type: 'parallel', version: 1, config: { maxConcurrency: 2, branches: [{ id: 'z', subgraph: branch('z') }, { id: 'a', subgraph: branch('a') }] } },
          { id: 'join', type: 'join', version: 1, config: { parallelNodeId: 'parallel', policy: 'all-success' } },
          { id: 'artifact', type: 'write-artifact', version: 1, config: { name: 'pipeline.json', content: { ref: 'node', nodeId: 'join', pointer: '' } } },
          { id: 'end', type: 'end', version: 1, config: {}, inputs: { result: { ref: 'node', nodeId: 'artifact', pointer: '' } } },
          { id: 'wrong-condition', type: 'end', version: 1, config: {}, inputs: { result: { literal: { failed: true } } } }
        ], edges: [
          { from: 'start', port: 'next', to: 'script' }, { from: 'script', port: 'success', to: 'condition' },
          { from: 'condition', port: 'true', to: 'parallel' }, { from: 'condition', port: 'false', to: 'wrong-condition' },
          { from: 'parallel', port: 'success', to: 'join' }, { from: 'join', port: 'success', to: 'artifact' }, { from: 'artifact', port: 'success', to: 'end' }
        ]
      }
    }
    const endpoint = await server.start()
    rpc = new LocalMmsClient({ homeDir, endpoint, ownerToken: 'cross-feature-owner', clientType: 'gui', requestedCapabilities: ['profiles-v1', WORKFLOW_DEFINITIONS_CAPABILITY, WORKFLOW_RUN_CAPABILITY] })
    await rpc.connect(); await rpc.request('profiles.bind', { profile: alice.id })
    const definitions = createWorkflowDefinitionsClient(rpc), runs = createWorkflowExecutionClient(rpc)
    const saved = await definitions.create({ profileId: alice.id, bundle })
    await definitions.publish({ profileId: alice.id, id: saved.id, expectedDraftSemanticHash: saved.semanticHash })
    let view = await runs.start({ profileId: alice.id, threadId: thread.id, projectId: project.id, definitionId: saved.id, requestId: randomUUID(), input: {} })
    const approved = new Set<string>()
    const deadline = Date.now() + 30000
    while (!['succeeded', 'failed', 'cancelled', 'unknown-effect'].includes(view.state) && Date.now() < deadline) {
      for (const approval of view.pendingApprovals ?? (view.pendingApproval ? [view.pendingApproval] : [])) {
        if (approved.has(approval.approvalId)) continue
        approved.add(approval.approvalId)
        const { approvalId, nodeId, instanceKey, attempt } = approval
        await runs.approve!({ profileId: alice.id, runId: view.runId, approvalId, nodeId, instanceKey, attempt, approved: true })
      }
      await new Promise((resolve) => setTimeout(resolve, 20))
      view = await runs.get({ profileId: alice.id, runId: view.runId })
    }
    expect(view.state, view.error).toBe('succeeded')
    const snapshot = await services.platform.workflowRuns.runtime.get(view.runId, { profileId: alice.id })
    const expected = { results: [{ id: 'a', ok: true, output: { branch: 'a', sentinel } }, { id: 'z', ok: true, output: { branch: 'z', sentinel } }] }
    expect(snapshot.outputs.join).toEqual(expected)
    expect(calls.a).toHaveLength(2); expect(calls.z).toHaveLength(2)
    const artifact = (snapshot.result as { artifact: { id: string; sha256: string } }).artifact
    const store = new FileArtifactStore({ profileId: alice.id, profileRoot: services.getProfileHomeDir() })
    const stored = await store.get(artifact.id, alice.id, { runId: view.runId })
    expect(JSON.parse(Buffer.from(stored.bytes).toString())).toEqual(expected)
    expect(createHash('sha256').update(stored.bytes).digest('hex')).toBe(artifact.sha256)
    const scriptCwd = realpathSync((snapshot.outputs.script as { cwd: string }).cwd)
    expect(scriptCwd).not.toBe(realpathSync(repo))
    expect(readFileSync(join(scriptCwd, 'script-proof.txt'), 'utf8')).toBe(sentinel)
    const worktrees = git('worktree', 'list', '--porcelain').split('\n').filter((line) => line.startsWith('worktree ')).map((line) => line.slice(9))
    const branchPaths = worktrees.filter((path) => existsSync(join(path, 'branch-output.txt')))
    expect(branchPaths).toHaveLength(2)
    expect(new Set(branchPaths.map((path) => readFileSync(join(path, 'branch-output.txt'), 'utf8')))).toEqual(new Set(['branch-a', 'branch-z']))
    expect(branchPaths.map((path) => realpathSync(path))).not.toContain(realpathSync(repo))
    expect(existsSync(join(repo, 'script-proof.txt'))).toBe(false)
    expect(existsSync(join(repo, 'branch-output.txt'))).toBe(false)
    expect(git('rev-parse', 'HEAD')).toBe(originalHead); expect(git('branch', '--show-current')).toBe(originalBranch)
    expect(git('status', '--porcelain')).toBe('')
    const completed = snapshot.attempts.filter((attempt) => attempt.outcome === 'succeeded').map((attempt) => attempt.nodeId)
    expect(completed).toEqual(expect.arrayContaining(['script', 'condition', 'parallel', 'join', 'artifact', 'agent-a', 'agent-z']))
  } finally {
    await rpc?.close(); await server.stop(); await main.stop()
  }
}, 60000)
