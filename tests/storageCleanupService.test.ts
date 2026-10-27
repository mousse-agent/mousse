import { afterEach, describe, expect, it, vi } from 'vitest'
import { execSync, spawn, type ChildProcess } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, relative, sep } from 'node:path'
import { ScopedArtifactWriter } from '../src/browser-worker/artifacts'
import { REPORT_ENTRY_LIMIT, STORAGE_POLICY_DEFAULTS, summarizeCleanupReport, type StorageCleanupItem, type StorageCleanupReport, type StoragePolicy } from '../src/shared/storage'
import { measureTree } from '../src/mms/lifecycle/diskMeasure'
import { GitHubCodeHost } from '../src/mms/git/GitHubCodeHost'
import { acquireRepositoryLease } from '../src/mms/git/RepositoryLease'
import { resolveRepositoryIdentity } from '../src/mms/git/RepositoryIdentity'
import { ResourceLifecycleCoordinator } from '../src/mms/lifecycle/ResourceLifecycleCoordinator'
import { ResourceLifecycleStore } from '../src/mms/lifecycle/ResourceLifecycleStore'
import { cleanupMarkerPath, findNestedRepository, readCleanupMarker, StorageCleanupService } from '../src/mms/lifecycle/StorageCleanupService'
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
  probeRemoval?: (worktreePath: string) => string | undefined
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
    idle: options.idle ?? (() => undefined), installationHome: options.installationHome ?? home, codeHost: options.codeHost, now, measure: options.measure, probeRemoval: options.probeRemoval
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
  // Committed 90 days ago, like the file times, so the commit is not the recent activity that keeps a worktree.
  writeFileSync(join(f.worktree, file), content); git(f.worktree, ['add', '.']); process.env.GIT_COMMITTER_DATE = OLD.toISOString()
  try { git(f.worktree, ['commit', '-q', '-m', file]) } finally { delete process.env.GIT_COMMITTER_DATE }
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

  it('keeps a nested repository inside an ignored folder, for the ignored files, without walking it', async () => {
    const f = fixture(); setPolicy(f, inactive()); commit(f, '.gitignore', 'vendor/\n')
    const nested = join(f.worktree, 'vendor', 'dep'); mkdirSync(nested, { recursive: true }); git(nested, ['init', '-q']); writeFileSync(join(nested, 'work.txt'), 'only copy')
    expect(item(await f.service.run('manual'))).toMatchObject({ outcome: 'kept', reason: 'Has ignored files (vendor/)' })
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
    expect(item(await f.service.run('manual'))).toMatchObject({ rule: 'worktree-deleted', outcome: 'kept', reason: 'Has uncommitted changes (1 file)' })
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

/** Every file under `dir` with its content, so a test can prove that nothing was written. */
function treeContents(dir: string, out: Record<string, string> = {}, base = dir): Record<string, string> {
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) treeContents(path, out, base)
    else out[path.slice(base.length)] = readFileSync(path, 'utf8')
  }
  return out
}
/** Lifecycle store, thread data and every Git ref of the repository: what a dry run must leave exactly as it found it. */
const writtenState = (f: Fixture) => JSON.stringify({ store: treeContents(f.store.root), location: treeContents(f.location), refs: git(f.repo, ['for-each-ref']) })
const holdRepositoryLease = (f: Fixture) => acquireRepositoryLease(resolveRepositoryIdentity(f.repo, { requireMutationCapability: true }))
const junctionType = process.platform === 'win32' ? 'junction' : 'dir'
/** `<installation>/repositories` replaced by a junction to a folder outside the installation. */
function relocateRepositories(f: Fixture): { repositories: string; elsewhere: string; external: string } {
  const repositories = join(f.home, 'repositories'), elsewhere = join(f.root, 'elsewhere')
  renameSync(repositories, elsewhere); symlinkSync(elsewhere, repositories, junctionType)
  return { repositories, elsewhere, external: join(elsewhere, f.repositoryId, 'worktrees', 'threads', 'task', 'main', 'a.txt') }
}

describe('deleted threads follow the same keep rules as live ones', () => {
  const deleteRule = (f: Fixture) => setPolicy(f, { worktrees: { removeWithDeletedThreads: true } })

  it('keeps a worktree under a repository folder that is a junction to somewhere else, and its target is untouched', async () => {
    const f = fixture(); await f.coordinator.trash({ taskId: 'task', operationId: 'trash' }); deleteRule(f)
    const { repositories, external } = relocateRepositories(f)
    try { expect(item(await f.service.run('manual'))).toMatchObject({ rule: 'worktree-deleted', outcome: 'kept', reason: 'Outside the managed worktree folder' }) }
    finally { rmSync(repositories, { recursive: true, force: true }) }
    expect(existsSync(external)).toBe(true)
  }, 60_000)

  it('checks the location again under the cleanup reservation and repository lease: a folder swapped for a junction in between is not removed', async () => {
    const f = fixture(); await f.coordinator.trash({ taskId: 'task', operationId: 'trash' }); deleteRule(f)
    const repository = await holdRepositoryLease(f)
    let run: Promise<StorageCleanupReport>, moved: ReturnType<typeof relocateRepositories> | undefined
    try {
      run = f.service.run('manual')
      await vi.waitFor(() => expect(f.store.require('task').cleanupOwner).toBeDefined(), { timeout: 20_000, interval: 20 })
      moved = relocateRepositories(f)
    } finally { repository.release() }
    try { expect(item(await run)).toMatchObject({ rule: 'worktree-deleted', outcome: 'kept' }) }
    finally { rmSync(moved!.repositories, { recursive: true, force: true }) }
    expect(existsSync(moved!.external)).toBe(true)
  }, 60_000)

  it('keeps a worktree with a commit that is not in the default branch, with no upstream and no default branch metadata', async () => {
    const f = fixture(); commit(f); await f.coordinator.trash({ taskId: 'task', operationId: 'trash' }); deleteRule(f)
    expect(item(await f.service.run('manual'))).toMatchObject({ rule: 'worktree-deleted', outcome: 'kept', reason: expect.stringContaining('Default branch is unavailable') })
    expect(existsSync(join(f.worktree, 'b.txt'))).toBe(true)
  }, 60_000)

  it('keeps a squash-merged branch as unpublished: only ancestry counts', async () => {
    const f = fixture(); const squashed = commit(f); addRemote(f)
    writeFileSync(join(f.repo, 'b.txt'), 'second\n'); git(f.repo, ['add', '.']); git(f.repo, ['commit', '-q', '-m', 'squash of the thread']);
    git(f.repo, ['update-ref', `refs/remotes/origin/${defaultName(f)}`, git(f.repo, ['rev-parse', 'HEAD'])])
    expect(git(f.repo, ['rev-parse', 'HEAD'])).not.toBe(squashed)
    await f.coordinator.trash({ taskId: 'task', operationId: 'trash' }); deleteRule(f)
    expect(item(await f.service.run('manual'))).toMatchObject({ rule: 'worktree-deleted', outcome: 'kept', reason: 'Has 1 unpublished commit' })
  }, 60_000)

  it('removes a merged one, and the immediate removal when a thread is deleted applies the same rules', async () => {
    const f = fixture(); const head = commit(f); addRemote(f); git(f.repo, ['update-ref', `refs/remotes/origin/${defaultName(f)}`, head])
    await f.coordinator.trash({ taskId: 'task', operationId: 'trash' }); deleteRule(f)
    expect(await f.service.retireDeletedWorktree('task')).toMatchObject({ rule: 'worktree-deleted', outcome: 'removed' })
    expect(existsSync(f.worktree)).toBe(false)
  }, 60_000)

  it('the immediate removal keeps an unpublished commit, and a thread that is not deleted is not touched', async () => {
    const f = fixture(); commit(f); deleteRule(f)
    expect(await f.service.retireDeletedWorktree('task')).toBeUndefined()
    await f.coordinator.trash({ taskId: 'task', operationId: 'trash' })
    expect(await f.service.retireDeletedWorktree('task')).toMatchObject({ outcome: 'kept', reason: expect.stringContaining('Default branch is unavailable') })
    expect(existsSync(f.worktree)).toBe(true)
  }, 60_000)

  it('uses the policy it started with: one saved while the run is measuring keeps the checkout', async () => {
    let saved = false
    const f: Fixture = fixture({ measure: async (root, options) => { if (!saved) { saved = true; setPolicy(f) } return measureTree(root, options) } })
    await f.coordinator.trash({ taskId: 'task', operationId: 'trash' }); deleteRule(f)
    expect(item(await f.service.run('manual'))).toMatchObject({ rule: 'worktree-deleted', outcome: 'kept', reason: expect.stringContaining('Settings changed since check') })
    expect(existsSync(f.worktree)).toBe(true)
  }, 60_000)

  it('does not read and hash a kept worktree again on every run, until something about it changes', async () => {
    // The idle lookup runs after the memo lookup and before any Git or file reading, so its call count shows how often the worktree was examined.
    const idle = vi.fn(() => undefined)
    const f = fixture({ idle }); appendFileSync(join(f.repo, '.git', 'info', 'exclude'), 'cache/\n')
    mkdirSync(join(f.worktree, 'cache')); writeFileSync(join(f.worktree, 'cache', 'a.log'), 'ignored')
    await f.coordinator.trash({ taskId: 'task', operationId: 'trash' }); deleteRule(f)
    expect(item(await f.service.run('manual'))).toMatchObject({ outcome: 'kept', reason: 'Has ignored files (cache/)' })
    expect(idle).toHaveBeenCalledTimes(1)
    for (let run = 0; run < 3; run++) expect(item(await f.service.run('manual'))).toMatchObject({ outcome: 'kept', reason: 'Has ignored files (cache/)' })
    expect(idle).toHaveBeenCalledTimes(1)
    // Clearing the folder changes the worktree, so the next run looks again and removes it.
    rmSync(join(f.worktree, 'cache'), { recursive: true, force: true })
    expect(item(await f.service.run('manual'))).toMatchObject({ outcome: 'removed' })
    expect(idle).toHaveBeenCalledTimes(2)
  }, 90_000)

  it('reports a busy thread or profile as kept, not failed', async () => {
    let busy: string | undefined = 'A turn is running'
    const f = fixture({ idle: () => busy }); await f.coordinator.trash({ taskId: 'task', operationId: 'trash' }); deleteRule(f)
    expect(item(await f.service.run('manual'))).toMatchObject({ outcome: 'kept', reason: 'A turn is running' })
    busy = undefined
    vi.spyOn(f.coordinator.cleanup, 'retireTrashed').mockRejectedValue(new Error('Cannot trash thread: profile requests are still active'))
    const report = await f.service.run('manual')
    expect(item(report)).toMatchObject({ outcome: 'kept', reason: 'Cannot trash thread: profile requests are still active' }); expect(report.counts.failed).toBe(0)
  }, 60_000)
})

describe('plan writes nothing', () => {
  it('leaves the lifecycle records, manifests, thread data and Git refs exactly as they were, with a deleted thread and overdue trash both present', async () => {
    const f = fixture(); enableTrash(f); await f.coordinator.trash({ taskId: 'task', operationId: 'trash' })
    f.store.update('task', (record) => { record.trashedAt = new Date(Date.now() - 40 * DAY).toISOString() })
    setPolicy(f, { worktrees: { removeWithDeletedThreads: true, inactiveDays: 30, removeMerged: true } })
    const before = writtenState(f)
    const plan = await f.service.plan()
    expect(writtenState(f)).toBe(before)
    expect(git(f.repo, ['for-each-ref', 'refs/mousse/lifecycle'])).toBe('')
    expect(f.store.require('task').cleanupOwner).toBeUndefined()
    expect(plan.find((entry) => entry.rule === 'worktree-deleted')).toMatchObject({ threadId: 'task', action: 'remove' })
    expect(plan.find((entry) => entry.rule === 'trash')).toMatchObject({ threadId: 'task' })
    expect(existsSync(f.worktree)).toBe(true)
  }, 120_000)

  it('does not stop a real run that follows: nothing is reserved while it runs', async () => {
    const f = fixture(); await f.coordinator.trash({ taskId: 'task', operationId: 'trash' }); setPolicy(f, { worktrees: { removeWithDeletedThreads: true } })
    const [plan, report] = await Promise.all([f.service.plan(), f.service.run('manual')])
    expect(plan).toBeDefined(); expect(item(report)).toMatchObject({ rule: 'worktree-deleted', outcome: 'removed' })
  }, 60_000)

  it('matches a run: unclaimed directories, the note when automatic emptying is off, and a suspended clock', async () => {
    const f = fixture(); rmSync(join(f.location, 'workspace.json')); setPolicy(f, inactive())
    const orphan = join(f.home, 'repositories', f.repositoryId, 'worktrees', 'threads', 'ghost', 'main'); mkdirSync(orphan, { recursive: true }); writeFileSync(join(orphan, 'file.txt'), 'who owns this')
    await trashed(f, 'old-1')
    f.clockState.offset = -4 * HOUR // The clock moved back: a run would suspend the time rules.
    const before = writtenState(f)
    const plan = await f.service.plan()
    expect(writtenState(f)).toBe(before); expect(existsSync(join(f.store.root, 'storage-clock.json'))).toBe(false) // peeking does not persist the suspension
    expect(plan).toEqual(expect.arrayContaining([
      expect.objectContaining({ rule: 'worktree-orphan', label: 'threads/ghost', action: 'keep', reason: 'No thread uses this worktree' }),
      expect.objectContaining({ rule: 'trash', action: 'keep', reason: 'Automatic trash emptying is off' }),
      expect.objectContaining({ label: 'Time-based rules', action: 'keep', reason: expect.stringContaining('clock moved backwards') })
    ]))
  }, 90_000)
})

describe('a manual run asked for during a scheduled one', () => {
  it('follows it as its own full run, and repeated requests share it', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let first = true
    const f = fixture({ measure: async (root, options) => { if (first) { first = false; await gate } return measureTree(root, options) } })
    setPolicy(f, inactive())
    const scheduled = f.service.run('schedule'), manual = f.service.run('manual'), again = f.service.run('manual')
    expect(manual).not.toBe(scheduled); expect(again).toBe(manual); expect(f.service.run('schedule')).toBe(scheduled)
    release()
    const [a, b] = await Promise.all([scheduled, manual])
    expect(a.trigger).toBe('schedule'); expect(b.trigger).toBe('manual')
    expect(item(a)).toMatchObject({ outcome: 'removed' })
  }, 60_000)
})

describe('use after the check', () => {
  it('re-checks inactivity under the leases: a thread used during lease acquisition is kept', async () => {
    const f = fixture(); setPolicy(f, inactive())
    const repository = await holdRepositoryLease(f)
    let run: Promise<StorageCleanupReport>
    try {
      run = f.service.run('manual')
      await vi.waitFor(() => expect(readLeaseOwner(getExecutionLeasePath(f.location))?.source).toBe('storage-cleanup'), { timeout: 20_000, interval: 20 })
      const used = new Date(); utimesSync(join(f.location, 'messages.json'), used, used)
    } finally { repository.release() }
    expect(item(await run)).toMatchObject({ outcome: 'kept', reason: 'Thread was used since check' })
    expect(existsSync(f.worktree)).toBe(true)
  }, 60_000)

  it('leaves a merged worktree alone for a day after it was restored or changed, then removes it', async () => {
    const f = fixture(); addRemote(f); setPolicy(f, { worktrees: { removeMerged: true } })
    const head = commit(f); git(f.repo, ['update-ref', `refs/remotes/origin/${defaultName(f)}`, head])
    const touched = new Date(); utimesSync(join(f.location, 'workspace.json'), touched, touched)
    expect(item(await f.service.run('manual'))).toMatchObject({ outcome: 'kept', reason: 'Used within the last day' })
    age(f)
    expect(item(await f.service.run('manual'))).toMatchObject({ rule: 'worktree-merged', outcome: 'removed' })
  }, 90_000)
})

describe.runIf(process.platform === 'win32')('files in use block a removal that would stop partway', () => {
  /** A process whose working directory is inside the worktree, which is what stops Git from deleting it. */
  async function holdFolder(f: Fixture): Promise<{ child: ChildProcess; release: () => Promise<void> }> {
    // The commit counts as published, so only where the files are decides the outcome.
    addRemote(f); mkdirSync(join(f.worktree, 'sub')); const head = commit(f, 'sub/x.txt', 'x\n')
    git(f.repo, ['update-ref', `refs/remotes/origin/${defaultName(f)}`, head])
    f.clockState.offset = 60 * DAY // The commit is recent; the thread is judged 60 days later.
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: join(f.worktree, 'sub'), stdio: 'ignore', windowsHide: true })
    await new Promise<void>((resolve, reject) => { child.once('spawn', () => resolve()); child.once('error', reject) })
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
    return { child, release: async () => { child.kill(); await exited } }
  }
  const history = (f: Fixture) => readFileSync(join(f.store.root, 'storage-cleanup-history.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line))

  it('checks before removing: a folder a process is working in is kept as in use, untouched', async () => {
    const f = fixture(); setPolicy(f, inactive())
    const held = await holdFolder(f)
    try {
      expect(item(await f.service.run('manual'))).toMatchObject({ outcome: 'kept', reason: 'Files in this worktree are in use' })
      expect(existsSync(join(f.worktree, '.git'))).toBe(true); expect(existsSync(join(f.worktree, 'a.txt'))).toBe(true)
      expect(existsSync(join(f.store.root, 'storage-cleanup-history.jsonl'))).toBe(false); expect(isExecutionLeaseHeld(f.location)).toBe(false)
    } finally { await held.release() }
  }, 90_000)

  it('reports a removal Git stopped partway as failed, records it, and the next restore sets the leftover aside and rebuilds', async () => {
    const f = fixture({ probeRemoval: () => undefined }); setPolicy(f, inactive())
    const held = await holdFolder(f)
    try {
      const report = await f.service.run('manual')
      expect(item(report)).toMatchObject({ outcome: 'failed', reason: expect.stringContaining('partly removed') })
      expect(report.counts).toMatchObject({ failed: 1, removed: 0 })
      expect(existsSync(f.worktree)).toBe(true); expect(existsSync(join(f.worktree, '.git'))).toBe(false)
      expect(history(f)).toEqual([expect.objectContaining({ outcome: 'failed', rule: 'worktree-inactive', threadId: 'task' })])
      // Later runs say what is wrong instead of failing on "not a git repository".
      expect(item(await f.service.run('manual'))).toMatchObject({ outcome: 'kept', reason: expect.stringContaining('partly removed') })
    } finally { await held.release() }
    const restored = await new ThreadWorkspaceManager(f.location).restore(f.repo)
    expect(restored.lifecycle).toBe('ready')
    expect(readFileSync(join(f.worktree, 'sub', 'x.txt'), 'utf8').replace(/\r\n/g, '\n')).toBe('x\n'); expect(existsSync(join(f.worktree, '.git'))).toBe(true)
    expect(readdirSync(join(f.worktree, '..')).filter((name) => name.startsWith('main.partial-'))).toEqual([])
  }, 120_000)

  it('keeps a leftover it cannot prove is only retained content next to the rebuilt checkout', async () => {
    const f = fixture({ probeRemoval: () => undefined }); setPolicy(f, inactive())
    const held = await holdFolder(f)
    try { await f.service.run('manual'); writeFileSync(join(f.worktree, 'sub', 'mine.txt'), 'not from the repository') } finally { await held.release() }
    await new ThreadWorkspaceManager(f.location).restore(f.repo)
    const aside = readdirSync(join(f.worktree, '..')).filter((name) => name.startsWith('main.partial-'))
    expect(aside).toHaveLength(1); expect(readFileSync(join(f.worktree, '..', aside[0]!, 'sub', 'mine.txt'), 'utf8')).toBe('not from the repository')
  }, 120_000)
})

describe('restore leaves a folder alone that is not a failed retirement', () => {
  it('a folder without .git whose retirement had finished is still refused, untouched', async () => {
    const f = fixture(); setPolicy(f, inactive())
    expect(item(await f.service.run('manual'))).toMatchObject({ outcome: 'removed' })
    mkdirSync(f.worktree); writeFileSync(join(f.worktree, 'mine.txt'), 'someone else')
    await expect(new ThreadWorkspaceManager(f.location).restore(f.repo)).rejects.toThrow('Workspace recovery is blocked')
    expect(readFileSync(join(f.worktree, 'mine.txt'), 'utf8')).toBe('someone else')
  }, 60_000)
})

// ---- Browser captures ----

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

type SessionStates = Map<string, { open: boolean; threadId?: string }>
interface CaptureOptions {
  /** Ids of sessions that are still open. */
  open?: string[]
  /** Full control over what the browser reports about its sessions. */
  sessions?: (staleBefore: number) => SessionStates
  measure?: typeof measureTree
  removeFile?: (path: string) => void
  configured?: boolean
  /** The profile home is reached through a link (a moved home or a mapped drive): `<root>/linked/profile`, where `linked` is a junction to `<root>/real`. */
  linkedHome?: boolean
  /** A thread the cleanup service can name. */
  thread?: { id: string; name: string; projectId: string; createdAt: string }
}

/** A profile with no worktrees: just the lifecycle store, the policy, the clock and the capture folder. */
function captureFixture(options: CaptureOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), 'mousse-captures-')); roots.push(root)
  let base = root
  if (options.linkedHome) {
    mkdirSync(join(root, 'real')); symlinkSync(join(root, 'real'), join(root, 'linked'), junctionType)
    base = join(root, 'linked')
  }
  const home = join(base, 'profile'); mkdirSync(home, { recursive: true })
  const store = new ResourceLifecycleStore({ profileId: 'test', profileHome: home })
  registerThreadLifecycleGate(home, store)
  const coordinator = new ResourceLifecycleCoordinator(store, { drain: async () => {}, settleMutationOwnership: async () => {}, projectIndex: () => {}, projectPurged: () => {} })
  const clockState = { offset: 0 }
  const now = () => Date.now() + clockState.offset
  const clock = new StorageSweepClock(store.root, now); clock.start()
  const policy = new StoragePolicyStore(store, clock)
  const workerRoot = join(home, 'browser', 'worker-artifacts'), profileDir = join(workerRoot, 'test')
  const sessions = options.sessions ?? (() => new Map(((options.open ?? []).map((id) => [id, { open: true }] as const))) as SessionStates)
  const service = new StorageCleanupService({
    store, threads: { getThread: (id) => options.thread && id === options.thread.id ? options.thread as never : undefined }, purge: coordinator.cleanup, policy, clock, idle: () => undefined, installationHome: home, now,
    measure: options.measure, removeFile: options.removeFile,
    ...(options.configured === false ? {} : { browserCaptures: { workerArtifactRoot: workerRoot, sessions } })
  })
  return { root, home, store, clock, clockState, policy, service, workerRoot, profileDir, now }
}
type CaptureFixture = ReturnType<typeof captureFixture>

/** A file in a session folder, last written `ageDays` ago. */
function capture(f: CaptureFixture, session: string, name: string, ageDays: number, content = 'png bytes'): string {
  const dir = join(f.profileDir, session); mkdirSync(dir, { recursive: true })
  const path = join(dir, name); writeFileSync(path, content)
  const time = new Date(Date.now() - ageDays * DAY); utimesSync(path, time, time)
  return path
}
const setCaptureDays = (f: CaptureFixture, captureDays: number | null) => f.policy.configure({ schemaVersion: 1, worktrees: { removeWithDeletedThreads: false, inactiveDays: null, removeMerged: false }, browser: { captureDays } }, true)
const captureItems = (report: StorageCleanupReport) => report.items.filter((entry) => entry.rule === 'browser-capture')
const captureHistory = (f: CaptureFixture) => readFileSync(join(f.store.root, 'storage-cleanup-history.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line))

describe('browser capture rule', () => {
  it('deletes captures older than the policy days, with and without an extension, and keeps newer ones', async () => {
    const f = captureFixture(); setCaptureDays(f, 30)
    const withExtension = capture(f, 'session-a', `art_${uuid(1)}.png`, 40), withoutExtension = capture(f, 'session-a', `art_${uuid(2)}`, 31), recent = capture(f, 'session-a', `art_${uuid(3)}.png`, 5)
    const report = await f.service.run('manual')
    expect(existsSync(withExtension)).toBe(false); expect(existsSync(withoutExtension)).toBe(false); expect(existsSync(recent)).toBe(true)
    expect(captureItems(report)).toEqual([expect.objectContaining({ rule: 'browser-capture', label: 'Browser session session-a', outcome: 'removed', files: 2, reason: '2 captures older than 30 days' })])
    expect(captureItems(report)[0]!.bytes).toBeGreaterThan(0)
    expect(report.counts).toMatchObject({ removed: 1, kept: 0, failed: 0 }); expect(report.bytesRecovered).toBe(captureItems(report)[0]!.bytes)
  })

  it('reads the retention from the policy: 7 days deletes a 10 day old capture that 30 days keeps, and off deletes nothing', async () => {
    const f = captureFixture(); const old = capture(f, 'session-a', `art_${uuid(1)}.png`, 10)
    setCaptureDays(f, 30); expect((await f.service.run('manual')).counts).toEqual({ removed: 0, kept: 0, failed: 0 }); expect(existsSync(old)).toBe(true)
    setCaptureDays(f, null); expect(captureItems(await f.service.run('manual'))).toEqual([]); expect(existsSync(old)).toBe(true)
    setCaptureDays(f, 7); expect(captureItems(await f.service.run('manual'))).toEqual([expect.objectContaining({ outcome: 'removed' })]); expect(existsSync(old)).toBe(false)
  })

  it('removes a session folder that the deletion emptied and leaves the capture folders above it', async () => {
    const f = captureFixture(); setCaptureDays(f, 30)
    capture(f, 'session-a', `art_${uuid(1)}.png`, 40); capture(f, 'session-b', `art_${uuid(2)}.png`, 40)
    capture(f, 'session-b', `art_${uuid(3)}.png`, 1)
    await f.service.run('manual')
    expect(existsSync(join(f.profileDir, 'session-a'))).toBe(false); expect(existsSync(join(f.profileDir, 'session-b', `art_${uuid(3)}.png`))).toBe(true)
    expect(existsSync(f.profileDir)).toBe(true); expect(existsSync(f.workerRoot)).toBe(true)
  })

  it('leaves every other file alone, however old: not named like a capture, a different extension shape, or not a file', async () => {
    const f = captureFixture(); setCaptureDays(f, 30)
    const others = ['actions.jsonl', 'notes.png', 'art_not-a-uuid.png', `art_${uuid(4)}.png.bak`, `ART_${uuid(5)}.png`, `art_${uuid(6)}.toolongextension1`, `art_${uuid(10)}.pdf`, `art_${uuid(11)}.pdf.download`, `art_${uuid(12)}.png.download`, `copy_${uuid(7)}.png`].map((name) => capture(f, 'session-a', name, 90))
    const folder = join(f.profileDir, 'session-a', `art_${uuid(8)}.png`); mkdirSync(folder); writeFileSync(join(folder, 'inner.txt'), 'inside a folder named like a capture')
    const old = new Date(Date.now() - 90 * DAY); utimesSync(folder, old, old)
    const report = await f.service.run('manual')
    for (const path of others) expect(existsSync(path), path).toBe(true)
    expect(readFileSync(join(folder, 'inner.txt'), 'utf8')).toBe('inside a folder named like a capture')
    expect(captureItems(report)).toEqual([]); expect(report.counts).toEqual({ removed: 0, kept: 0, failed: 0 })
  })

  it('skips a session that is still open, says so, and still cleans the closed ones', async () => {
    const f = captureFixture({ open: ['session-open'] }); setCaptureDays(f, 30)
    const live = capture(f, 'session-open', `art_${uuid(1)}.png`, 90), closed = capture(f, 'session-closed', `art_${uuid(2)}.png`, 90)
    const report = await f.service.run('manual')
    expect(existsSync(live)).toBe(true); expect(existsSync(closed)).toBe(false)
    expect(captureItems(report)).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'Browser session session-open', outcome: 'kept', reason: 'Session is not closed', bytes: 0 }),
      expect.objectContaining({ label: 'Browser session session-closed', outcome: 'removed' })
    ]))
  })

  it('deletes nothing when the open sessions cannot be read', async () => {
    const f = captureFixture({ sessions: () => { throw new Error('Browser automation inventory is corrupt') } }); setCaptureDays(f, 30)
    const old = capture(f, 'session-a', `art_${uuid(1)}.png`, 90)
    const report = await f.service.run('manual')
    expect(existsSync(old)).toBe(true); expect(captureItems(report)).toEqual([expect.objectContaining({ outcome: 'kept', reason: expect.stringContaining('could not be read') })])
  })

  it('touches nothing outside the worker capture folder: the artifact store and its index, other profiles and neighbouring folders', async () => {
    const f = captureFixture(); setCaptureDays(f, 30)
    const old = (path: string) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, 'kept'); const time = new Date(Date.now() - 90 * DAY); utimesSync(path, time, time); return path }
    const indexed = old(join(f.home, 'artifacts', uuid(1), 'blob')), metadata = old(join(f.home, 'artifacts', uuid(1), 'meta.json'))
    const index = old(join(f.home, 'browser', 'artifact-index', `${uuid(1)}.json`))
    const otherProfile = old(join(f.workerRoot, 'other-profile', 'session-a', `art_${uuid(2)}.png`))
    const userData = old(join(f.home, 'browser', 'user-data', 'session-a', `art_${uuid(3)}.png`))
    const directlyInProfile = old(join(f.profileDir, `art_${uuid(4)}.png`)), tooDeep = old(join(f.profileDir, 'session-a', 'nested', `art_${uuid(5)}.png`))
    const inside = capture(f, 'session-a', `art_${uuid(6)}.png`, 90)
    await f.service.run('manual')
    for (const path of [indexed, metadata, index, otherProfile, userData, directlyInProfile, tooDeep]) expect(existsSync(path), path).toBe(true)
    expect(existsSync(inside)).toBe(false)
  })

  it('does nothing without a configured capture folder, and when no capture folder exists yet', async () => {
    const unconfigured = captureFixture({ configured: false }); setCaptureDays(unconfigured, 30)
    const old = capture(unconfigured, 'session-a', `art_${uuid(1)}.png`, 90)
    expect(captureItems(await unconfigured.service.run('manual'))).toEqual([]); expect(existsSync(old)).toBe(true)
    const empty = captureFixture(); setCaptureDays(empty, 30)
    expect((await empty.service.run('manual')).counts).toEqual({ removed: 0, kept: 0, failed: 0 })
  })
})

describe('browser capture rule never follows links', () => {
  const external = (f: CaptureFixture) => {
    const folder = join(f.root, 'elsewhere'); mkdirSync(folder, { recursive: true })
    const path = join(folder, `art_${uuid(9)}.png`); writeFileSync(path, 'outside'); const time = new Date(Date.now() - 90 * DAY); utimesSync(path, time, time)
    return { folder, path }
  }

  it('skips a session folder that is a link and leaves its target alone', async () => {
    const f = captureFixture(); setCaptureDays(f, 30); const target = external(f)
    mkdirSync(f.profileDir, { recursive: true }); symlinkSync(target.folder, join(f.profileDir, 'session-link'), junctionType)
    const real = capture(f, 'session-real', `art_${uuid(1)}.png`, 90)
    const report = await f.service.run('manual')
    expect(existsSync(target.path)).toBe(true); expect(existsSync(real)).toBe(false)
    expect(captureItems(report)).toEqual([expect.objectContaining({ label: 'Browser session session-real', outcome: 'removed' })])
  })

  it('keeps everything when the profile folder, the capture folder or a folder above it is a link', async () => {
    for (const link of ['profile', 'root', 'ancestor'] as const) {
      const f = captureFixture(); setCaptureDays(f, 30); const target = external(f)
      const place = link === 'profile' ? f.profileDir : link === 'root' ? f.workerRoot : join(f.home, 'browser')
      const moved = join(f.root, `moved-${link}`)
      const inside = capture(f, 'session-a', `art_${uuid(1)}.png`, 90)
      renameSync(place, moved); symlinkSync(moved, place, junctionType)
      const report = await f.service.run('manual')
      expect(existsSync(inside.replace(place, moved)), link).toBe(true); expect(existsSync(target.path), link).toBe(true)
      expect(captureItems(report), link).toEqual([expect.objectContaining({ outcome: 'kept', reason: 'Outside the browser capture folder' })])
    }
  })

  it('does not delete through a file link', async () => {
    const f = captureFixture(); setCaptureDays(f, 30); const target = external(f)
    const link = join(f.profileDir, 'session-a', `art_${uuid(1)}.png`); mkdirSync(join(link, '..'), { recursive: true })
    try { symlinkSync(target.path, link, 'file') } catch { return } // Creating a file link needs a privilege on Windows.
    const report = await f.service.run('manual')
    expect(existsSync(target.path)).toBe(true); expect(captureItems(report)).toEqual([])
  })

  it('checks the session folder again right before deleting: one swapped for a link during the measurement is not followed', async () => {
    let swapped = false
    const moved = (f: CaptureFixture) => join(f.root, 'moved-session')
    const holder: { f?: CaptureFixture } = {}
    const f = captureFixture({ measure: async (path, options) => {
      if (!swapped) { swapped = true; const dir = join(holder.f!.profileDir, 'session-a'); renameSync(dir, moved(holder.f!)); symlinkSync(moved(holder.f!), dir, junctionType) }
      return measureTree(path, options)
    } })
    holder.f = f; setCaptureDays(f, 30)
    const inside = capture(f, 'session-a', `art_${uuid(1)}.png`, 90)
    const report = await f.service.run('manual')
    expect(existsSync(join(moved(f), basename(inside)))).toBe(true)
    expect(captureItems(report)).toEqual([expect.objectContaining({ outcome: 'failed', reason: 'The capture folder changed while it was being cleaned' })])
  })

  // An ancestor swapped for a link to a different folder that holds a file of the same name: a check that only
  // compares a folder with its current parent would pass, and the delete would land outside the capture folder.
  it.each(['profile folder', 'capture folder', 'browser folder'] as const)('stops when the %s is swapped for a link to another folder during the measurement, and that folder is untouched', async (level) => {
    const holder: { f?: CaptureFixture; external?: string; moved?: string } = {}
    let swapped = false
    const f = captureFixture({ measure: async (path, options) => {
      if (!swapped) {
        swapped = true
        const place = level === 'profile folder' ? holder.f!.profileDir : level === 'capture folder' ? holder.f!.workerRoot : join(holder.f!.home, 'browser')
        renameSync(place, holder.moved!); symlinkSync(holder.external!, place, junctionType)
      }
      return measureTree(path, options)
    } })
    holder.f = f; setCaptureDays(f, 30)
    const place = level === 'profile folder' ? f.profileDir : level === 'capture folder' ? f.workerRoot : join(f.home, 'browser')
    const inside = capture(f, 'session-a', `art_${uuid(1)}.png`, 90)
    holder.moved = join(f.root, 'moved'); holder.external = join(f.root, 'elsewhere')
    const lookalike = join(holder.external, relative(place, inside)); mkdirSync(join(lookalike, '..'), { recursive: true }); writeFileSync(lookalike, 'outside')
    const old = new Date(Date.now() - 90 * DAY); utimesSync(lookalike, old, old)
    const report = await f.service.run('manual')
    expect(existsSync(lookalike), level).toBe(true); expect(existsSync(join(lookalike, '..')), level).toBe(true)
    expect(existsSync(join(holder.moved, relative(place, inside))), level).toBe(true)
    expect(captureItems(report), level).toEqual([expect.objectContaining({ outcome: 'failed', reason: 'The capture folder changed while it was being cleaned' })])
    expect(report.bytesRecovered).toBe(0)
  })
})

/** The short 8.3 form of a path on Windows, or the path itself when the volume has no short names. */
function shortPath(path: string): string {
  try { return execSync(`for %I in ("${path}") do @echo %~sI`, { shell: 'cmd.exe', encoding: 'utf8' }).trim() || path } catch { return path }
}

describe('browser capture rule with a link above the profile home', () => {
  it('still deletes: the capture folder and the home are compared as canonical paths', async () => {
    const f = captureFixture({ linkedHome: true }); setCaptureDays(f, 30)
    expect(f.home).toContain(`${sep}linked${sep}`) // The raw path reaches the home through the link; the store's home is the resolved one.
    expect(f.store.profileHome).not.toContain(`${sep}linked${sep}`)
    const old = capture(f, 'session-a', `art_${uuid(1)}.png`, 90), recent = capture(f, 'session-a', `art_${uuid(2)}.png`, 1)
    const report = await f.service.run('manual')
    expect(existsSync(old)).toBe(false); expect(existsSync(recent)).toBe(true)
    expect(captureItems(report)).toEqual([expect.objectContaining({ outcome: 'removed', files: 1 })])
  })

  it('and the dry run lists the same session', async () => {
    const f = captureFixture({ linkedHome: true }); setCaptureDays(f, 30); capture(f, 'session-a', `art_${uuid(1)}.png`, 90)
    expect((await f.service.plan()).filter((entry) => entry.rule === 'browser-capture')).toEqual([expect.objectContaining({ action: 'remove', label: 'Browser session session-a' })])
  })

  it('still refuses a link inside the capture tree when the home is reached through a link', async () => {
    const f = captureFixture({ linkedHome: true }); setCaptureDays(f, 30)
    const inside = capture(f, 'session-a', `art_${uuid(1)}.png`, 90)
    const moved = join(f.root, 'moved-browser'); renameSync(join(f.home, 'browser'), moved); symlinkSync(moved, join(f.home, 'browser'), junctionType)
    const report = await f.service.run('manual')
    expect(existsSync(join(moved, relative(join(f.home, 'browser'), inside)))).toBe(true)
    expect(captureItems(report)).toEqual([expect.objectContaining({ outcome: 'kept', reason: 'Outside the browser capture folder' })])
  })

  it.runIf(process.platform === 'win32')('still deletes when the capture folder is given as an 8.3 short path', async () => {
    const f = captureFixture(); setCaptureDays(f, 30)
    const short = shortPath(f.root)
    if (short.toLowerCase() === f.root.toLowerCase()) return // This volume has no short names, so there is no such path to test.
    const old = capture(f, 'session-a', `art_${uuid(1)}.png`, 90)
    const shortRoot = join(short, 'profile', 'browser', 'worker-artifacts')
    const service = new StorageCleanupService({ store: f.store, threads: { getThread: () => undefined }, purge: new ResourceLifecycleCoordinator(f.store, { drain: async () => {}, settleMutationOwnership: async () => {}, projectIndex: () => {}, projectPurged: () => {} }).cleanup, policy: f.policy, clock: f.clock, idle: () => undefined, installationHome: f.home, now: f.now, browserCaptures: { workerArtifactRoot: shortRoot, sessions: () => new Map() } })
    const report = await service.run('manual')
    expect(existsSync(old)).toBe(false); expect(captureItems(report)).toEqual([expect.objectContaining({ outcome: 'removed' })])
  })
})

describe('browser capture rule and the rest of the run', () => {
  it('records each deletion in the history, and a later empty run does not erase it', async () => {
    const f = captureFixture(); setCaptureDays(f, 30); capture(f, 'session-a', `art_${uuid(1)}.png`, 90)
    const first = await f.service.run('manual')
    const later = await f.service.run('schedule')
    expect(later.counts).toEqual({ removed: 0, kept: 0, failed: 0 }); expect(f.service.lastReport()).toEqual(later)
    expect(captureHistory(f)).toEqual([expect.objectContaining({ at: first.completedAt, trigger: 'manual', rule: 'browser-capture', label: 'Browser session session-a', outcome: 'removed', bytes: captureItems(first)[0]!.bytes, reason: '1 capture older than 30 days' })])
  })

  it('records nothing for a session it kept', async () => {
    const f = captureFixture({ open: ['session-a'] }); setCaptureDays(f, 30); capture(f, 'session-a', `art_${uuid(1)}.png`, 90)
    await f.service.run('manual')
    expect(existsSync(join(f.store.root, 'storage-cleanup-history.jsonl'))).toBe(false)
  })

  it('reports the captures in the dry run, deletes nothing, and the run that follows does what the plan said', async () => {
    const f = captureFixture({ open: ['session-open'] }); setCaptureDays(f, 30)
    const closed = capture(f, 'session-closed', `art_${uuid(1)}.png`, 90), live = capture(f, 'session-open', `art_${uuid(2)}.png`, 90)
    const plan = await f.service.plan()
    expect(plan).toEqual(expect.arrayContaining([
      expect.objectContaining({ rule: 'browser-capture', label: 'Browser session session-closed', action: 'remove', reason: '1 capture older than 30 days', bytes: expect.any(Number) }),
      expect.objectContaining({ rule: 'browser-capture', label: 'Browser session session-open', action: 'keep', reason: 'Session is not closed', bytes: 0 })
    ]))
    expect(plan.find((entry) => entry.label === 'Browser session session-closed')!.bytes).toBeGreaterThan(0)
    expect(existsSync(closed)).toBe(true); expect(existsSync(live)).toBe(true)
    const names = readdirSync(f.store.root); expect(names).not.toContain('storage-cleanup-last-run.json'); expect(names).not.toContain('storage-cleanup-history.jsonl')
    const report = await f.service.run('manual')
    expect(captureItems(report).map((entry) => [entry.label, entry.outcome])).toEqual(expect.arrayContaining([['Browser session session-closed', 'removed'], ['Browser session session-open', 'kept']]))
    expect(existsSync(closed)).toBe(false)
  })

  it('waits while the clock is suspended, in a run and in the plan, and resumes when the policy is saved', async () => {
    const f = captureFixture(); setCaptureDays(f, 30)
    const old = capture(f, 'session-a', `art_${uuid(1)}.png`, 90)
    f.clockState.offset -= 10 * 60_000
    expect((await f.service.plan()).filter((entry) => entry.rule === 'browser-capture')).toEqual([])
    const report = await f.service.run('manual')
    expect(report.suspended).toMatch(/^Paused after the system clock moved backwards/); expect(captureItems(report)).toEqual([]); expect(existsSync(old)).toBe(true)
    setCaptureDays(f, 30) // Saving the policy resumes the time-based rules.
    expect(captureItems(await f.service.run('manual'))).toEqual([expect.objectContaining({ outcome: 'removed' })]); expect(existsSync(old)).toBe(false)
  })

  it('does not count a capture dated in the future after the clock moved back', async () => {
    const f = captureFixture(); setCaptureDays(f, 30)
    const future = capture(f, 'session-a', `art_${uuid(1)}.png`, -10)
    expect(captureItems(await f.service.run('manual'))).toEqual([]); expect(existsSync(future)).toBe(true)
  })

  it('uses the policy it started with: one saved while a session is being measured stops the deletion', async () => {
    const holder: { f?: CaptureFixture } = {}
    let first = true
    const f = captureFixture({ measure: async (path, options) => { if (first) { first = false; setCaptureDays(holder.f!, null) } return measureTree(path, options) } })
    holder.f = f; setCaptureDays(f, 30)
    const a = capture(f, 'session-a', `art_${uuid(1)}.png`, 90), b = capture(f, 'session-b', `art_${uuid(2)}.png`, 90)
    const report = await f.service.run('manual')
    expect(existsSync(a)).toBe(true); expect(existsSync(b)).toBe(true)
    expect(captureItems(report)).toEqual([expect.objectContaining({ outcome: 'kept', reason: 'Settings changed since check' })])
  })

  it('marks a measurement that ran out of budget as approximate in the item and the report', async () => {
    const f = captureFixture({ measure: async (path, options) => ({ ...(await measureTree(path, options)), partial: true }) }); setCaptureDays(f, 30)
    capture(f, 'session-a', `art_${uuid(1)}.png`, 90)
    const report = await f.service.run('manual')
    expect(captureItems(report)[0]).toMatchObject({ outcome: 'removed', bytesApproximate: true }); expect(report.bytesApproximate).toBe(true)
  })
})

describe('browser capture files that cannot be deleted', () => {
  const busy = (code: string) => Object.assign(new Error(`${code}: resource busy or locked`), { code })

  it('keeps a capture another process holds open, retries it on the next run, and deletes the others', async () => {
    let locked: string | undefined
    const f = captureFixture({ removeFile: (path) => { if (path === locked) throw busy('EBUSY'); unlinkSync(path) } }); setCaptureDays(f, 30)
    locked = capture(f, 'session-a', `art_${uuid(1)}.png`, 90); const free = capture(f, 'session-a', `art_${uuid(2)}.png`, 90)
    const report = await f.service.run('manual')
    expect(existsSync(locked)).toBe(true); expect(existsSync(free)).toBe(false)
    expect(captureItems(report)).toEqual(expect.arrayContaining([
      expect.objectContaining({ outcome: 'removed', files: 1 }),
      expect.objectContaining({ outcome: 'kept', bytes: 0, reason: '1 capture in use; tried again on the next run' })
    ]))
    expect(report.counts).toMatchObject({ removed: 1, kept: 1, failed: 0 }); expect(existsSync(join(f.profileDir, 'session-a'))).toBe(true)
    expect(captureHistory(f)).toEqual([expect.objectContaining({ outcome: 'removed' })]) // The kept one is not a deletion.
    locked = undefined
    expect(captureItems(await f.service.run('manual'))).toEqual([expect.objectContaining({ outcome: 'removed', files: 1 })])
    expect(existsSync(join(f.profileDir, 'session-a'))).toBe(false)
  })

  it('reports any other deletion error as failed, counts no space for the file, and records it', async () => {
    const f = captureFixture({ removeFile: () => { throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' }) } }); setCaptureDays(f, 30)
    const old = capture(f, 'session-a', `art_${uuid(1)}.png`, 90)
    const report = await f.service.run('manual')
    expect(existsSync(old)).toBe(true); expect(report.counts).toMatchObject({ removed: 0, failed: 1 }); expect(report.bytesRecovered).toBe(0)
    expect(captureItems(report)).toEqual([expect.objectContaining({ outcome: 'failed', reason: 'EIO: i/o error' })])
    expect(captureHistory(f)).toEqual([expect.objectContaining({ outcome: 'failed', rule: 'browser-capture' })])
  })

  it('treats a capture that vanished before its turn as already gone', async () => {
    const f = captureFixture({ removeFile: (path) => { unlinkSync(path); throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) } }); setCaptureDays(f, 30)
    capture(f, 'session-a', `art_${uuid(1)}.png`, 90)
    expect((await f.service.run('manual')).counts).toEqual({ removed: 0, kept: 0, failed: 0 })
  })

  /** A process that opens the file with no sharing, which is what makes Windows refuse to delete it. */
  describe.runIf(process.platform === 'win32')('on Windows', () => {
    let child: ChildProcess | undefined
    afterEach(async () => {
      if (!child) return
      const exited = new Promise<void>((resolve) => child!.once('exit', () => resolve()))
      child.kill(); await exited; child = undefined
    })
    async function lockFile(path: string): Promise<void> {
      const script = `$stream = [System.IO.File]::Open('${path.replace(/'/g, "''")}', 'Open', 'Read', 'None'); [Console]::Out.WriteLine('locked'); [Console]::Out.Flush(); Start-Sleep -Seconds 600`
      child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
      await new Promise<void>((resolve, reject) => {
        child!.once('error', reject); child!.once('exit', () => reject(new Error('The lock holder exited early')))
        child!.stdout!.on('data', (chunk: Buffer) => { if (chunk.toString().includes('locked')) resolve() })
      })
    }

    it('keeps a capture that a process has open without sharing, deletes its neighbours, and deletes it once the process lets go', async () => {
      const f = captureFixture(); setCaptureDays(f, 30)
      const locked = capture(f, 'session-a', `art_${uuid(1)}.png`, 90), free = capture(f, 'session-a', `art_${uuid(2)}.png`, 90)
      await lockFile(locked)
      const report = await f.service.run('manual')
      expect(existsSync(locked)).toBe(true); expect(existsSync(free)).toBe(false)
      expect(captureItems(report)).toEqual(expect.arrayContaining([
        expect.objectContaining({ outcome: 'removed', files: 1 }),
        expect.objectContaining({ outcome: 'kept', reason: '1 capture in use; tried again on the next run' })
      ]))
      expect(report.counts).toMatchObject({ failed: 0 })
      const exited = new Promise<void>((resolve) => child!.once('exit', () => resolve()))
      child!.kill(); await exited; child = undefined
      expect(captureItems(await f.service.run('manual'))).toEqual([expect.objectContaining({ outcome: 'removed', files: 1 })])
      expect(existsSync(locked)).toBe(false)
    }, 60_000)
  })
})

describe('browser downloads are not captures', () => {
  it('keeps what the worker writes for a download, deletes the screenshot beside it, and keeps older downloads that kept their own extension', async () => {
    const f = captureFixture(); setCaptureDays(f, 30)
    const writer = new ScopedArtifactWriter(f.workerRoot)
    const source = join(f.root, 'report.pdf'); writeFileSync(source, 'download bytes')
    const screenshot = writer.write('test', 'session-a', Buffer.from('png bytes'), 'image/png', 'png')
    const download = writer.writeFile('test', 'session-a', source, 'application/pdf', 'report.pdf')
    const picture = writer.writeFile('test', 'session-a', source, 'image/png', 'photo.png') // A downloaded image is still a download.
    const dir = join(f.profileDir, 'session-a')
    expect(readdirSync(dir).filter((name) => name.startsWith(download.artifactId))).toEqual([`${download.artifactId}.pdf.download`])
    const earlier = join(dir, `art_${uuid(1)}.pdf`); writeFileSync(earlier, 'a download from before')
    const old = new Date(Date.now() - 90 * DAY)
    for (const name of readdirSync(dir)) utimesSync(join(dir, name), old, old)
    const report = await f.service.run('manual')
    expect(existsSync(join(dir, `${screenshot.artifactId}.png`))).toBe(false)
    expect(existsSync(join(dir, `${download.artifactId}.pdf.download`))).toBe(true); expect(existsSync(join(dir, `${picture.artifactId}.png.download`))).toBe(true)
    expect(existsSync(earlier)).toBe(true)
    expect(captureItems(report)).toEqual([expect.objectContaining({ outcome: 'removed', files: 1 })])
  })
})

describe('browser capture rule: one session never stops the others', () => {
  it('keeps what earlier sessions deleted in the report and the history when a later one fails', async () => {
    const f = captureFixture({ measure: async (path, options) => { if (path.includes('session-b')) throw new Error('The disk reported an error'); return measureTree(path, options) } }); setCaptureDays(f, 30)
    const a = capture(f, 'session-a', `art_${uuid(1)}.png`, 90), b = capture(f, 'session-b', `art_${uuid(2)}.png`, 90), c = capture(f, 'session-c', `art_${uuid(3)}.png`, 90)
    const report = await f.service.run('manual')
    expect(existsSync(a)).toBe(false); expect(existsSync(b)).toBe(true); expect(existsSync(c)).toBe(false)
    expect(captureItems(report)).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'Browser session session-a', outcome: 'removed' }),
      expect.objectContaining({ label: 'Browser session session-b', outcome: 'failed', reason: 'The disk reported an error' }),
      expect.objectContaining({ label: 'Browser session session-c', outcome: 'removed' })
    ]))
    expect(report.counts).toMatchObject({ removed: 2, failed: 1 })
    expect(captureHistory(f).map((line) => [line.label, line.outcome])).toEqual(expect.arrayContaining([['Browser session session-a', 'removed'], ['Browser session session-b', 'failed'], ['Browser session session-c', 'removed']]))
  })

  it('skips a session folder that disappears during the run without reporting a failure', async () => {
    let removedB = false
    const holder: { f?: CaptureFixture } = {}
    const f = captureFixture({ measure: async (path, options) => { if (!removedB) { removedB = true; rmSync(join(holder.f!.profileDir, 'session-b'), { recursive: true, force: true }) } return measureTree(path, options) } })
    holder.f = f; setCaptureDays(f, 30)
    capture(f, 'session-a', `art_${uuid(1)}.png`, 90); capture(f, 'session-b', `art_${uuid(2)}.png`, 90)
    const report = await f.service.run('manual')
    expect(captureItems(report)).toEqual([expect.objectContaining({ label: 'Browser session session-a', outcome: 'removed' })]); expect(report.counts.failed).toBe(0)
  })
})

describe('browser capture files that keep failing', () => {
  it('keeps a file in use without limit when the error says it is busy', async () => {
    const f = captureFixture({ removeFile: () => { throw Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' }) } }); setCaptureDays(f, 30)
    const old = capture(f, 'session-a', `art_${uuid(1)}.png`, 90)
    for (let run = 0; run < 5; run++) expect(captureItems(await f.service.run('manual'))).toEqual([expect.objectContaining({ outcome: 'kept', reason: '1 capture in use; tried again on the next run' })])
    expect(existsSync(old)).toBe(true); expect(existsSync(join(f.store.root, 'storage-cleanup-history.jsonl'))).toBe(false)
  })

  it.runIf(process.platform === 'win32')('reports a file that keeps failing with a permission error as failed on the third run, and records it', async () => {
    const f = captureFixture({ removeFile: () => { throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' }) } }); setCaptureDays(f, 30)
    const old = capture(f, 'session-a', `art_${uuid(1)}.png`, 90)
    for (let run = 0; run < 2; run++) expect(captureItems(await f.service.run('manual'))).toEqual([expect.objectContaining({ outcome: 'kept' })])
    expect(existsSync(join(f.store.root, 'storage-cleanup-history.jsonl'))).toBe(false)
    const third = await f.service.run('manual')
    expect(captureItems(third)).toEqual([expect.objectContaining({ outcome: 'failed', reason: expect.stringContaining('could not be deleted after 3 tries') })])
    expect(third.counts.failed).toBe(1); expect(existsSync(old)).toBe(true)
    expect(captureHistory(f)).toEqual([expect.objectContaining({ outcome: 'failed', rule: 'browser-capture' })])
  })

  it('does not carry a failed attempt over: one success in between starts the count again', async () => {
    let failing = true
    const f = captureFixture({ removeFile: (path) => { if (failing) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }); unlinkSync(path) } }); setCaptureDays(f, 30)
    const old = capture(f, 'session-a', `art_${uuid(1)}.png`, 90)
    await f.service.run('manual'); failing = false
    expect(captureItems(await f.service.run('manual'))).toEqual([expect.objectContaining({ outcome: 'removed' })]); expect(existsSync(old)).toBe(false)
  })
})

describe('browser sessions the worker lost', () => {
  it('asks the browser with the retention cutoff, and deletes the captures of a session it reports as closed', async () => {
    let cutoff: number | undefined
    const f = captureFixture({ sessions: (staleBefore) => { cutoff = staleBefore; return new Map([['session-gone', { open: false }], ['session-live', { open: true }]]) } }); setCaptureDays(f, 30)
    const gone = capture(f, 'session-gone', `art_${uuid(1)}.png`, 90), live = capture(f, 'session-live', `art_${uuid(2)}.png`, 90)
    const report = await f.service.run('manual')
    expect(Math.abs(cutoff! - (Date.now() - 30 * DAY))).toBeLessThan(60_000)
    expect(existsSync(gone)).toBe(false); expect(existsSync(live)).toBe(true)
    expect(captureItems(report)).toEqual(expect.arrayContaining([expect.objectContaining({ label: 'Browser session session-live', outcome: 'kept', reason: 'Session is not closed' })]))
  })

  it('treats a session the browser has no record of as closed', async () => {
    const f = captureFixture({ sessions: () => new Map() }); setCaptureDays(f, 30)
    const old = capture(f, 'session-forgotten', `art_${uuid(1)}.png`, 90)
    await f.service.run('manual')
    expect(existsSync(old)).toBe(false)
  })
})

describe('browser capture rows can be traced', () => {
  it('names the thread, carries its id and project, and records the file count in the history', async () => {
    const thread = { id: 'task', name: 'Task one', projectId: 'project-1', createdAt: OLD.toISOString() }
    const f = captureFixture({ thread, sessions: () => new Map([['session-a', { open: false, threadId: 'task' }], ['session-b', { open: false, threadId: 'deleted-thread' }]]) }); setCaptureDays(f, 30)
    capture(f, 'session-a', `art_${uuid(1)}.png`, 90); capture(f, 'session-a', `art_${uuid(2)}`, 90); capture(f, 'session-b', `art_${uuid(3)}.png`, 90)
    const report = await f.service.run('manual')
    expect(captureItems(report)).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'Task one: browser session session-a', threadId: 'task', projectId: 'project-1', files: 2, outcome: 'removed' }),
      expect.objectContaining({ label: 'Browser session session-b', files: 1, outcome: 'removed' })
    ]))
    expect(captureItems(report).find((entry) => entry.label.endsWith('session-b'))!.threadId).toBeUndefined()
    expect(captureHistory(f)).toEqual(expect.arrayContaining([expect.objectContaining({ label: 'Task one: browser session session-a', threadId: 'task', projectId: 'project-1', files: 2, rule: 'browser-capture' })]))
  })
})

describe('storage defaults', () => {
  it('ships the recommended rules on: deleted threads, 30 days inactive, merged work and 30-day captures', () => {
    expect(STORAGE_POLICY_DEFAULTS).toEqual({ schemaVersion: 1, worktrees: { removeWithDeletedThreads: true, inactiveDays: 30, removeMerged: true }, browser: { captureDays: 30 } })
  })
})

describe('a confirmed plan bounds the run', () => {
  const keysOf = (token: { keys: string[] }) => [...token.keys].sort()

  it('removes what the plan listed and nothing that became eligible after it', async () => {
    const f = fixture(); setPolicy(f, inactive())
    // Used a moment ago, so the plan keeps it.
    const used = new Date(); utimesSync(join(f.location, 'messages.json'), used, used)
    const { plan, token } = await f.service.planWithToken()
    expect(plan.find((entry) => entry.threadId === 'task')).toMatchObject({ action: 'keep' })
    expect(token.keys).toEqual([])
    // Then it goes quiet, which would make it eligible for an unbounded run.
    age(f)
    const report = await f.service.run('manual', { plan: token })
    expect(item(report)).toBeUndefined(); expect(report.counts).toEqual({ removed: 0, kept: 0, failed: 0 })
    expect(existsSync(f.worktree)).toBe(true)
    // The next ordinary run handles it.
    expect(item(await f.service.run('manual'))).toMatchObject({ outcome: 'removed' }); expect(existsSync(f.worktree)).toBe(false)
  }, 90_000)

  it('removes a listed worktree, names it by thread, and reports it', async () => {
    const f = fixture(); setPolicy(f, inactive())
    const { plan, token } = await f.service.planWithToken()
    expect(plan.find((entry) => entry.threadId === 'task')).toMatchObject({ action: 'remove', key: 'worktree:task' })
    expect(keysOf(token)).toEqual(['worktree:task'])
    expect(token.expiresAt - token.issuedAt).toBe(10 * 60_000)
    expect(item(await f.service.run('manual', { plan: token }))).toMatchObject({ outcome: 'removed', rule: 'worktree-inactive' })
    expect(existsSync(f.worktree)).toBe(false)
  }, 90_000)

  it('empties only the trash the plan listed', async () => {
    const f = fixture(); enableTrash(f); setPolicy(f)
    await trashed(f, 'listed')
    const { token } = await f.service.planWithToken()
    expect(keysOf(token)).toEqual(['trash:listed'])
    // Past its retention only after the plan was made.
    await trashed(f, 'later')
    const report = await f.service.run('manual', { plan: token })
    expect(report.items.filter((entry) => entry.rule === 'trash').map((entry) => [entry.threadId, entry.outcome])).toEqual([['listed', 'removed']])
    expect(f.store.get('listed')?.state).toBe('purged'); expect(f.store.get('later')?.state).toBe('trashed')
    // An unbounded run does empty it.
    await f.service.run('manual'); expect(f.store.get('later')?.state).toBe('purged')
  }, 120_000)

  it('does not touch trash at all when the plan listed none', async () => {
    const f = fixture(); enableTrash(f); setPolicy(f, inactive())
    const { token } = await f.service.planWithToken()
    await trashed(f, 'late')
    const report = await f.service.run('manual', { plan: token })
    expect(report.items.some((entry) => entry.rule === 'trash')).toBe(false); expect(f.store.get('late')?.state).toBe('trashed')
  }, 120_000)

  it('refuses a plan that has expired, and one made under other settings', async () => {
    const f = fixture(); setPolicy(f, inactive())
    const { token } = await f.service.planWithToken()
    setPolicy(f, inactive(45))
    await expect(f.service.run('manual', { plan: token })).rejects.toThrow(/Settings changed since the plan/)
    expect(existsSync(f.worktree)).toBe(true)
    const second = await f.service.planWithToken()
    f.clockState.offset += 11 * 60_000
    await expect(f.service.run('manual', { plan: second.token })).rejects.toThrow(/plan has expired/)
    expect(existsSync(f.worktree)).toBe(true)
    // A refused plan leaves the service free for the next run.
    expect(item(await f.service.run('manual'))).toMatchObject({ outcome: 'removed' })
  }, 120_000)

  it('waits for a run in progress and is never merged into it', async () => {
    const f = fixture(); setPolicy(f, inactive())
    const { token } = await f.service.planWithToken()
    const first = f.service.run('schedule')
    const planned = f.service.run('manual', { plan: token })
    expect(planned).not.toBe(first)
    const [scheduled, confirmed] = await Promise.all([first, planned])
    expect(scheduled.trigger).toBe('schedule')
    expect(confirmed.trigger).toBe('manual')
  }, 90_000)

  it('deletes only the browser sessions the plan listed', async () => {
    const f = captureFixture(); setCaptureDays(f, 30)
    const listed = capture(f, 'session-a', `art_${uuid(1)}.png`, 40)
    const { plan, token } = await f.service.planWithToken()
    expect(plan.find((entry) => entry.rule === 'browser-capture')).toMatchObject({ action: 'remove', key: 'capture:session-a' })
    const later = capture(f, 'session-b', `art_${uuid(2)}.png`, 40)
    const report = await f.service.run('manual', { plan: token })
    expect(existsSync(listed)).toBe(false); expect(existsSync(later)).toBe(true)
    expect(captureItems(report).map((entry) => entry.label)).toEqual(['Browser session session-a'])
  }, 60_000)
})

describe('profiles that were already in use keep what they had', () => {
  it('a scheduled run on an existing profile removes nothing that the old defaults kept', async () => {
    const f = fixture(); expect(f.policy.initialize(() => true)).toBe('existing')
    expect(f.policy.policy()).toEqual({ schemaVersion: 1, worktrees: { removeWithDeletedThreads: true, inactiveDays: null, removeMerged: false }, browser: { captureDays: null } })
    // Idle for 90 days, and merged: both new rules would remove it.
    addRemote(f); const head = commit(f); git(f.repo, ['update-ref', `refs/remotes/origin/${defaultName(f)}`, head])
    const report = await f.service.run('schedule')
    expect(report.items.filter((entry) => entry.outcome === 'removed')).toEqual([])
    expect(existsSync(f.worktree)).toBe(true)
    expect(f.policy.reviewPending()).toBe(true)
  }, 90_000)

  it('keeps old captures on an existing profile until the rule is turned on', async () => {
    const f = captureFixture(); expect(f.policy.initialize(() => true)).toBe('existing')
    const old = capture(f, 'session-a', `art_${uuid(1)}.png`, 400)
    expect(captureItems(await f.service.run('schedule'))).toEqual([]); expect(existsSync(old)).toBe(true)
    expect(captureItems(await f.service.run('manual'))).toEqual([]); expect(existsSync(old)).toBe(true)
    f.policy.configure({ schemaVersion: 1, worktrees: { removeWithDeletedThreads: true, inactiveDays: null, removeMerged: false }, browser: { captureDays: 30 } }, true)
    expect(captureItems(await f.service.run('manual'))).toEqual([expect.objectContaining({ outcome: 'removed' })]); expect(existsSync(old)).toBe(false)
  }, 60_000)

  it('a new profile gets the recommended rules', async () => {
    const f = fixture(); expect(f.policy.initialize(() => false)).toBe('new')
    expect(f.policy.policy()).toEqual(STORAGE_POLICY_DEFAULTS); expect(f.policy.reviewPending()).toBe(false)
    expect(item(await f.service.run('manual'))).toMatchObject({ rule: 'worktree-inactive', outcome: 'removed' })
  }, 90_000)
})

describe('the merged rule counts conversation as use', () => {
  it('leaves a merged worktree alone while the thread is being chatted in, then removes it', async () => {
    const f = fixture(); addRemote(f); setPolicy(f, { worktrees: { removeMerged: true } })
    const head = commit(f); git(f.repo, ['update-ref', `refs/remotes/origin/${defaultName(f)}`, head])
    const chatted = new Date(Date.now() - 5 * 60_000); utimesSync(join(f.location, 'messages.json'), chatted, chatted)
    expect(item(await f.service.run('manual'))).toMatchObject({ outcome: 'kept', reason: 'Used within the last day' })
    expect(existsSync(f.worktree)).toBe(true)
    age(f)
    expect(item(await f.service.run('manual'))).toMatchObject({ rule: 'worktree-merged', outcome: 'removed' })
  }, 90_000)
})

describe('the hourly run does not hold up the daemon', () => {
  /** Calls between two turns of the event loop: a request can only be answered when one comes round. */
  function watchLoop() {
    const stamps: number[] = []; let running = true
    const spin = () => { if (!running) return; stamps.push(Date.now()); setImmediate(spin) }
    setImmediate(spin)
    return { stop: () => { running = false; return stamps }, }
  }
  const busy = (ms: number) => { const end = Date.now() + ms; while (Date.now() < end) { /* Stands for a Git call and a file walk. */ } }

  it('yields to the event loop between worktrees, so a request is answered promptly during a run', async () => {
    const f = fixture(); setPolicy(f, inactive())
    for (let index = 1; index <= 5; index++) {
      const location = join(f.home, 'thread-data', `extra-${index}`); mkdirSync(location, { recursive: true })
      writeFileSync(join(location, 'meta.json'), JSON.stringify({ id: `extra-${index}` })); writeFileSync(join(location, 'messages.json'), '[]')
      writeFileSync(join(location, 'workspace.json'), JSON.stringify({ schemaVersion: 1, threadId: `extra-${index}`, worktreePath: f.worktree, lifecycle: 'ready' }))
      f.store.registerTask({ taskId: `extra-${index}`, location })
    }
    const evaluate = vi.spyOn(f.service as unknown as { evaluateOne: () => Promise<{ keep: string }> }, 'evaluateOne').mockImplementation(async () => { busy(25); return { keep: 'Stubbed' } })
    const watch = watchLoop()
    await f.service.run('schedule')
    const stamps = watch.stop()
    expect(evaluate.mock.calls.length).toBeGreaterThanOrEqual(6)
    // One turn of the loop after every worktree, and none of them waited for more than a worktree's work.
    expect(stamps.length).toBeGreaterThanOrEqual(evaluate.mock.calls.length)
    const gaps = stamps.slice(1).map((stamp, index) => stamp - stamps[index]!)
    expect(Math.max(...gaps)).toBeLessThan(250)
  }, 90_000)

  it('walks a big folder for another repository in slices, and still finds one', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mousse-walk-')); roots.push(root)
    for (let directory = 0; directory < 40; directory++) {
      mkdirSync(join(root, `d${directory}`)); for (let file = 0; file < 40; file++) writeFileSync(join(root, `d${directory}`, `f${file}.txt`), '')
    }
    const watch = watchLoop()
    expect(await findNestedRepository(root)).toEqual({ truncated: false })
    expect(watch.stop().length).toBeGreaterThanOrEqual(2)
    mkdirSync(join(root, 'd7', 'inner', '.git'), { recursive: true })
    expect(await findNestedRepository(root)).toEqual({ nested: 'd7/inner', truncated: false })
  }, 60_000)

  it('keeps a worktree with node_modules for its ignored files without looking for another repository', async () => {
    const f = fixture(); setPolicy(f, inactive()); commit(f, '.gitignore', 'node_modules/\n')
    mkdirSync(join(f.worktree, 'node_modules', 'pkg'), { recursive: true }); writeFileSync(join(f.worktree, 'node_modules', 'pkg', 'index.js'), 'x')
    mkdirSync(join(f.worktree, 'node_modules', 'pkg', '.git'))
    expect(item(await f.service.run('manual'))).toMatchObject({ outcome: 'kept', reason: 'Has ignored files (node_modules/)' })
  }, 60_000)
})
