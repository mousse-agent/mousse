import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import type { AssistantMessage, Context } from '@earendil-works/pi-ai'
import type { AgentEpisodeState } from '../src/shared/agentEpisodes'
import type { ResourceInventorySnapshot } from '../src/shared/resourceLifecycle'
import { ThreadWorkspaceManager } from '../src/mms/workspace/ThreadWorkspaceManager'
import { ChangeReceiptService } from '../src/mms/actions/ChangeReceiptService'
import { UndoRetentionService } from '../src/mms/actions/UndoRetentionService'
import { lifecycleHarness } from './fixtures/resource-lifecycle-harness'
import { createQualificationRepository, primaryCheckoutSnapshot } from './fixtures/resource-lifecycle-qualification'
import { git } from './fixtures/gitFoundation'
import { providerResponse, streamOf } from './fixtures/agent-platform/agent-runtime-policy/helpers'

function modelFixture(f: Awaited<ReturnType<typeof lifecycleHarness>>) {
  const models = f.services.providerAuth.models
  const provider = models.getProviders().find((entry) => models.getModels(entry.id).length > 0)!
  const model = models.getModels(provider.id)[0]
  const responses: AssistantMessage[] = [], captured: Context[] = []
  vi.spyOn(f.services.providerAuth, 'has').mockReturnValue(true)
  vi.spyOn(models, 'getAuth').mockResolvedValue({ apiKey: 'fixture' } as never)
  vi.spyOn(models, 'streamSimple').mockImplementation((_model, context) => {
    captured.push(structuredClone(context))
    const response = responses.shift()
    if (!response) throw new Error('Unexpected model invocation during named lifecycle qualification')
    return streamOf(response) as never
  })
  const settings = f.services.settings.get()
  f.services.settings.set({ provider: { llmProvider: provider.id, model: model.id }, integrations: { ...settings.integrations,
    tools: { enabled: true, enabledTools: ['read', 'write'] }, skills: { ...settings.integrations.skills, enabled: false }, mcp: { ...settings.integrations.mcp, enabled: false } } })
  return { responses, captured }
}
const done = (text: string) => providerResponse([{ type: 'text', text }], 'stop')

async function completed(f: Awaited<ReturnType<typeof lifecycleHarness>>, threadId: string, episodeId: string) {
  let state!: AgentEpisodeState
  await vi.waitFor(async () => {
    state = await f.rpc.request('agents.listNamed', { threadId })
    expect(state.episodes.find((episode) => episode.id === episodeId)?.state).toBe('completed')
    expect(f.services.orchestrator.listMousseAgentSessionIds()).not.toContain(state.identities[0].id)
  }, { timeout: 15_000 })
  return state
}

it('requires fresh named context after selecting a conversation fork with an identical parent prefix', async () => {
  const f = await lifecycleHarness()
  try {
    const repo = createQualificationRepository(f.root), primary = primaryCheckoutSnapshot(repo)
    const { project } = await f.rpc.request<{ project: { id: string } }>('projects.open', { path: repo })
    const { thread } = await f.rpc.request<{ thread: { id: string } }>('threads.create', { name: 'branch context identity', projectId: project.id })
    const { responses, captured } = modelFixture(f)
    responses.push(done('Parent reply'), done('PRIVATE_MAIN_BRANCH_MEMORY_673'), done('Fresh branch reply'))
    await f.rpc.request('orchestrator.send', { threadId: thread.id, content: 'Parent request', mode: 'agent' })
    const parentMessages = structuredClone(f.services.orchestrator.getNativeContext(thread.id).messages)
    await f.rpc.request('agents.createNamed', { threadId: thread.id, name: 'Rememberer', task: 'Remember this branch', operationId: 'branch-first' })
    const state = await completed(f, thread.id, 'branch-first')
    expect(state.episodes[0].parentConversation.branchId).toBe('main')
    const { actions } = await f.rpc.request<{ actions: Array<{ id: string }> }>('actions.list', { threadId: thread.id })
    const { branch } = await f.rpc.request<{ branch: { id: string } }>('actions.fork', { threadId: thread.id, actionId: actions.at(-1)!.id, name: 'Identical prefix fork' })
    await f.rpc.request('actions.activateBranch', { threadId: thread.id, conversationBranchId: branch.id })
    expect(f.services.orchestrator.getNativeContext(thread.id).messages).toEqual(parentMessages)
    expect(new ThreadWorkspaceManager(f.services.threads.getThreadDir(thread.id)).load()?.conversationBranchId).toBe(branch.id)
    const recall = { threadId: thread.id, agent: state.identities[0].id, expectedAgentGeneration: 1, task: 'Continue your memory' }
    await expect(f.rpc.request('agents.recallNamed', { ...recall, operationId: 'branch-continue' })).rejects.toThrow(/diverged|fresh context/i)
    expect(captured).toHaveLength(2)
    await f.rpc.request('agents.recallNamed', { ...recall, operationId: 'branch-fresh', contextMode: 'fresh' })
    const fresh = await completed(f, thread.id, 'branch-fresh')
    expect(fresh.episodes.at(-1)?.parentConversation.branchId).toBe(branch.id)
    expect(fresh.identities[0].contextGeneration).toBe(2)
    expect(JSON.stringify(captured[2].messages)).not.toContain('PRIVATE_MAIN_BRANCH_MEMORY_673')
    expect(primaryCheckoutSnapshot(repo)).toEqual(primary)
  } finally { await f.close(); vi.restoreAllMocks() }
}, 45_000)

it('retains an older unintegrated isolated result after later recall and expiry of its Undo receipt', async () => {
  const f = await lifecycleHarness()
  try {
    const repo = createQualificationRepository(f.root), primary = primaryCheckoutSnapshot(repo)
    const { project } = await f.rpc.request<{ project: { id: string } }>('projects.open', { path: repo })
    const { thread } = await f.rpc.request<{ thread: { id: string } }>('threads.create', { name: 'old unpublished episode', projectId: project.id })
    const { responses, captured } = modelFixture(f)
    responses.push(providerResponse([{ type: 'toolCall', id: 'old-result-write', name: 'write', arguments: { path: 'unpublished.txt', content: 'older unpublished result\n' } }], 'toolUse'), done('OLD_UNPUBLISHED_MEMORY_882'), done('Later shared observation'))
    await f.rpc.request('agents.createNamed', { threadId: thread.id, name: 'Writer', task: 'Write an isolated unpublished result', operationId: 'old-result', workspace: 'isolated', access: 'write' })
    const first = await completed(f, thread.id, 'old-result'), old = first.episodes[0]
    await vi.waitFor(() => expect(existsSync(old.binding.worktreePath)).toBe(false), { timeout: 15_000 })
    expect(old.result?.resultSha).not.toBe(old.binding.baseSha)
    expect(old.result?.receiptId).toBeTruthy()
    await f.rpc.request('agents.recallNamed', { threadId: thread.id, agent: first.identities[0].id, task: 'Recall your memory as a shared reader', operationId: 'new-result', expectedAgentGeneration: 1, workspace: 'shared', access: 'read-only' })
    const later = await completed(f, thread.id, 'new-result')
    expect(later.identities[0].lastEpisodeId).toBe('new-result')
    expect(later.episodes).toHaveLength(2)
    expect(JSON.stringify(captured.at(-1)?.messages)).toContain('OLD_UNPUBLISHED_MEMORY_882')
    const directory = f.services.threads.getThreadDir(thread.id), childDirectory = join(directory, 'agent-changes', old.agentId)
    const workspace = new ThreadWorkspaceManager(directory).load()!.worktreePath
    const receipt = new ChangeReceiptService(childDirectory).list().find((entry) => entry.id === old.result!.receiptId)!
    expect(receipt).toBeDefined()
    let now = Date.now()
    const retention = new UndoRetentionService(childDirectory, () => now)
    await retention.configure(workspace, { windowMs: 10_000, migrationGraceMs: 10_000, maxForwardStepMs: 100_000 }, true)
    now += 20_000
    expect((await retention.sweep(workspace)).expired).toContain(receipt.id)
    expect(retention.isReceiptExpired(receipt.id)).toBe(true)
    const { inventory } = await f.rpc.request<{ inventory: ResourceInventorySnapshot }>('threads.inventory', { threadId: thread.id })
    expect(inventory.blockers).toEqual([])
    const oldBranch = inventory.resources.find((resource) => resource.identity === `refs/heads/${old.binding.branch}`)!
    expect(oldBranch.claims.some((claim) => claim.kind === 'pending-integration')).toBe(true)
    expect(git(workspace, 'rev-parse', `refs/heads/${old.binding.branch}`)).toBe(old.result!.resultSha)
    for (const ref of receipt.retainedRefs) {
      const resource = inventory.resources.find((entry) => entry.identity === ref)!
      expect(resource.claims.some((claim) => claim.kind === 'recall')).toBe(true)
      expect(git(workspace, 'rev-parse', ref)).toBe(ref.endsWith('/before') ? receipt.beforeSha : receipt.afterSha)
    }
    expect(existsSync(old.binding.worktreePath)).toBe(false)
    expect(primaryCheckoutSnapshot(repo)).toEqual(primary)
  } finally { await f.close(); vi.restoreAllMocks() }
}, 45_000)
