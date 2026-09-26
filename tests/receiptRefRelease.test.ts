import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { ResourceLifecycleStore } from '../src/mms/lifecycle/ResourceLifecycleStore'
import { ThreadWorkspaceManager } from '../src/mms/workspace/ThreadWorkspaceManager'
import { ThreadActionService } from '../src/mms/actions/ThreadActionService'
import { ChangeReceiptService } from '../src/mms/actions/ChangeReceiptService'
import { UndoRetentionService } from '../src/mms/actions/UndoRetentionService'
import { ReceiptRefReleaseService } from '../src/mms/actions/ReceiptRefReleaseService'
import { CodeRevertService } from '../src/mms/actions/CodeRevertService'
import { ConversationBranchService } from '../src/mms/actions/ConversationBranchService'
import { ThreadJournal } from '../src/mms/data/ThreadJournal'
import { AgentEpisodeStore } from '../src/mms/agents/AgentEpisodeStore'
import { ProfileManager } from '../src/mms/profiles/ProfileManager'
import { createInstallationPaths } from '../src/mms/profiles/paths'
import { actionOptions, git, gitFoundationFixture } from './fixtures/gitFoundation'

let f: ReturnType<typeof gitFoundationFixture>
beforeEach(() => { f = gitFoundationFixture() })
afterEach(() => f.dispose())
async function fixture() {
  writeFileSync(join(f.thread, 'meta.json'), JSON.stringify({ id: 'task' }))
  const store = new ResourceLifecycleStore({ profileId: 'default', profileHome: f.home, allowedTaskRoots: [f.root] })
  store.registerTask({ taskId: 'task', location: f.thread })
  const workspace = await new ThreadWorkspaceManager(f.thread).provision('task', 'main', f.repo)
  const { action } = await new ThreadActionService(f.thread).runCheckpointedAction(actionOptions(workspace.worktreePath), () => writeFileSync(join(workspace.worktreePath, 'value.txt'), 'retained result\n'))
  const receipt = new ChangeReceiptService(f.thread).list()[0]!
  let now = Date.now()
  const retention = new UndoRetentionService(f.thread, () => now)
  await retention.configure(workspace.worktreePath, { windowMs: 1000, migrationGraceMs: 1000, maxForwardStepMs: 100000 }, true)
  now += 10000
  await retention.sweep(workspace.worktreePath)
  return { store, workspace, receipt, action, release: new ReceiptRefReleaseService(store, 'task', () => now) }
}

it('releases only exclusive expired receipt refs and leaves current/user branches and transcript readable', async () => {
  const { workspace, receipt, release, action } = await fixture()
  const userHead = git(f.repo, 'rev-parse', 'HEAD')
  writeFileSync(join(f.thread, 'messages.json'), JSON.stringify([{ content: 'retained transcript' }]))
  const result = await release.release(workspace.worktreePath)
  expect(result.retained).toEqual([])
  expect(result.releasedRefs).toEqual(receipt.retainedRefs)
  expect(result.reclaimedGitBytes).toBeNull()
  expect(git(f.repo, 'rev-parse', 'HEAD')).toBe(userHead)
  expect(git(workspace.worktreePath, 'rev-parse', workspace.retainedRef)).toBe(action.endSha)
  expect(f.read(f.thread, 'messages.json')).toContain('retained transcript')
  const { id: _id, workspaceId: _workspaceId, generation: _generation, retainedRefs: _refs, createdAt: _createdAt, ...input } = receipt
  expect(new ChangeReceiptService(f.thread).record(workspace.worktreePath, input)).toEqual(receipt)
  expect(git(f.repo, 'for-each-ref', '--format=%(refname)', `refs/mousse/changes/${receipt.id}`)).toBe('')
  await expect(new CodeRevertService(f.thread).revertCode(action.id, workspace.worktreePath)).rejects.toThrow('expired')
})

it('retries a crash after CAS deletion without recreating either ref', async () => {
  const { workspace, receipt, release } = await fixture()
  const interrupted = await release.release(workspace.worktreePath, { afterGit: () => { throw new Error('injected crash') } })
  expect(interrupted.retained[0]?.reason).toContain('injected crash')
  expect(git(f.repo, 'for-each-ref', '--format=%(refname)', `refs/mousse/changes/${receipt.id}`)).toBe('')
  const recovered = await release.release(workspace.worktreePath)
  expect(recovered.retained).toEqual([])
  expect(recovered.releasedRefs).toEqual(receipt.retainedRefs)
  expect((await release.release(workspace.worktreePath)).releasedRefs).toEqual([])
})

it('refuses changed refs, pending integration and shared/unknown source claims', async () => {
  const { workspace, receipt, release } = await fixture()
  git(workspace.worktreePath, 'update-ref', receipt.retainedRefs[0]!, receipt.afterSha)
  const result = await release.release(workspace.worktreePath)
  expect(result.releasedRefs).toEqual([])
  expect(result.retained[0]?.reason).toContain('changed')
  git(workspace.worktreePath, 'update-ref', receipt.retainedRefs[0]!, receipt.beforeSha)
  writeFileSync(join(f.thread, 'agents.json'), JSON.stringify([{ id: 'unknown', status: 'ready', branch: 'foreign', worktreePath: f.repo }]))
  await expect(release.release(workspace.worktreePath)).rejects.toThrow('unambiguous')
  expect(git(f.repo, 'rev-parse', receipt.retainedRefs[0]!)).toBe(receipt.beforeSha)
})

it('preserves a saved-branch claim and blocks physical release during pending integration', async () => {
  const { workspace, receipt, release } = await fixture()
  writeFileSync(join(f.thread, 'conversation-branches.json'), JSON.stringify([{ id: 'saved', retainedRef: receipt.retainedRefs[0] }]))
  expect((await release.release(workspace.worktreePath)).retained[0]?.reason).toContain('claim')
  expect(git(f.repo, 'rev-parse', receipt.retainedRefs[0]!)).toBe(receipt.beforeSha)
  new ThreadJournal(f.thread).append({ operationId: 'pending-integration', operationType: 'integrate', state: 'prepared' })
  await expect(release.release(workspace.worktreePath)).rejects.toThrow('recovery')
})

it('rejects symbolic replacement rather than following it into user refs', async () => {
  const { workspace, receipt, release } = await fixture()
  const primary = git(f.repo, 'symbolic-ref', 'HEAD')
  const head = git(f.repo, 'rev-parse', 'HEAD')
  git(f.repo, 'symbolic-ref', receipt.retainedRefs[0]!, primary)
  expect((await release.release(workspace.worktreePath)).retained[0]?.reason).toContain('symbolic')
  expect(git(f.repo, 'rev-parse', primary)).toBe(head)
})

it('admits history honestly after expired code objects are genuinely collected in a disposable repository', async () => {
  const { workspace, receipt, action, release } = await fixture()
  writeFileSync(join(f.thread, 'messages.json'), '[{"content":"conversation survives collection"}]')
  expect((await release.release(workspace.worktreePath)).releasedRefs).toEqual(receipt.retainedRefs)
  // This fixture deliberately discards its test task result and reflogs. Production never does this.
  git(f.repo, 'worktree', 'remove', workspace.worktreePath)
  git(f.repo, 'update-ref', '-d', workspace.retainedRef, action.endSha)
  git(f.repo, 'branch', '-D', workspace.branch)
  git(f.repo, 'reflog', 'expire', '--expire=now', '--all')
  git(f.repo, 'gc', '--prune=now')
  expect(() => git(f.repo, 'cat-file', '-t', action.endSha)).toThrow()
  await expect(new CodeRevertService(f.thread).revertCode(action.id, f.repo)).rejects.toThrow('expired')
  await expect(new ConversationBranchService(f.thread).fork(f.repo, 'main', action.id, 'Unavailable')).rejects.toThrow('expired')
  expect(f.read(f.thread, 'messages.json')).toContain('conversation survives collection')
})

it('protects the actual named-agent latest episode receipt across logical Undo expiry', async () => {
  const { workspace, receipt, release } = await fixture()
  const agents = new AgentEpisodeStore(f.thread), agent = agents.create('Reviewer')
  const episode = agents.begin({ id: 'review-episode', agentId: agent.id, policy: { version: 1, workspace: 'shared', access: 'read-only' },
    binding: { workspaceId: workspace.workspaceId!, generation: workspace.generation ?? 0, worktreePath: workspace.worktreePath, consistency: 'moving' },
    parentConversation: { branchId: 'main', boundary: 0 }, contextGeneration: 0, task: 'Review retained result' })
  agents.complete(episode.id, 0, { receiptId: receipt.id, resultSha: receipt.afterSha })
  const result = await release.release(workspace.worktreePath)
  expect(result.releasedRefs).toEqual([])
  expect(result.retained[0]?.reason).toContain('claim')
  expect(git(f.repo, 'rev-parse', receipt.retainedRefs[1]!)).toBe(receipt.afterSha)
})

it('preserves a receipt ref referenced by another registered profile', async () => {
  const { workspace, receipt, release } = await fixture()
  const manager = ProfileManager.open(createInstallationPaths(f.home))
  const profile = manager.initializeFresh({ displayName: 'Peer', slug: 'peer' })
  const home = manager.getPaths(profile.id).root
  const peer = new ResourceLifecycleStore({ profileId: profile.id, profileHome: home })
  const location = join(home, 'thread-data', 'standalone', 'peer-task')
  mkdirSync(location, { recursive: true })
  writeFileSync(join(location, 'meta.json'), '{"id":"peer-task"}')
  peer.registerTask({ taskId: 'peer-task', location })
  writeFileSync(join(location, 'conversation-branches.json'), JSON.stringify([{ id: 'cross-profile', retainedRef: receipt.retainedRefs[0] }]))
  const result = await release.release(workspace.worktreePath)
  expect(result.releasedRefs).toEqual([])
  expect(result.retained[0]?.reason).toContain('another task or profile')
})
