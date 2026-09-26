import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { Agent, Thread } from '../src/shared/types'
import type { LifecycleOperationResult, ResourceInventorySnapshot, TaskLifecycleRecord } from '../src/shared/resourceLifecycle'
import type { WorkflowRunView } from '../src/shared/workflowRunPlatform'
import { lifecycleHarness } from './fixtures/resource-lifecycle-harness'
import { providerResponse, streamOf } from './fixtures/agent-platform/agent-runtime-policy/helpers'
import { ThreadWorkspaceManager } from '../src/mms/workspace/ThreadWorkspaceManager'
import { WorktreeRetirementService } from '../src/mms/lifecycle/WorktreeRetirementService'

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

describe('Phase 1 public inventory and request identity', () => {
  it('reports an unverifiable legacy child location without treating a user directory as owned cleanup material', async () => {
    const f = await lifecycleHarness()
    try {
      const { thread } = await f.rpc.request<{ thread: Thread }>('threads.create', { name: 'legacy unknown child' })
      const path = f.services.threads.getThreadDir(thread.id)
      const foreign = join(f.root, 'user-owned-folder'); mkdirSync(foreign)
      writeFileSync(join(foreign, 'sole-copy.txt'), 'not a verified Mousse checkout')
      writeFileSync(join(path, 'agents.json'), JSON.stringify([{ id: 'legacy-child', cliType: 'mousse', status: 'ready',
        executionMode: 'gui', task: 'legacy task', createdAt: new Date().toISOString(), worktreePath: foreign, branch: 'user-branch' }]))
      const { inventory } = await f.rpc.request<{ inventory: ResourceInventorySnapshot }>('threads.inventory', { threadId: thread.id })
      const legacy = inventory.resources.find((resource) => resource.identity === foreign)
      expect(legacy, 'unknown resources must remain visible in the inventory').toBeDefined()
      expect(inventory.blockers.length > 0 || inventory.sources.some((source) => source.status === 'unknown') || legacy?.materialization === 'unknown'
        || legacy?.ownership === 'unknown' || legacy?.ownership === 'source-associated',
        'a parsed legacy path alone is not physical ownership proof').toBe(true)
      await f.rpc.request('threads.trash', { threadId: thread.id }).catch(() => undefined)
      await expect(f.rpc.request('threads.purge', { threadId: thread.id })).rejects.toThrow()
      expect(readFileSync(join(foreign, 'sole-copy.txt'), 'utf8')).toBe('not a verified Mousse checkout')
    } finally { await f.close() }
  })

  it('includes and preserves a real browser artifact retained outside the thread directory', async () => {
    const f = await lifecycleHarness()
    try {
      const { thread } = await f.rpc.request<{ thread: Thread }>('threads.create', { name: 'browser artifact owner' })
      const scope = { profileId: f.alice.id, threadId: thread.id, sessionId: 'resource-lifecycle-browser-session' }
      const bytes = new Uint8Array([137, 80, 78, 71, 0, 255])
      const artifact = await f.services.platform.browserArtifacts.put(scope, { bytes, mediaType: 'image/png', displayName: 'retained screenshot' }, 1024)
      const { inventory } = await f.rpc.request<{ inventory: ResourceInventorySnapshot }>('threads.inventory', { threadId: thread.id })
      expect(inventory.resources.some((resource) => resource.kind === 'artifact' && resource.identity === artifact.id)).toBe(true)
      expect(inventory.sources.some((source) => source.path.includes('artifact-index'))).toBe(true)
      await f.rpc.request('threads.trash', { threadId: thread.id })
      await expect(f.rpc.request('threads.purge', { threadId: thread.id })).rejects.toThrow()
      await f.rpc.request('threads.restore', { threadId: thread.id })
      const restored = await f.services.platform.browserArtifacts.read(scope, artifact.id, 1024)
      expect(Buffer.from(restored.bytes)).toEqual(Buffer.from(bytes))
    } finally { await f.close() }
  })

  it('rejects stale generations and duplicate operation IDs without moving a restored task twice', async () => {
    const f = await lifecycleHarness()
    try {
      const { thread } = await f.rpc.request<{ thread: Thread }>('threads.create', { name: 'generation contract' })
      const before = await f.rpc.request<{ lifecycle: TaskLifecycleRecord; inventory: ResourceInventorySnapshot }>('threads.inventory', { threadId: thread.id })
      const path = f.services.threads.getThreadDir(thread.id)
      const operationId = randomUUID()
      const request = { threadId: thread.id, operationId, expectedGeneration: before.lifecycle.generation }
      const first = await f.rpc.request<{ lifecycle: TaskLifecycleRecord; operationResult: LifecycleOperationResult }>('threads.trash', request)
      expect(first.operationResult).toMatchObject({ operationId, kind: 'trash', state: 'trashed' })
      // A replay returns its original immutable receipt and never appends a
      // second operation, even after a later restore changes current state.
      const duplicate = await f.rpc.request<{ operationResult: LifecycleOperationResult }>('threads.trash', request)
      expect(duplicate.operationResult).toEqual(first.operationResult)
      const trashed = await f.rpc.request<{ lifecycle: TaskLifecycleRecord }>('threads.inventory', { threadId: thread.id })
      expect(trashed.lifecycle.operations.filter((operation) => operation.id === operationId)).toHaveLength(1)
      await expect(f.rpc.request('threads.restore', { ...request, operationId: randomUUID() })).rejects.toThrow(/stale|generation/i)
      await f.rpc.request('threads.restore', { threadId: thread.id, operationId: randomUUID(), expectedGeneration: trashed.lifecycle.generation })
      await expect(f.rpc.request('threads.trash', { ...request, operationId: randomUUID() })).rejects.toThrow(/stale|generation/i)
      const replay = await f.rpc.request<{ lifecycle: TaskLifecycleRecord; operationResult: LifecycleOperationResult }>('threads.trash', request)
      expect(replay.lifecycle.state).toBe('active')
      expect(replay.operationResult).toEqual(first.operationResult)
      expect(existsSync(join(path, 'meta.json'))).toBe(true)
      const after = await f.rpc.request<{ lifecycle: TaskLifecycleRecord }>('threads.inventory', { threadId: thread.id })
      expect(after.lifecycle.state).toBe('active')
      expect(after.lifecycle.generation).toBeGreaterThan(trashed.lifecycle.generation)
      expect(after.lifecycle.operations.filter((operation) => operation.id === operationId)).toHaveLength(1)
    } finally { await f.close() }
  })

  it('retains dirty isolated child bytes and refs while clean task checkout retirement remains reconstructable', async () => {
    const f = await lifecycleHarness()
    let releaseChild = () => {}
    let workflowRunId: string | undefined
    try {
      const repo = join(f.root, 'repo'); mkdirSync(repo)
      git(repo, 'init', '-q'); git(repo, 'config', 'user.name', 'Lifecycle Acceptance')
      git(repo, 'config', 'user.email', 'lifecycle@example.test')
      // Nested profile/worktree fixtures can exceed Git for Windows' legacy path
      // probe limit when rev-list appends its 82-character revision range.
      git(repo, 'config', 'core.longpaths', 'true')
      writeFileSync(join(repo, 'PRIMARY.txt'), 'primary remains unchanged\n')
      git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'acceptance base')
      const primaryHead = git(repo, 'rev-parse', 'HEAD')
      const { project } = await f.rpc.request<{ project: { id: string } }>('projects.open', { path: repo })
      const { thread } = await f.rpc.request<{ thread: Thread }>('threads.create', { name: 'inventory owner', projectId: project.id })

      const llm = (f.services.orchestrator as unknown as { llm: {
        getSelectedModelContextLimit(): { limit: number }; getContextInputs(): Promise<unknown>; chat(...args: unknown[]): Promise<unknown>
      } }).llm
      const contextInputs = { systemPromptText: '', mcpToolsText: '', otherToolsText: '', signature: 'resource-lifecycle-inventory' }
      vi.spyOn(llm, 'getSelectedModelContextLimit').mockReturnValue({ limit: 100_000 })
      vi.spyOn(llm, 'getContextInputs').mockResolvedValue(contextInputs)
      const heldChild = new Promise<void>((done) => { releaseChild = done })
      let childIdentity = ''
      vi.spyOn(llm, 'chat').mockImplementation(async (...args) => {
        const options = args[2] as { subagentDiscovery?: { onDeclareFiles(files: string[], reason: string): void } } | undefined
        if (options?.subagentDiscovery) options.subagentDiscovery.onDeclareFiles(['PRIMARY.txt'], 'deterministic lifecycle fixture')
        else await heldChild
        const text = options?.subagentDiscovery ? 'declared fixture file'
          : 'retained child result\n```mousse-actions\n' + JSON.stringify({ actions: [{ type: 'complete_task', agentIds: [childIdentity], merge: false }] }) + '\n```'
        return { text, contextInputs, nativeMessages: [], toolEvents: [],
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          modelName: 'fixture', totalResponseTimeMs: 1, totalTokensUsed: 2, tokensPerSecond: 2 }
      })
      const spawned = await f.rpc.request<{ logs: string[] }>('agents.spawn', { threadId: thread.id, cliType: 'mousse', task: 'Inspect PRIMARY.txt and retain your result.' })
      const agents = (await f.rpc.request<{ agents: Agent[] }>('agents.list', { threadId: thread.id })).agents
      expect(agents, spawned.logs.join('\n')).toHaveLength(1)
      const child = agents[0]
      childIdentity = child.id
      expect(child.status, spawned.logs.join('\n')).toBe('running')
      expect(resolve(child.worktreePath)).not.toBe(resolve(repo))
      expect(readFileSync(join(child.worktreePath, 'PRIMARY.txt'), 'utf8')).toBe('primary remains unchanged\n')
      await expect(f.rpc.request('threads.trash', { threadId: thread.id })).rejects.toThrow(/active|busy|drain|agent|blocked/i)
      writeFileSync(join(child.worktreePath, 'PRIMARY.txt'), 'retained isolated result\n')
      git(child.worktreePath, 'add', 'PRIMARY.txt'); git(child.worktreePath, 'commit', '-qm', 'deterministic child result')
      releaseChild()
      await vi.waitFor(async () => {
        const current = (await f.rpc.request<{ agents: Agent[] }>('agents.list', { threadId: thread.id })).agents[0]
        expect(current.status, JSON.stringify(f.services.threads.loadThreadData(thread.id).tasks)).toBe('cancelled')
      }, { timeout: 5000 })
      writeFileSync(join(child.worktreePath, 'SOLE-COPY.bin'), Buffer.from([0, 255, 17]))

      const provider = f.services.providerAuth.models.getProviders().find((entry) => f.services.providerAuth.models.getModels(entry.id).length > 0)!
      const model = f.services.providerAuth.models.getModels(provider.id)[0]
      const auth = vi.spyOn(f.services.providerAuth, 'has').mockReturnValue(true)
      const getAuth = vi.spyOn(f.services.providerAuth.models, 'getAuth').mockResolvedValue({ apiKey: 'fixture' } as never)
      const stream = vi.spyOn(f.services.providerAuth.models, 'streamSimple').mockImplementation(() => streamOf(providerResponse([{ type: 'text', text: '{"summary":"shared workflow result"}' }], 'stop')) as never)
      f.services.settings.set({ provider: { llmProvider: provider.id, model: model.id } })
      const id = randomUUID()
      const draft = await f.rpc.request<{ id: string; semanticHash: string }>('workflows.create', { profileId: f.alice.id, bundle: {
        assets: [], manifest: { schemaVersion: 1, id, name: 'Shared lifecycle instruction', slug: `lifecycle-${id.slice(0, 8)}`,
          entryNodeId: 'start', inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, permissions: { capabilities: ['model.invoke'] },
          nodes: [ { id: 'start', type: 'start', version: 1, config: {} },
            { id: 'instruction', type: 'instruction', version: 1, config: { text: 'Return a summary object without editing files.' } },
            { id: 'end', type: 'end', version: 1, config: {}, inputs: { result: { ref: 'node', nodeId: 'instruction', pointer: '' } } } ],
          edges: [{ from: 'start', port: 'next', to: 'instruction' }, { from: 'instruction', port: 'success', to: 'end' }] }
      } })
      await f.rpc.request('workflows.publish', { profileId: f.alice.id, id: draft.id, expectedDraftSemanticHash: draft.semanticHash })
      const run = await f.rpc.request<WorkflowRunView>('workflowRuns.start', { profileId: f.alice.id, threadId: thread.id, definitionId: draft.id, requestId: randomUUID(), input: {} })
      workflowRunId = run.runId
      await vi.waitFor(async () => {
        const view = await f.rpc.request<WorkflowRunView>('workflowRuns.get', { profileId: f.alice.id, runId: run.runId })
        expect(view.state, view.error).toBe('succeeded')
      }, { timeout: 5000 })
      expect(stream).toHaveBeenCalled()
      auth.mockRestore(); getAuth.mockRestore(); stream.mockRestore()

      const generated = f.services.threads.listAllThreads().filter((entry) => entry.id !== thread.id)
      expect(generated.length, 'workflow must actually create a separate durable invocation thread').toBeGreaterThan(0)

      const { inventory } = await f.rpc.request<{ inventory: ResourceInventorySnapshot }>('threads.inventory', { threadId: thread.id })
      expect(inventory.profileId).toBe(f.alice.id)
      expect(inventory.taskId).toBe(thread.id)
      expect(inventory.resources.some((resource) => resource.kind === 'worktree' && resolve(resource.identity) === resolve(child.worktreePath))).toBe(true)
      expect(inventory.resources.some((resource) => resource.kind === 'invocation-thread' && resource.ownerTaskId !== thread.id)).toBe(true)
      expect(inventory.resources.some((resource) => resource.kind === 'workflow-record')).toBe(true)
      expect(inventory.resources.some((resource) => resource.kind === 'git-ref')).toBe(true)
      expect(inventory.resources.flatMap((resource) => resource.claims).some((claim) => claim.kind === 'recall' || claim.kind === 'pending-integration')).toBe(true)
      const refs = git(repo, 'show-ref')
      const parentWorkspace = new ThreadWorkspaceManager(f.services.threads.getThreadDir(thread.id)).load()!
      // A settled child's own Trash state must survive its parent's lifecycle.
      const separatelyTrashed = generated[0]
      await f.rpc.request('threads.trash', { threadId: separatelyTrashed.id })
      await f.rpc.request('threads.trash', { threadId: thread.id })
      for (const invocation of generated) {
        await expect(f.rpc.request('threads.rename', { threadId: invocation.id, name: 'late child write' })).rejects.toThrow()
        await expect(f.rpc.request('orchestrator.send', { threadId: invocation.id, content: 'must not resume while owner is trashed' })).rejects.toThrow()
      }
      await expect(f.rpc.request('threads.purge', { threadId: thread.id })).rejects.toThrow()
      // Trash may add reconstruction pins and retire a proven clean checkout;
      // every pre-existing reference and the dirty child's sole copy survive.
      for (const row of refs.split(/\r?\n/)) {
        const [sha, ref] = row.split(' ')
        expect(git(repo, 'rev-parse', '--verify', ref)).toBe(sha)
      }
      expect(existsSync(parentWorkspace.worktreePath)).toBe(false)
      const retirement = new WorktreeRetirementService(f.services.threads.lifecycleStore)
      const manifest = retirement.load(retirement.pathFor(thread.id, parentWorkspace.worktreePath))
      expect(manifest.state).toBe('retired')
      expect(manifest.resultSha).toBe(parentWorkspace.headSha)
      expect(readFileSync(join(child.worktreePath, 'SOLE-COPY.bin'))).toEqual(Buffer.from([0, 255, 17]))
      await f.rpc.request('threads.restore', { threadId: thread.id })
      expect(existsSync(parentWorkspace.worktreePath)).toBe(false)
      await f.rpc.request('workspace.restore', { threadId: thread.id })
      expect(readFileSync(join(parentWorkspace.worktreePath, 'PRIMARY.txt'), 'utf8')).toBe('primary remains unchanged\n')
      expect(git(parentWorkspace.worktreePath, 'rev-parse', 'HEAD')).toBe(manifest.resultSha)
      const retainedChild = await f.rpc.request<{ lifecycle: TaskLifecycleRecord }>('threads.inventory', { threadId: separatelyTrashed.id })
      expect(retainedChild.lifecycle.state).toBe('trashed')
      await expect(f.rpc.request('threads.get', { threadId: separatelyTrashed.id })).rejects.toThrow()
      await f.rpc.request('threads.restore', { threadId: separatelyTrashed.id })
      expect((await f.rpc.request<{ thread: Thread }>('threads.get', { threadId: separatelyTrashed.id })).thread.id).toBe(separatelyTrashed.id)
      expect(git(repo, 'rev-parse', 'HEAD')).toBe(primaryHead)
      expect(git(repo, 'status', '--porcelain')).toBe('')
      expect(readFileSync(join(repo, 'PRIMARY.txt'), 'utf8')).toBe('primary remains unchanged\n')
    } finally {
      releaseChild()
      if (workflowRunId) await f.services.platform.workflowRuns.runtime.cancel(workflowRunId, { profileId: f.alice.id }, 'acceptance complete').catch(() => undefined)
      await f.close()
      vi.restoreAllMocks()
    }
  }, 30_000)
})
