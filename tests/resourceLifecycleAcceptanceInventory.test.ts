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

describe('public inventory and request identity', () => {
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

  it('carries expectedGeneration and operationId through the protocol: an exact replay returns the first receipt, a stale generation is refused', async () => {
    const f = await lifecycleHarness()
    try {
      const { thread } = await f.rpc.request<{ thread: Thread }>('threads.create', { name: 'generation contract' })
      const before = await f.rpc.request<{ lifecycle: TaskLifecycleRecord; inventory: ResourceInventorySnapshot }>('threads.inventory', { threadId: thread.id })
      const path = f.services.threads.getThreadDir(thread.id)
      const operationId = randomUUID()
      const request = { threadId: thread.id, operationId, expectedGeneration: before.lifecycle.generation }
      const first = await f.rpc.request<{ lifecycle: TaskLifecycleRecord; operationResult: LifecycleOperationResult }>('threads.trash', request)
      expect(first.operationResult).toMatchObject({ operationId, kind: 'trash', state: 'trashed' })
      // A replay returns its original immutable receipt and never appends a second operation.
      const duplicate = await f.rpc.request<{ operationResult: LifecycleOperationResult }>('threads.trash', request)
      expect(duplicate.operationResult).toEqual(first.operationResult)
      const trashed = await f.rpc.request<{ lifecycle: TaskLifecycleRecord }>('threads.inventory', { threadId: thread.id })
      expect(trashed.lifecycle.operations.filter((operation) => operation.id === operationId)).toHaveLength(1)
      // A request built from the old generation is refused; the rule and the replay-after-restore
      // behaviour are decided in ResourceLifecycleCoordinator (resourceLifecycleCoordinator.test.ts).
      await expect(f.rpc.request('threads.restore', { ...request, operationId: randomUUID() })).rejects.toThrow(/stale|generation/i)
      expect(existsSync(join(path, 'meta.json'))).toBe(false)
    } finally { await f.close() }
  })

  it('retains dirty isolated child bytes and refs while clean task checkout retirement remains reconstructable', async () => {
    const f = await lifecycleHarness()
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

      // `agents.spawn` is retired (SPEC §14.5) and answers `deprecated`. Isolated children that
      // earlier versions spawned still exist on disk, so the legacy child is seeded the way the
      // spawn path created it: a sparse worktree from the owned task checkout plus its registry row.
      await expect(f.rpc.request('agents.spawn', { threadId: thread.id, cliType: 'mousse', task: 'Inspect PRIMARY.txt' })).rejects.toThrow(/retired|deprecated/)
      const owner = f.services.orchestrator as unknown as {
        getOrCreateSession(threadId: string): { workspace: { workspacePath: string } | null; agents: { create(input: Omit<Agent, 'id' | 'createdAt' | 'updatedAt'>, id?: string): Agent } }
        withTaskWriter<T>(session: unknown, work: () => Promise<T>): Promise<T>
        snapshotOwnedParent(session: unknown, label: string): Promise<string>
        worktrees: { createSelectiveWorktree(id: string, files: string[], repositoryPath: string, base: string): Promise<{ path: string; branch: string }> }
      }
      const session = owner.getOrCreateSession(thread.id)
      const childIdentity = randomUUID()
      const created = await owner.withTaskWriter(session, async () => {
        const base = await owner.snapshotOwnedParent(session, 'child-base')
        return owner.worktrees.createSelectiveWorktree(childIdentity, ['PRIMARY.txt'], session.workspace!.workspacePath, base)
      })
      session.agents.create({ cliType: 'mousse', worktreePath: created.path, branch: created.branch, repositoryRoot: session.workspace!.workspacePath,
        executionMode: 'gui', status: 'running', task: 'Inspect PRIMARY.txt and retain your result.' } as Omit<Agent, 'id' | 'createdAt' | 'updatedAt'>, childIdentity)
      const agents = (await f.rpc.request<{ agents: Agent[] }>('agents.list', { threadId: thread.id })).agents
      expect(agents).toHaveLength(1)
      const child = agents[0]
      expect(child.status).toBe('running')
      expect(resolve(child.worktreePath)).not.toBe(resolve(repo))
      expect(readFileSync(join(child.worktreePath, 'PRIMARY.txt'), 'utf8')).toBe('primary remains unchanged\n')
      await expect(f.rpc.request('threads.trash', { threadId: thread.id })).rejects.toThrow(/active|busy|drain|agent|blocked/i)
      writeFileSync(join(child.worktreePath, 'PRIMARY.txt'), 'retained isolated result\n')
      git(child.worktreePath, 'add', 'PRIMARY.txt'); git(child.worktreePath, 'commit', '-qm', 'deterministic child result')
      // Stop without merge cancels the legacy child and keeps its worktree and branch.
      await f.rpc.request('agents.stop', { threadId: thread.id, agentId: child.id, merge: false })
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
      if (workflowRunId) await f.services.platform.workflowRuns.runtime.cancel(workflowRunId, { profileId: f.alice.id }, 'acceptance complete').catch(() => undefined)
      await f.close()
      vi.restoreAllMocks()
    }
  }, 30_000)
})
