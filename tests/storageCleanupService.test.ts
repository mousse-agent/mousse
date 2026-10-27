import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { REPORT_ENTRY_LIMIT, STORAGE_POLICY_DEFAULTS, summarizeCleanupReport, type StorageCleanupItem, type StorageCleanupReport, type StoragePolicy } from '../src/shared/storage'
import { measureTree } from '../src/mms/lifecycle/diskMeasure'
import { GitHubCodeHost } from '../src/mms/git/GitHubCodeHost'
import { acquireRepositoryLease } from '../src/mms/git/RepositoryLease'
import { resolveRepositoryIdentity } from '../src/mms/git/RepositoryIdentity'
import { ResourceLifecycleCoordinator } from '../src/mms/lifecycle/ResourceLifecycleCoordinator'
import { ResourceLifecycleStore } from '../src/mms/lifecycle/ResourceLifecycleStore'
import { cleanupMarkerPath, readCleanupMarker, StorageCleanupService } from '../src/mms/lifecycle/StorageCleanupService'
import { StoragePolicyStore } from '../src/mms/lifecycle/StoragePolicyStore'
import { StorageSweepClock } from '../src/mms/lifecycle/sweepClock'
import { lifecycleGit as git, WorktreeRetirementService } from '../src/mms/lifecycle/WorktreeRetirementService'
import { acquireExecutionLease, getExecutionLeasePath, isExecutionLeaseHeld, leaseBusyMessage, readLeaseOwner, releaseExecutionLeaseHandle, tryAcquireExecutionLease, waitAcquireExecutionLease } from '../src/mms/queue/ThreadExecutionLease'
import { registerThreadLifecycleGate } from '../src/mms/queue/ThreadLifecycleAdmission'
import { ThreadWorkspaceManager } from '../src/mms/workspace/ThreadWorkspaceManager'
import { committedGitTemplate } from './support/gitBase'

const DAY = 86_400_000
const HOUR = 3_600_000
const OLD = new Date(Date.now() - 90 * DAY)
const roots: string[] = []
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) })

// A base commit made 90 days ago, so the commit time of HEAD does not count as recent activity.
const copyBase = committedGitTemplate((repo) => {
  const run = (...args: string[]) => git(repo, args)
  run('init', '-q'); run('config', 'user.email', 'test@example.com'); run('config', 'user.name', 'Test'); run('config', 'core.autocrlf', 'false')
  writeFileSync(join(repo, 'a.txt'), 'first\n'); run('add', '.')
  const previous = { author: process.env.GIT_AUTHOR_DATE, committer: process.env.GIT_COMMITTER_DATE }
  process.env.GIT_AUTHOR_DATE = process.env.GIT_COMMITTER_DATE = OLD.toISOString()
  try { run('commit', '-q', '-m', 'base') } finally {
    if (previous.author === undefined) delete process.env.GIT_AUTHOR_DATE; else process.env.GIT_AUTHOR_DATE = previous.author
    if (previous.committer === undefined) delete process.env.GIT_COMMITTER_DATE; else process.env.GIT_COMMITTER_DATE = previous.committer
  }
})

interface FixtureOptions {
  installationHome?: string
  idle?: (taskId: string) => string | undefined
  codeHost?: { cachedDefaultBranch(cwd: string): string | undefined }
  thread?: Record<string, unknown>
  measure?: typeof measureTree
}

function fixture(options: FixtureOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), 'mousse-storage-')); roots.push(root)
  const home = join(root, 'profile'), location = join(home, 'thread-data', 'task'); mkdirSync(location, { recursive: true })
  writeFileSync(join(location, 'meta.json'), JSON.stringify({ id: 'task' })); writeFileSync(join(location, 'messages.json'), '[]')
  const store = new ResourceLifecycleStore({ profileId: 'test', profileHome: home }); store.registerTask({ taskId: 'task', location })
  registerThreadLifecycleGate(home, store)
  const repo = join(root, 'repo'); mkdirSync(repo); copyBase(repo)
  const repositoryId = resolveRepositoryIdentity(repo).key
  const worktree = join(home, 'repositories', repositoryId, 'worktrees', 'threads', 'task', 'main'); mkdirSync(join(worktree, '..'), { recursive: true })
  const branch = 'mousse/thread/task/main'; git(repo, ['worktree', 'add', '-q', '-b', branch, worktree])
  const sha = git(repo, ['rev-parse', 'HEAD']), retainedRef = 'refs/mousse/threads/task/main'; git(repo, ['update-ref', retainedRef, sha])
  const workspace = { schemaVersion: 1, threadId: 'task', worktreePath: worktree, branch, repositoryId, retainedRef, baseSha: sha, headSha: sha, integrationTarget: { baseSha: sha, checkoutPath: repo }, lifecycle: 'ready' }
  writeFileSync(join(location, 'workspace.json'), JSON.stringify(workspace))
  mkdirSync(join(location, 'journal'))
  writeFileSync(join(location, 'journal', '0000000000000001.json'), JSON.stringify({ schemaVersion: 1, sequence: 1, operationId: 'provision', operationType: 'workspace-provision', state: 'planned', expectedPreState: { branch, worktreePath: worktree } }))
  writeFileSync(join(location, 'journal', '0000000000000002.json'), JSON.stringify({ schemaVersion: 1, sequence: 2, operationId: 'provision', operationType: 'workspace-provision', state: 'completed' }))
  const coordinator = new ResourceLifecycleCoordinator(store, { drain: async () => {}, settleMutationOwnership: async () => {}, projectIndex: () => {}, projectPurged: () => {} })
  const clockState = { offset: 0 }
  const now = () => Date.now() + clockState.offset
  const clock = new StorageSweepClock(store.root, now); clock.start()
  const policy = new StoragePolicyStore(store, clock)
  const thread = { id: 'task', name: 'Task one', projectId: 'project-1', createdAt: OLD.toISOString(), ...options.thread }
  const service = new StorageCleanupService({
    store, threads: { getThread: (id) => id === 'task' ? thread as never : undefined }, purge: coordinator.cleanup, policy, clock,
    idle: options.idle ?? (() => undefined), installationHome: options.installationHome ?? home, codeHost: options.codeHost, now, measure: options.measure
  })
  const f = { root, home, location, repo, repositoryId, worktree, branch, sha, store, coordinator, clock, clockState, policy, service, thread, now }
  age(f)
  return f
}
type Fixture = ReturnType<typeof fixture>

/** Makes the thread look idle for 90 days: file times, the only time source here that is not injected. */
function age(f: Fixture) {
  for (const name of ['messages.json', 'workspace.json']) utimesSync(join(f.location, name), OLD, OLD)
}
function setPolicy(f: Fixture, patch: { worktrees?: Partial<StoragePolicy['worktrees']>; browser?: Partial<StoragePolicy['browser']> } = {}): StoragePolicy {
  const policy: StoragePolicy = {
    schemaVersion: 1,
    worktrees: { removeWithDeletedThreads: false, inactiveDays: null, removeMerged: false, ...patch.worktrees },
    browser: { captureDays: null, ...patch.browser }
  }
  return f.policy.configure(policy, true)
}
function updateWorkspace(f: Fixture, change: (workspace: Record<string, unknown>) => void) {
  const path = join(f.location, 'workspace.json'), workspace = JSON.parse(readFileSync(path, 'utf8')); change(workspace)
  writeFileSync(path, JSON.stringify(workspace))
}
/** A commit in the thread worktree, recorded in `workspace.json` the way a recorded operation would. */
function commit(f: Fixture, file = 'b.txt', content = 'second\n', record = true): string {
  writeFileSync(join(f.worktree, file), content); git(f.worktree, ['add', '.']); git(f.worktree, ['commit', '-q', '-m', file])
  const head = git(f.worktree, ['rev-parse', 'HEAD'])
  if (record) updateWorkspace(f, (workspace) => { workspace.headSha = head })
  age(f)
  return head
}
const defaultName = (f: Fixture) => git(f.repo, ['symbolic-ref', '--short', 'HEAD'])
/** origin/HEAD and origin/<default> at the current default tip, as a clone leaves them. */
function addRemote(f: Fixture) {
  const name = defaultName(f)
  git(f.repo, ['remote', 'add', 'origin', f.repo])
  git(f.repo, ['update-ref', `refs/remotes/origin/${name}`, git(f.repo, ['rev-parse', name])])
  git(f.repo, ['symbolic-ref', 'refs/remotes/origin/HEAD', `refs/remotes/origin/${name}`])
}
const item = (report: StorageCleanupReport, rule?: StorageCleanupItem['rule']) => report.items.find((entry) => entry.threadId === 'task' && (!rule || entry.rule === rule))
const manifestPath = (f: Fixture) => new WorktreeRetirementService(f.store).pathFor('task', f.worktree)
const inactive = (days = 30) => ({ worktrees: { inactiveDays: days } })

/** A trashed thread with plain task data, trashed long enough ago to be past a 30 day retention. */
async function trashed(f: Fixture, id: string, extra?: (location: string) => void) {
  const location = join(f.home, 'thread-data', id); mkdirSync(location, { recursive: true })
  writeFileSync(join(location, 'meta.json'), JSON.stringify({ id })); writeFileSync(join(location, 'messages.json'), '[]'); extra?.(location)
  f.store.registerTask({ taskId: id, location })
  await f.coordinator.trash({ taskId: id, operationId: `trash-${id}` })
  f.store.update(id, (record) => { record.trashedAt = new Date(Date.now() - 40 * DAY).toISOString() })
}
const enableTrash = (f: Fixture) => f.coordinator.cleanup.configure({ schemaVersion: 1, graceDays: 30, automaticPurge: true }, true)
const soleCopy = (id: string) => (location: string) => {
  mkdirSync(join(location, 'terminal-workspace')); writeFileSync(join(location, 'terminal-workspace', 'x.txt'), 'only copy')
  writeFileSync(join(location, 'terminal-workspace.json'), JSON.stringify({ schemaVersion: 1, kind: 'task-terminal-scratch', threadId: id, workspaceRelativePath: 'terminal-workspace' }))
}

describe('inactive rule', () => {
  it('removes a clean inactive worktree, keeps a recoverable manifest and a status note, and the thread restores', async () => {
    const f = fixture(); setPolicy(f, inactive())
    const report = await f.service.run('manual')
    expect(item(report)).toMatchObject({ rule: 'worktree-inactive', outcome: 'removed', label: 'Task one', projectId: 'project-1' })
    expect(report.counts).toMatchObject({ removed: 1, failed: 0 }); expect(report.bytesRecovered).toBeGreaterThan(0)
    expect(existsSync(f.worktree)).toBe(false); expect(existsSync(manifestPath(f))).toBe(true)
    expect(readCleanupMarker(f.store, 'task')).toMatchObject({ rule: 'worktree-inactive' })
    expect(f.service.lastReport()).toEqual(report)
    const restored = await new ThreadWorkspaceManager(f.location).restore(f.repo)
    expect(restored.lifecycle).toBe('ready'); expect(readFileSync(join(f.worktree, 'a.txt'), 'utf8').replace(/\r\n/g, '\n')).toBe('first\n')
  }, 60_000)

  it('leaves a thread that a rule retired deletable: the status note does not block its trash or purge', async () => {
    const f = fixture(); setPolicy(f, inactive())
    expect(item(await f.service.run('manual'))).toMatchObject({ outcome: 'removed' })
    expect(existsSync(cleanupMarkerPath(f.store, 'task'))).toBe(true)
    await f.coordinator.trash({ taskId: 'task', operationId: 'trash' })
    const preview = await f.coordinator.cleanup.preview('task')
    expect(preview.blockers).toEqual([]); expect(preview.items.some((entry) => entry.discardRequired)).toBe(false)
    const record = await f.coordinator.purge({ taskId: 'task', operationId: 'purge', expectedGeneration: preview.generation, previewDigest: preview.digest })
    expect(record.state).toBe('purged')
  }, 60_000)

  it('keeps a recent thread with the days it has been inactive', async () => {
    const f = fixture(); setPolicy(f, inactive())
    utimesSync(join(f.location, 'messages.json'), new Date(), new Date())
    const report = await f.service.run('manual')
    expect(item(report)).toMatchObject({ outcome: 'kept', reason: 'Inactive for 0 of 30 days' })
    expect(existsSync(f.worktree)).toBe(true); expect(report.counts.removed).toBe(0)
  }, 60_000)

  it('does not retire a worktree again an hour after it was restored', async () => {
    const f = fixture(); setPolicy(f, inactive())
    expect(item(await f.service.run('manual'))).toMatchObject({ outcome: 'removed' })
    await new ThreadWorkspaceManager(f.location).restore(f.repo) // rewrites workspace.json: activity
    f.clockState.offset += HOUR
    const report = await f.service.run('manual')
    expect(item(report)).toMatchObject({ outcome: 'kept', reason: 'Inactive for 0 of 30 days' })
    expect(existsSync(f.worktree)).toBe(true)
  }, 90_000)

  it('is not reset by settling, pinning or toggling a thread (updatedAt is not activity), and a settled thread is swept', async () => {
    const f = fixture({ thread: { updatedAt: new Date().toISOString(), pinnedAt: new Date().toISOString(), settledAt: new Date().toISOString() } }); setPolicy(f, inactive())
    expect(item(await f.service.run('manual'))).toMatchObject({ outcome: 'removed' })
  }, 60_000)

  it('keeps a worktree whose thread has pending work and says why', async () => {
    const f = fixture({ idle: () => 'A run is waiting to start' }); setPolicy(f, inactive())
    expect(item(await f.service.run('manual'))).toMatchObject({ outcome: 'kept', reason: 'A run is waiting to start' })
    expect(existsSync(f.worktree)).toBe(true)
  }, 60_000)

  it('keeps a worktree whose thread holds the execution lease', async () => {
    const f = fixture(); setPolicy(f, inactive())
    const lease = tryAcquireExecutionLease(f.location, { source: 'test' })!
    try { expect(item(await f.service.run('manual'))).toMatchObject({ outcome: 'kept', reason: 'Thread is in use' }) }
    finally { releaseExecutionLeaseHandle(lease) }
    expect(existsSync(f.worktree)).toBe(true)
  }, 60_000)

  it('keeps a worktree with an unfinished journal operation', async () => {
    const f = fixture(); setPolicy(f, inactive())
    writeFileSync(join(f.location, 'journal', '0000000000000003.json'), JSON.stringify({ schemaVersion: 1, sequence: 3, operationId: 'publish', operationType: 'publish', state: 'running' }))
    expect(item(await f.service.run('manual'))).toMatchObject({ outcome: 'kept', reason: 'Workspace has an unfinished operation' })
  }, 60_000)

  it('keeps a worktree outside the managed folder', async () => {
    const f = fixture({ installationHome: join(tmpdir(), 'somewhere-else') }); setPolicy(f, inactive())
    expect(item(await f.service.run('manual'))).toMatchObject({ outcome: 'kept', reason: 'Outside the managed worktree folder' })
  }, 60_000)

  it('keeps a worktree whose workspace has no integration target', async () => {
    const f = fixture(); setPolicy(f, inactive()); updateWorkspace(f, (workspace) => { delete workspace.integrationTarget }); age(f)
    expect(item(await f.service.run('manual'))).toMatchObject({ outcome: 'kept', reason: 'Integration target is unknown' })
    expect(existsSync(f.worktree)).toBe(true)
  }, 60_000)

  it('keeps a worktree when HEAD moved outside a recorded operation, and changes nothing', async () => {
    const f = fixture(); setPolicy(f, inactive())
    commit(f, 'b.txt', 'second\n', false)
    expect(item(await f.service.run('manual'))).toMatchObject({ outcome: 'kept', reason: 'Workspace HEAD moved outside a recorded operation' })
    expect(readFileSync(join(f.worktree, 'b.txt'), 'utf8')).toBe('second\n')
    expect(existsSync(manifestPath(f))).toBe(false); expect(existsSync(cleanupMarkerPath(f.store, 'task'))).toBe(false)
  }, 60_000)
})

describe('content gates', () => {
  it('keeps a clean inactive worktree with a local-only commit as unpublished, even with the inactive rule on', async () => {
    const f = fixture(); addRemote(f); setPolicy(f, inactive()); commit(f)
    expect(item(await f.service.run('manual'))).toMatchObject({ outcome: 'kept', reason: 'Has 1 unpublished commit' })
    expect(existsSync(f.worktree)).toBe(true)
  }, 60_000)

  it('keeps it as "Default branch is unavailable" with no default branch metadata', async () => {
    const f = fixture(); setPolicy(f, inactive()); commit(f)
    expect(item(await f.service.run('manual'))).toMatchObject({ outcome: 'kept', reason: expect.stringContaining('Default branch is unavailable; run `git remote set-head') })
  }, 60_000)

  it('keeps an untracked file', async () => {
    const f = fixture(); setPolicy(f, inactive()); writeFileSync(join(f.worktree, 'notes.txt'), 'mine')
    expect(item(await f.service.run('manual'))).toMatchObject({ outcome: 'kept', reason: 'Has uncommitted changes (1 file)' })
    expect(readFileSync(join(f.worktree, 'notes.txt'), 'utf8')).toBe('mine')
  }, 60_000)

  it('keeps an ignored file and names its path', async () => {
    const f = fixture(); setPolicy(f, inactive())
    commit(f, '.gitignore', 'cache.log\n'); writeFileSync(join(f.worktree, 'cache.log'), 'ignored')
    expect(item(await f.service.run('manual'))).toMatchObject({ outcome: 'kept', reason: 'Has ignored files (cache.log)' })
  }, 60_000)

  it('keeps a nested repository inside an ignored folder', async () => {
    const f = fixture(); setPolicy(f, inactive()); commit(f, '.gitignore', 'vendor/\n')
    const nested = join(f.worktree, 'vendor', 'dep'); mkdirSync(nested, { recursive: true }); git(nested, ['init', '-q']); writeFileSync(join(nested, 'work.txt'), 'only copy')
    expect(item(await f.service.run('manual'))).toMatchObject({ outcome: 'kept', reason: 'Contains another repository' })
    expect(readFileSync(join(nested, 'work.txt'), 'utf8')).toBe('only copy')
  }, 60_000)

  it('keeps a worktree directory replaced by a link or junction', async () => {
    const f = fixture(); setPolicy(f, inactive())
    const real = `${f.worktree}-real`; renameSync(f.worktree, real)
    symlinkSync(real, f.worktree, process.platform === 'win32' ? 'junction' : 'dir')
    try { expect(item(await f.service.run('manual'))).toMatchObject({ outcome: 'kept', reason: 'Worktree is a link' }) }
    finally { rmSync(f.worktree, { recursive: true, force: true }) }
    expect(existsSync(join(real, 'a.txt'))).toBe(true)
  }, 60_000)

  it('keeps a worktree whose repository folder is a junction or symlink to somewhere else', async () => {
    const f = fixture(); setPolicy(f, inactive())
    const repositories = join(f.home, 'repositories'), elsewhere = join(f.root, 'elsewhere')
    renameSync(repositories, elsewhere); symlinkSync(elsewhere, repositories, process.platform === 'win32' ? 'junction' : 'dir')
    try { expect(item(await f.service.run('manual'))).toMatchObject({ outcome: 'kept', reason: 'Outside the managed worktree folder' }) }
    finally { rmSync(repositories, { recursive: true, force: true }) }
    expect(existsSync(join(elsewhere, f.repositoryId, 'worktrees', 'threads', 'task', 'main', 'a.txt'))).toBe(true)
  }, 60_000)

  it('keeps the worktree with the Git error when the default branch cannot be read', async () => {
    const f = fixture(); setPolicy(f, { worktrees: { removeMerged: true } }); commit(f)
    updateWorkspace(f, (workspace) => { (workspace.integrationTarget as { checkoutPath: string }).checkoutPath = f.root }); age(f)
    const kept = item(await f.service.run('manual'))
    expect(kept).toMatchObject({ outcome: 'kept' }); expect(kept!.reason).toMatch(/not a git repository|fatal/i)
    expect(existsSync(f.worktree)).toBe(true)
  }, 60_000)
})

describe('merged rule', () => {
  it('keeps a fresh worktree with no commits as "No commits to merge yet"', async () => {
    const f = fixture(); addRemote(f); setPolicy(f, { worktrees: { removeMerged: true } })
    expect(item(await f.service.run('manual'))).toMatchObject({ outcome: 'kept', reason: 'No commits to merge yet' })
  }, 60_000)

  it('removes a commit merged into the local default branch only (unpushed, name from the GitHub cache)', async () => {
    const codeHost = { cachedDefaultBranch: vi.fn() }
    const f = fixture({ codeHost }); codeHost.cachedDefaultBranch.mockReturnValue(defaultName(f))
    setPolicy(f, { worktrees: { removeMerged: true } }); commit(f)
    git(f.repo, ['merge', '--ff-only', '-q', f.branch])
    expect(item(await f.service.run('manual'))).toMatchObject({ rule: 'worktree-merged', outcome: 'removed' })
    expect(codeHost.cachedDefaultBranch).toHaveBeenCalledWith(f.repo); expect(existsSync(f.worktree)).toBe(false)
  }, 60_000)

  it('removes a commit that only the remote-tracking default branch contains', async () => {
    const f = fixture(); addRemote(f); setPolicy(f, { worktrees: { removeMerged: true } })
    const head = commit(f)
    git(f.repo, ['update-ref', `refs/remotes/origin/${defaultName(f)}`, head])
    expect(item(await f.service.run('manual'))).toMatchObject({ rule: 'worktree-merged', outcome: 'removed' })
    expect(git(f.repo, ['rev-parse', defaultName(f)])).not.toBe(head)
  }, 60_000)

  it('keeps an unmerged commit', async () => {
    const f = fixture(); addRemote(f); setPolicy(f, { worktrees: { removeMerged: true } }); commit(f)
    expect(item(await f.service.run('manual'))).toMatchObject({ outcome: 'kept', reason: 'Has 1 unpublished commit' })
  }, 60_000)

  it('keeps a cherry-picked commit: only ancestry counts', async () => {
    const f = fixture(); addRemote(f); setPolicy(f, { worktrees: { removeMerged: true } }); const head = commit(f)
    writeFileSync(join(f.repo, 'other.txt'), 'other\n'); git(f.repo, ['add', '.']); git(f.repo, ['commit', '-q', '-m', 'other'])
    git(f.repo, ['cherry-pick', head])
    expect(git(f.repo, ['rev-parse', defaultName(f)])).not.toBe(head)
    expect(item(await f.service.run('manual'))).toMatchObject({ outcome: 'kept', reason: 'Has 1 unpublished commit' })
    expect(existsSync(f.worktree)).toBe(true)
  }, 60_000)

  it('keeps a thread merge commit that has the same parents as the default branch merge plus one extra file', async () => {
    const f = fixture(); addRemote(f); setPolicy(f, { worktrees: { removeMerged: true } })
    const name = defaultName(f)
    git(f.repo, ['checkout', '-q', '-b', 'side']); writeFileSync(join(f.repo, 'side.txt'), 'side\n'); git(f.repo, ['add', '.']); git(f.repo, ['commit', '-q', '-m', 'side'])
    git(f.repo, ['checkout', '-q', name]); writeFileSync(join(f.repo, 'main.txt'), 'main\n'); git(f.repo, ['add', '.']); git(f.repo, ['commit', '-q', '-m', 'main'])
    const mainTip = git(f.repo, ['rev-parse', 'HEAD'])
    git(f.repo, ['merge', '--no-ff', '-q', '-m', 'merge side', 'side'])
    git(f.repo, ['update-ref', `refs/remotes/origin/${name}`, git(f.repo, ['rev-parse', 'HEAD'])])
    git(f.worktree, ['merge', '--ff-only', '-q', mainTip])
    git(f.worktree, ['merge', '--no-commit', '--no-ff', 'side'])
    writeFileSync(join(f.worktree, 'extra.txt'), 'extra\n'); git(f.worktree, ['add', '.']); git(f.worktree, ['commit', '-q', '-m', 'merge side plus extra'])
    updateWorkspace(f, (workspace) => { workspace.headSha = git(f.worktree, ['rev-parse', 'HEAD']) }); age(f)
    expect(git(f.worktree, ['rev-list', '--count', `${f.sha}..HEAD`])).toBe('3')
    expect(item(await f.service.run('manual'))).toMatchObject({ outcome: 'kept', reason: 'Has 3 unpublished commits' })
    expect(readFileSync(join(f.worktree, 'extra.txt'), 'utf8').replace(/\r\n/g, '\n')).toBe('extra\n')
  }, 90_000)

  it('does not treat the primary checkout\'s current branch as the default branch', async () => {
    const f = fixture(); setPolicy(f, { worktrees: { removeMerged: true } }); const head = commit(f)
    git(f.repo, ['checkout', '-q', '-b', 'feature']); git(f.repo, ['merge', '--ff-only', '-q', head])
    expect(item(await f.service.run('manual'))).toMatchObject({ outcome: 'kept', reason: expect.stringContaining('Default branch is unavailable') })
    expect(existsSync(f.worktree)).toBe(true)
  }, 60_000)

  it('uses the cached default branch of the code host and never runs gh', async () => {
    const runExecutable = vi.fn().mockRejectedValue(new Error('gh must not run'))
    const codeHost = new GitHubCodeHost(runExecutable)
    const f = fixture({ codeHost }); setPolicy(f, { worktrees: { removeMerged: true } }); const head = commit(f)
    ;(codeHost as unknown as { defaultBranches: Map<string, string> }).defaultBranches.set(f.repo, defaultName(f))
    git(f.repo, ['merge', '--ff-only', '-q', head])
    expect(item(await f.service.run('manual'))).toMatchObject({ rule: 'worktree-merged', outcome: 'removed' })
    expect(runExecutable).not.toHaveBeenCalled()
  }, 60_000)
})

describe('leases and re-checks', () => {
  const holdRepository = (f: Fixture) => acquireRepositoryLease(resolveRepositoryIdentity(f.repo, { requireMutationCapability: true }))
  const cleanupHoldsThread = (f: Fixture) => vi.waitFor(() => expect(readLeaseOwner(getExecutionLeasePath(f.location))?.source).toBe('storage-cleanup'), { timeout: 20_000, interval: 20 })

  it('takes no lease during the scan phase: a terminal or turn started then gets the thread', async () => {
    const seen: boolean[] = []
    let location = ''
    const f = fixture({ idle: () => {
      const lease = tryAcquireExecutionLease(location, { source: 'pty.create' })
      seen.push(Boolean(lease)); if (lease) releaseExecutionLeaseHandle(lease)
      return undefined
    } })
    location = f.location; setPolicy(f, inactive())
    expect(item(await f.service.run('manual'))).toMatchObject({ outcome: 'removed' })
    // First call: the scan phase, no lease held. Second call: the re-check, where cleanup holds the thread.
    expect(seen[0]).toBe(true); expect(seen).toHaveLength(2)
  }, 60_000)

  it('holds the thread while it waits for the repository: a terminal is refused with the cleanup message and a turn waits for it', async () => {
    const f = fixture(); setPolicy(f, inactive())
    const repository = await holdRepository(f)
    let run: Promise<StorageCleanupReport>, turn: ReturnType<typeof waitAcquireExecutionLease>
    try {
      run = f.service.run('manual')
      await cleanupHoldsThread(f)
      expect(tryAcquireExecutionLease(f.location, { source: 'task-terminal' })).toBeNull()
      expect(leaseBusyMessage(readLeaseOwner(getExecutionLeasePath(f.location)), 'busy')).toBe('Cleanup is checking this thread; try again in a moment')
      expect(() => acquireExecutionLease(f.location, { source: 'orchestrator' })).toThrow('Cleanup is checking this thread; try again in a moment')
      turn = waitAcquireExecutionLease(f.location, { source: 'orchestrator', maxAttempts: 400 })
    } finally { repository.release() }
    expect(item(await run)).toMatchObject({ outcome: 'removed' })
    releaseExecutionLeaseHandle(await turn)
    expect(isExecutionLeaseHeld(f.location)).toBe(false)
  }, 60_000)

  it('keeps the worktree as "Repository is busy" when the repository lease does not come in two seconds', async () => {
    const f = fixture(); setPolicy(f, inactive())
    const repository = await holdRepository(f)
    try { expect(item(await f.service.run('manual'))).toMatchObject({ outcome: 'kept', reason: 'Repository is busy' }) }
    finally { repository.release() }
    expect(existsSync(f.worktree)).toBe(true); expect(isExecutionLeaseHeld(f.location)).toBe(false)
  }, 60_000)

  it('re-checks HEAD under the leases: a commit during lease acquisition keeps the checkout', async () => {
    const f = fixture(); setPolicy(f, inactive())
    const repository = await holdRepository(f)
    let run: Promise<StorageCleanupReport>
    try {
      run = f.service.run('manual'); await cleanupHoldsThread(f)
      writeFileSync(join(f.worktree, 'late.txt'), 'late\n'); git(f.worktree, ['add', '.']); git(f.worktree, ['commit', '-q', '-m', 'late'])
    } finally { repository.release() }
    expect(item(await run)).toMatchObject({ outcome: 'kept', reason: 'Commit changed since check' })
    expect(readFileSync(join(f.worktree, 'late.txt'), 'utf8').replace(/\r\n/g, '\n')).toBe('late\n')
  }, 60_000)

  it('re-checks the policy under the leases: a settings change during lease acquisition keeps the checkout', async () => {
    const f = fixture(); setPolicy(f, inactive())
    const repository = await holdRepository(f)
    let run: Promise<StorageCleanupReport>
    try {
      run = f.service.run('manual'); await cleanupHoldsThread(f)
      setPolicy(f, inactive(60))
    } finally { repository.release() }
    expect(item(await run)).toMatchObject({ outcome: 'kept', reason: 'Settings changed since check' })
    expect(existsSync(f.worktree)).toBe(true)
  }, 60_000)

  it('re-checks where the checkout is under the leases: one replaced by a link during lease acquisition is kept, and its target is not touched', async () => {
    const f = fixture(); setPolicy(f, inactive())
    const repository = await holdRepository(f)
    const real = `${f.worktree}-real`
    let run: Promise<StorageCleanupReport>
    try {
      run = f.service.run('manual'); await cleanupHoldsThread(f)
      renameSync(f.worktree, real); symlinkSync(real, f.worktree, process.platform === 'win32' ? 'junction' : 'dir')
    } finally { repository.release() }
    try { expect(item(await run)).toMatchObject({ outcome: 'kept', reason: 'Worktree is a link' }) }
    finally { rmSync(f.worktree, { recursive: true, force: true }) }
    expect(existsSync(join(real, 'a.txt'))).toBe(true); expect(existsSync(cleanupMarkerPath(f.store, 'task'))).toBe(false)
  }, 60_000)

  it('re-checks pending work under the leases', async () => {
    let busy = false
    const f = fixture({ idle: () => busy ? 'A turn is running' : undefined }); setPolicy(f, inactive())
    const repository = await holdRepository(f)
    let run: Promise<StorageCleanupReport>
    try { run = f.service.run('manual'); await cleanupHoldsThread(f); busy = true } finally { repository.release() }
    expect(item(await run)).toMatchObject({ outcome: 'kept', reason: 'Thread became busy' })
    expect(existsSync(f.worktree)).toBe(true)
  }, 60_000)

  it('keeps the worktree with the verifier\'s message when retirement refuses it', async () => {
    const f = fixture(); setPolicy(f, inactive())
    vi.spyOn(WorktreeRetirementService.prototype, 'retire').mockImplementation(() => { throw new Error('Workspace content changed after retirement preview') })
    expect(item(await f.service.run('manual'))).toMatchObject({ outcome: 'kept', reason: 'Workspace content changed after retirement preview' })
    expect(existsSync(cleanupMarkerPath(f.store, 'task'))).toBe(false); expect(isExecutionLeaseHeld(f.location)).toBe(false)
  }, 60_000)
})

describe('deleted threads and orphans', () => {
  it('a rule turned on after the thread was deleted retires its worktree; off leaves it', async () => {
    const f = fixture(); await f.coordinator.trash({ taskId: 'task', operationId: 'trash' })
    setPolicy(f, { worktrees: { removeWithDeletedThreads: false } })
    const idle = await f.service.run('manual')
    expect(existsSync(f.worktree)).toBe(true); expect(item(idle)).toBeUndefined()
    setPolicy(f, { worktrees: { removeWithDeletedThreads: true } })
    const report = await f.service.run('manual')
    expect(item(report)).toMatchObject({ rule: 'worktree-deleted', outcome: 'removed' }); expect(existsSync(f.worktree)).toBe(false)
  }, 60_000)

  it('ignores a trashed thread for the inactive and merged rules while the deleted-threads rule is off', async () => {
    const f = fixture(); await f.coordinator.trash({ taskId: 'task', operationId: 'trash' })
    setPolicy(f, { worktrees: { inactiveDays: 1, removeMerged: true, removeWithDeletedThreads: false } })
    const report = await f.service.run('manual')
    expect(report.items.filter((entry) => entry.rule !== 'worktree-orphan')).toEqual([])
    expect(existsSync(f.worktree)).toBe(true)
  }, 60_000)

  it('keeps a trashed thread\'s dirty worktree and reports why', async () => {
    const f = fixture(); writeFileSync(join(f.worktree, 'secret.txt'), 'only copy')
    await f.coordinator.trash({ taskId: 'task', operationId: 'trash' })
    setPolicy(f, { worktrees: { removeWithDeletedThreads: true } })
    expect(item(await f.service.run('manual'))).toMatchObject({ rule: 'worktree-deleted', outcome: 'kept', reason: expect.stringMatching(/^Checkout retained: /) })
    expect(readFileSync(join(f.worktree, 'secret.txt'), 'utf8')).toBe('only copy')
  }, 60_000)

  it('reports an orphan directory as kept and leaves it in place', async () => {
    const f = fixture(); setPolicy(f, inactive())
    const orphan = join(f.home, 'repositories', f.repositoryId, 'worktrees', 'threads', 'ghost', 'main'); mkdirSync(orphan, { recursive: true }); writeFileSync(join(orphan, 'file.txt'), 'who owns this')
    const report = await f.service.run('manual')
    expect(report.items.filter((entry) => entry.rule === 'worktree-orphan')).toEqual([expect.objectContaining({ outcome: 'kept', reason: 'No thread uses this worktree', label: 'threads/ghost' })])
    expect(readFileSync(join(orphan, 'file.txt'), 'utf8')).toBe('who owns this')
  }, 60_000)
})

describe('clock guard', () => {
  it('runs normally after an 8 hour sleep', async () => {
    const f = fixture(); setPolicy(f, inactive()); f.clockState.offset += 8 * HOUR
    const report = await f.service.run('manual')
    expect(report.suspended).toBeUndefined(); expect(report.clockNote).toBeUndefined(); expect(item(report)).toMatchObject({ outcome: 'removed' })
  }, 60_000)

  it('runs normally after a 25 hour forward jump and says so', async () => {
    const f = fixture(); setPolicy(f, inactive()); f.clockState.offset += 25 * HOUR
    const report = await f.service.run('manual')
    expect(report.suspended).toBeUndefined(); expect(report.clockNote).toBe('Clock moved forward by 25 h since the last run'); expect(item(report)).toMatchObject({ outcome: 'removed' })
  }, 60_000)

  it('suspends the time rules after a 10 minute backward jump, with automatic trash emptying off', async () => {
    const f = fixture(); setPolicy(f, inactive())
    f.clockState.offset -= 10 * 60_000
    const report = await f.service.run('manual')
    expect(report.suspended).toMatch(/^Paused after the system clock moved backwards/); expect(item(report)).toBeUndefined()
    expect(existsSync(f.worktree)).toBe(true); expect(f.service.clockSuspended()).toBe(true)
  }, 60_000)

  it('keeps the merged rule running while the clock is suspended: it reads no time', async () => {
    const f = fixture(); addRemote(f); setPolicy(f, { worktrees: { removeMerged: true } }); const head = commit(f)
    git(f.repo, ['update-ref', `refs/remotes/origin/${defaultName(f)}`, head])
    f.clockState.offset -= 10 * 60_000
    const report = await f.service.run('manual')
    expect(report.suspended).toBeDefined(); expect(item(report)).toMatchObject({ rule: 'worktree-merged', outcome: 'removed' })
  }, 60_000)

  it('resumes once the policy is saved, even after the clock was put back an hour', async () => {
    const f = fixture(); setPolicy(f, inactive()); f.clockState.offset -= HOUR
    expect((await f.service.run('manual')).suspended).toBeDefined()
    setPolicy(f, inactive()) // configure() resumes and re-samples the clock
    const report = await f.service.run('manual')
    expect(report.suspended).toBeUndefined(); expect(item(report)).toMatchObject({ outcome: 'removed' })
  }, 60_000)

  it('treats a daemon restarted after three days as normal', async () => {
    const f = fixture(); setPolicy(f, inactive()); f.clockState.offset += 3 * DAY
    const restartedClock = new StorageSweepClock(f.store.root, f.now); restartedClock.start()
    const restarted = new StorageCleanupService({ store: f.store, threads: { getThread: () => f.thread as never }, purge: f.coordinator.cleanup, policy: new StoragePolicyStore(f.store, restartedClock), clock: restartedClock, idle: () => undefined, installationHome: f.home, now: f.now })
    const report = await restarted.run('manual')
    expect(report.suspended).toBeUndefined(); expect(report.clockNote).toBeUndefined(); expect(item(report)).toMatchObject({ outcome: 'removed' })
  }, 60_000)

  it('keeps a suspension across a restart until the policy is saved', async () => {
    const f = fixture(); setPolicy(f, inactive()); f.clockState.offset -= HOUR
    expect((await f.service.run('manual')).suspended).toBeDefined()
    const restartedClock = new StorageSweepClock(f.store.root, f.now); restartedClock.start()
    expect(restartedClock.check()).toMatchObject({ suspended: true })
  }, 60_000)
})

describe('report', () => {
  it('returns a zero-count report when no rule applies', async () => {
    const f = fixture(); setPolicy(f)
    const report = await f.service.run('manual')
    expect(report.counts).toEqual({ removed: 0, kept: 0, failed: 0 }); expect(report.items).toEqual([]); expect(summarizeCleanupReport(report)).toBe('Nothing needed cleanup.')
  }, 60_000)

  it('marks a removal whose measurement ran out of budget as a lower bound ("at least")', async () => {
    const f = fixture({ measure: async () => ({ bytes: 4096, files: 1, estimated: false, partial: true }) }); setPolicy(f, inactive())
    const report = await f.service.run('manual')
    expect(item(report)).toMatchObject({ outcome: 'removed', bytesApproximate: true, bytesLowerBound: true })
    expect(report).toMatchObject({ bytesApproximate: true, bytesLowerBound: true }); expect(summarizeCleanupReport(report)).toMatch(/^Removed 1, kept 0, failed 0\. At least /)
  }, 60_000)

  it('marks a Windows logical-size estimate as approximate ("about"), not a lower bound', async () => {
    const f = fixture({ measure: (root, options) => measureTree(root, { ...options, platform: 'win32' }) }); setPolicy(f, inactive())
    const report = await f.service.run('manual')
    expect(item(report)).toMatchObject({ outcome: 'removed', bytesApproximate: true }); expect(item(report)!.bytesLowerBound).toBeUndefined()
    expect(report.bytesApproximate).toBe(true); expect(report.bytesLowerBound).toBeUndefined(); expect(summarizeCleanupReport(report)).toMatch(/About /)
  }, 60_000)

  it('sorts failed, removed, then kept and caps the list with an omitted count', async () => {
    const f = fixture(); enableTrash(f); setPolicy(f, { worktrees: { inactiveDays: 30 } })
    const agents = join(f.home, 'repositories', f.repositoryId, 'worktrees', 'agents')
    for (let index = 0; index < REPORT_ENTRY_LIMIT + 5; index++) { mkdirSync(join(agents, `orphan-${index}`), { recursive: true }); writeFileSync(join(agents, `orphan-${index}`, 'f.txt'), 'x') }
    await trashed(f, 'boom')
    const purge = f.coordinator.cleanup.purge.bind(f.coordinator.cleanup)
    vi.spyOn(f.coordinator.cleanup, 'purge').mockImplementation(async (input) => { if (typeof input !== 'string' && input.taskId === 'boom') throw new Error('disk is locked'); return purge(input as never) })
    const report = await f.service.run('manual')
    expect(report.items).toHaveLength(REPORT_ENTRY_LIMIT)
    expect(report.items.map((entry) => entry.outcome).slice(0, 2)).toEqual(['failed', 'removed'])
    expect(report.items.at(-1)!.outcome).toBe('kept')
    expect(report.counts.kept).toBeGreaterThanOrEqual(REPORT_ENTRY_LIMIT + 5)
    expect(report.omittedCount).toBe(report.counts.removed + report.counts.kept + report.counts.failed - REPORT_ENTRY_LIMIT)
  }, 120_000)
})

describe('scheduling', () => {
  it('coalesces concurrent runs into one', async () => {
    const f = fixture(); setPolicy(f, inactive())
    const first = f.service.run('manual'), second = f.service.run('schedule'), third = f.service.run('manual')
    expect(second).toBe(first); expect(third).toBe(first)
    const report = await first
    expect(report.trigger).toBe('manual'); expect(item(report)).toMatchObject({ outcome: 'removed' })
    const next = f.service.run('manual'); expect(next).not.toBe(first); await next
  }, 60_000)

  it('does not replace the last report with an empty hourly run when no rule is on', async () => {
    const f = fixture(); setPolicy(f, inactive()); await f.service.run('manual')
    const manual = f.service.lastReport()
    setPolicy(f, { worktrees: { removeWithDeletedThreads: false } })
    const scheduled = await f.service.run('schedule')
    expect(scheduled.counts).toEqual({ removed: 0, kept: 0, failed: 0 }); expect(f.service.lastReport()).toEqual(manual)
  }, 90_000)

  it('stop() clears the timers: neither the first run nor a policy-change run happens afterwards', async () => {
    const f = fixture(); setPolicy(f, inactive())
    vi.useFakeTimers()
    try {
      f.service.start(); f.service.scheduleAfterPolicyChange()
      await f.service.stop()
      await vi.advanceTimersByTimeAsync(2 * HOUR)
    } finally { vi.useRealTimers() }
    expect(f.service.lastReport()).toBeNull(); expect(existsSync(f.worktree)).toBe(true)
  }, 60_000)

  it('runs 5 minutes after start and an hour later, and a minute after a policy change', async () => {
    const f = fixture(); setPolicy(f, inactive())
    const run = vi.spyOn(f.service, 'run').mockResolvedValue({} as never)
    vi.useFakeTimers()
    try {
      f.service.start()
      await vi.advanceTimersByTimeAsync(5 * 60_000 - 1); expect(run).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1); expect(run).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(HOUR); expect(run).toHaveBeenCalledTimes(2)
      f.service.scheduleAfterPolicyChange(); f.service.scheduleAfterPolicyChange()
      await vi.advanceTimersByTimeAsync(60_000); expect(run).toHaveBeenCalledTimes(3)
      await f.service.stop()
    } finally { vi.useRealTimers() }
  }, 60_000)
})

describe('trash through the storage run', () => {
  it('a manual run attempts each overdue record exactly once, whether purged, kept or failed, and returns', async () => {
    const f = fixture(); rmSync(join(f.location, 'workspace.json')); enableTrash(f); setPolicy(f)
    await trashed(f, 'ok-1'); await trashed(f, 'ok-2'); await trashed(f, 'sole', soleCopy('sole')); await trashed(f, 'boom')
    const previews: string[] = []
    const preview = f.coordinator.cleanup.preview.bind(f.coordinator.cleanup)
    vi.spyOn(f.coordinator.cleanup, 'preview').mockImplementation(async (taskId: string) => { previews.push(taskId); return preview(taskId) })
    const purge = f.coordinator.cleanup.purge.bind(f.coordinator.cleanup)
    vi.spyOn(f.coordinator.cleanup, 'purge').mockImplementation(async (input) => { if (input.taskId === 'boom') throw new Error('disk is locked'); return purge(input) })
    const report = await f.service.run('manual')
    const byId = Object.fromEntries(report.items.filter((entry) => entry.rule === 'trash').map((entry) => [entry.threadId, entry]))
    expect(byId['ok-1']).toMatchObject({ outcome: 'removed' }); expect(byId['ok-2']).toMatchObject({ outcome: 'removed' })
    expect(byId.sole).toMatchObject({ outcome: 'kept' }); expect(byId.boom).toMatchObject({ outcome: 'failed', reason: 'disk is locked' })
    expect([...previews].sort()).toEqual(['boom', 'ok-1', 'ok-2', 'sole'])
    expect(f.store.require('ok-1').state).toBe('purged')
  }, 120_000)

  it('records that stay retained finish the run with one kept item each, and a later run may try them again', async () => {
    const f = fixture(); rmSync(join(f.location, 'workspace.json')); enableTrash(f); setPolicy(f)
    await trashed(f, 'keep-1', soleCopy('keep-1')); await trashed(f, 'keep-2', soleCopy('keep-2'))
    const previews: string[] = []
    const preview = f.coordinator.cleanup.preview.bind(f.coordinator.cleanup)
    vi.spyOn(f.coordinator.cleanup, 'preview').mockImplementation(async (taskId: string) => { previews.push(taskId); return preview(taskId) })
    const first = await f.service.run('manual')
    expect(first.items.filter((entry) => entry.rule === 'trash')).toHaveLength(2); expect([...previews].sort()).toEqual(['keep-1', 'keep-2'])
    await f.service.run('manual'); expect(previews).toHaveLength(4)
  }, 120_000)

  it('a scheduled run purges at most five overdue records and the next one continues', async () => {
    const f = fixture(); rmSync(join(f.location, 'workspace.json')); enableTrash(f); setPolicy(f)
    for (let index = 0; index < 7; index++) await trashed(f, `t-${index}`)
    const first = await f.service.run('schedule')
    expect(first.items.filter((entry) => entry.rule === 'trash' && entry.outcome === 'removed')).toHaveLength(5)
    const second = await f.service.run('schedule')
    expect(second.items.filter((entry) => entry.rule === 'trash' && entry.outcome === 'removed')).toHaveLength(2)
  }, 180_000)

  it('says automatic emptying is off once, only when records are past retention', async () => {
    const f = fixture(); rmSync(join(f.location, 'workspace.json')); setPolicy(f)
    expect((await f.service.run('manual')).items.filter((entry) => entry.rule === 'trash')).toEqual([])
    await trashed(f, 'old-1'); await trashed(f, 'old-2')
    const report = await f.service.run('manual')
    expect(report.items.filter((entry) => entry.rule === 'trash')).toEqual([expect.objectContaining({ outcome: 'kept', reason: 'Automatic trash emptying is off', label: '2 threads in the trash' })])
  }, 90_000)

  it('stops a manual drain when the trash clock is suspended', async () => {
    const f = fixture(); rmSync(join(f.location, 'workspace.json')); enableTrash(f); setPolicy(f)
    await trashed(f, 'late-1')
    writeFileSync(join(f.store.root, 'trash-clock.json'), JSON.stringify({ highWater: Date.now(), suspended: true }))
    const report = await f.service.run('manual')
    expect(report.items.find((entry) => entry.rule === 'trash')).toMatchObject({ outcome: 'kept', reason: expect.stringContaining('paused') })
    expect(f.store.require('late-1').state).toBe('trashed')
  }, 60_000)
})

describe('plan', () => {
  const noRecord = (f: Fixture) => {
    const names = readdirSync(f.store.root)
    expect(names).not.toContain('storage-cleanup-last-run.json'); expect(names).not.toContain('storage-cleanup-history.jsonl')
  }

  it('is a dry run: it names what would be removed with its size and changes nothing', async () => {
    const f = fixture(); setPolicy(f, inactive())
    const plan = await f.service.plan()
    expect(plan).toEqual([expect.objectContaining({ rule: 'worktree-inactive', threadId: 'task', projectId: 'project-1', label: 'Task one', action: 'remove', reason: expect.stringMatching(/^Inactive for \d+ days$/), bytes: expect.any(Number) })])
    expect(plan[0]!.bytes).toBeGreaterThan(0)
    expect(existsSync(f.worktree)).toBe(true); expect(existsSync(cleanupMarkerPath(f.store, 'task'))).toBe(false); expect(isExecutionLeaseHeld(f.location)).toBe(false); noRecord(f)
  }, 60_000)

  it('names the reason for a worktree it would keep, and the plan agrees with the run that follows', async () => {
    const f = fixture(); setPolicy(f, inactive()); writeFileSync(join(f.worktree, 'draft.txt'), 'unsaved')
    expect(await f.service.plan()).toEqual([expect.objectContaining({ action: 'keep', bytes: 0, reason: 'Has uncommitted changes (1 file)' })])
    expect(item(await f.service.run('manual'))).toMatchObject({ outcome: 'kept', reason: 'Has uncommitted changes (1 file)' })
  }, 60_000)

  it('lists overdue trash it would empty and the record it would keep, and empties nothing', async () => {
    const f = fixture(); rmSync(join(f.location, 'workspace.json')); enableTrash(f); setPolicy(f)
    await trashed(f, 'ok-1'); await trashed(f, 'sole', soleCopy('sole'))
    const plan = (await f.service.plan()).filter((entry) => entry.rule === 'trash')
    expect(plan.find((entry) => entry.threadId === 'ok-1')).toMatchObject({ action: 'remove', reason: 'Retention passed' })
    expect(plan.find((entry) => entry.threadId === 'sole')).toMatchObject({ action: 'keep', bytes: 0 })
    expect(f.store.require('ok-1').state).toBe('trashed'); expect(f.store.require('sole').state).toBe('trashed'); noRecord(f)
  }, 120_000)

  it('lists the worktree of a deleted thread it would remove', async () => {
    const f = fixture(); await f.coordinator.trash({ taskId: 'task', operationId: 'trash' })
    setPolicy(f, { worktrees: { removeWithDeletedThreads: true } })
    expect(await f.service.plan()).toEqual([expect.objectContaining({ rule: 'worktree-deleted', threadId: 'task', action: 'remove', reason: 'Thread was deleted' })])
    expect(existsSync(f.worktree)).toBe(true); noRecord(f)
  }, 60_000)
})

describe('record of removals', () => {
  it('appends every removal to a history that a later run, and the replaced last-run report, do not erase', async () => {
    const f = fixture(); setPolicy(f, inactive())
    const first = await f.service.run('manual')
    expect(item(first)).toMatchObject({ outcome: 'removed' })
    const later = await f.service.run('schedule')
    expect(later.counts).toEqual({ removed: 0, kept: 0, failed: 0 }); expect(f.service.lastReport()).toEqual(later)
    const lines = readFileSync(join(f.store.root, 'storage-cleanup-history.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    expect(lines).toEqual([expect.objectContaining({ at: first.completedAt, trigger: 'manual', rule: 'worktree-inactive', threadId: 'task', projectId: 'project-1', label: 'Task one', bytes: item(first)!.bytes, reason: expect.stringMatching(/^Inactive for /) })])
  }, 90_000)

  it('records nothing for a worktree it kept', async () => {
    const f = fixture(); setPolicy(f, inactive()); writeFileSync(join(f.worktree, 'draft.txt'), 'unsaved')
    await f.service.run('manual')
    expect(existsSync(join(f.store.root, 'storage-cleanup-history.jsonl'))).toBe(false)
  }, 60_000)

  it('keeps the newest lines once the history grows past its limit', async () => {
    const f = fixture(); setPolicy(f, inactive())
    const path = join(f.store.root, 'storage-cleanup-history.jsonl')
    writeFileSync(path, Array.from({ length: 12_000 }, (_, index) => JSON.stringify({ n: index, pad: 'x'.repeat(100) })).join('\n') + '\n')
    await f.service.run('manual')
    const lines = readFileSync(path, 'utf8').trim().split('\n')
    expect(lines.length).toBeLessThan(2_100); expect(JSON.parse(lines.at(-1)!)).toMatchObject({ threadId: 'task' }); expect(JSON.parse(lines[0]!).n).toBeGreaterThan(9_000)
  }, 60_000)
})

describe('storage defaults', () => {
  it('ships every time-based and merged rule off', () => {
    expect(STORAGE_POLICY_DEFAULTS).toEqual({ schemaVersion: 1, worktrees: { removeWithDeletedThreads: true, inactiveDays: null, removeMerged: false }, browser: { captureDays: null } })
  })
})
