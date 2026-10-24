import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import type { ResourceInventorySnapshot } from '../src/shared/resourceLifecycle'
import { ThreadWorkspaceManager } from '../src/mms/workspace/ThreadWorkspaceManager'
import { ThreadActionService } from '../src/mms/actions/ThreadActionService'
import { ChangeReceiptService } from '../src/mms/actions/ChangeReceiptService'
import { UndoRetentionService } from '../src/mms/actions/UndoRetentionService'
import { AgentEpisodeStore } from '../src/mms/agents/AgentEpisodeStore'
import { WorktreeRetirementService } from '../src/mms/lifecycle/WorktreeRetirementService'
import { acquireRepositoryLease } from '../src/mms/git/RepositoryLease'
import { resolveRepositoryIdentity } from '../src/mms/git/RepositoryIdentity'
import { releaseExecutionLeaseHandle, waitAcquireExecutionLease } from '../src/mms/queue/ThreadExecutionLease'
import { lifecycleHarness } from './fixtures/resource-lifecycle-harness'
import { createQualificationRepository, primaryCheckoutSnapshot } from './fixtures/resource-lifecycle-qualification'
import { actionOptions, git } from './fixtures/gitFoundation'
import { seedLegacyNamedEpisode } from './fixtures/legacy-named-agent'

// Named agents can no longer be created. This rebuilds, with real Git and the real retirement and
// receipt services, what an older build left behind, then checks that lifecycle code still protects it.
it('keeps an older unintegrated isolated result and its Undo refs after a newer episode and Undo expiry', async () => {
  const f = await lifecycleHarness()
  try {
    const repo = createQualificationRepository(f.root), primary = primaryCheckoutSnapshot(repo)
    const { project } = await f.rpc.request<{ project: { id: string } }>('projects.open', { path: repo })
    const { thread } = await f.rpc.request<{ thread: { id: string } }>('threads.create', { name: 'old unpublished episode', projectId: project.id })
    // The first write provisions the task's owned checkout.
    await f.rpc.request('files.write', { threadId: thread.id, path: 'seed.txt', content: 'seed\n' })
    const directory = f.services.threads.getThreadDir(thread.id)
    const workspace = new ThreadWorkspaceManager(directory).load()!.worktreePath
    const base = git(workspace, 'rev-parse', 'HEAD')

    // An isolated child checkout whose result was committed, as the retired create path left it.
    const episodeId = 'legacy-old-result', agentId = randomUUID()
    const child = await f.services.worktrees.createWorktree(episodeId, workspace, base)
    const childDirectory = join(directory, 'agent-changes', agentId)
    await new ThreadActionService(childDirectory).runCheckpointedAction({ ...actionOptions(child.path), threadId: thread.id, actor: { kind: 'agent', id: agentId } },
      () => writeFileSync(join(child.path, 'unpublished.txt'), 'older unpublished result\n'))
    const resultSha = git(child.path, 'rev-parse', 'HEAD')
    expect(resultSha).not.toBe(base)
    const receipt = new ChangeReceiptService(childDirectory).list().at(-1)!
    expect(receipt.retainedRefs.length).toBeGreaterThan(0)

    // Its episode record, then the checkout retired the way the old completion step did.
    seedLegacyNamedEpisode(directory, { name: 'Writer', agentId, episodeId, workspace: 'isolated', access: 'write', worktreePath: child.path, branch: child.branch, baseSha: base, resultSha, receiptId: receipt.id })
    const taskLease = await waitAcquireExecutionLease(directory, { source: 'legacy-retirement-fixture' })
    const repositoryLease = await acquireRepositoryLease(resolveRepositoryIdentity(workspace, { requireMutationCapability: true }))
    try {
      const retirement = new WorktreeRetirementService(f.services.threads.lifecycleStore, { taskLease, repositoryLease })
      retirement.prepare({ taskId: thread.id, worktreePath: child.path, branch: child.branch, sourcePath: new AgentEpisodeStore(directory).path, baseSha: base, resultSha })
      retirement.retire(retirement.pathFor(thread.id, child.path))
    } finally { repositoryLease.release(); releaseExecutionLeaseHandle(taskLease) }
    expect(existsSync(child.path)).toBe(false)

    // A newer episode by the same identity, then the old receipt's Undo window expires.
    seedLegacyNamedEpisode(directory, { name: 'Writer', agentId, episodeId: 'legacy-new-result', contextGeneration: 1, workspace: 'shared', access: 'read-only', worktreePath: workspace })
    let now = Date.now()
    const retention = new UndoRetentionService(childDirectory, () => now)
    await retention.configure(workspace, { windowMs: 10_000, migrationGraceMs: 10_000, maxForwardStepMs: 100_000 }, true)
    now += 20_000
    expect((await retention.sweep(workspace)).expired).toContain(receipt.id)
    expect(retention.isReceiptExpired(receipt.id)).toBe(true)

    const { inventory } = await f.rpc.request<{ inventory: ResourceInventorySnapshot }>('threads.inventory', { threadId: thread.id })
    expect(inventory.blockers).toEqual([])
    const claimsOn = (identity: string) => inventory.resources.find((resource) => resource.identity === identity)?.claims.map((claim) => claim.kind)
    expect(claimsOn(`refs/heads/${child.branch}`)).toContain('pending-integration')
    for (const ref of receipt.retainedRefs) expect(claimsOn(ref), ref).toContain('recall')
    // The refs themselves are still there, not only the claims on them.
    expect(git(workspace, 'rev-parse', `refs/heads/${child.branch}`)).toBe(resultSha)
    for (const ref of receipt.retainedRefs) expect(git(workspace, 'rev-parse', ref)).toBe(ref.endsWith('/before') ? receipt.beforeSha : receipt.afterSha)
    expect(existsSync(child.path)).toBe(false)
    expect(primaryCheckoutSnapshot(repo)).toEqual(primary)
  } finally { await f.close() }
}, 60_000)
