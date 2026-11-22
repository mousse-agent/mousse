/**
 * A turn's start and end ask Git about their folder once for all their callers (`src/mms/git/repositoryFacts.ts`):
 * the snapshot and the repository's lock key must be exactly what each caller asking Git itself gets, in every state a
 * worktree can be in, with fewer Git processes; and nothing read in one window may be used in another, nor across the
 * wait for the repository's lease.
 *
 * States (one row each): on a branch; detached HEAD; a merge waiting; a linked worktree (the thread's own kind, whose
 * Git folder and common folder differ); a turn folder below the checkout's top. The unborn HEAD is checked on its own,
 * since a snapshot refuses it.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { inTurnBoundary } from '../src/mms/diagnostics/turnBoundary'
import { closeRepositoryFacts, openRepositoryFacts, withRepositoryFactsScope } from '../src/mms/git/repositoryFacts'
import { resolveRepositoryIdentityAsync } from '../src/mms/git/RepositoryIdentity'
import { acquireRepositoryLease } from '../src/mms/git/RepositoryLease'
import { takeSnapshotAsync, type Snapshot } from '../src/mms/actions/snapshots'
import { withGitMutationLocks } from '../src/mms/actions/GitOperationCoordinator'

const roots: string[] = []
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }) })

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

function repository(): { base: string; repo: string } {
  const base = mkdtempSync(join(tmpdir(), 'mousse-facts-')); roots.push(base)
  const repo = join(base, 'repo'); mkdirSync(repo)
  git(repo, 'init', '-q', '-b', 'main'); git(repo, 'config', 'user.name', 'Test'); git(repo, 'config', 'user.email', 'test@example.test'); git(repo, 'config', 'core.autocrlf', 'false')
  writeFileSync(join(repo, 'value.txt'), 'base\n'); mkdirSync(join(repo, 'sub')); writeFileSync(join(repo, 'sub', 'inner.txt'), 'inner\n')
  git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'base')
  return { base, repo }
}

/** Runs `work` in a window of shared facts, and counts the Git processes it started. */
async function inWindow<T>(work: () => Promise<T>): Promise<{ value: T; git: number }> {
  let value!: T
  const lines: string[] = []
  await inTurnBoundary({ threadId: 'facts' }, () => withRepositoryFactsScope(async () => {
    openRepositoryFacts()
    try { value = await work() } finally { closeRepositoryFacts() }
  }), (line) => lines.push(line))
  return { value, git: (JSON.parse(lines[0]!.slice('[turn-boundary] '.length)) as { git: number }).git }
}

/** The same, each caller asking Git itself. */
async function asked<T>(work: () => Promise<T>): Promise<{ value: T; git: number }> {
  let value!: T
  const lines: string[] = []
  await inTurnBoundary({ threadId: 'facts' }, async () => { value = await work() }, (line) => lines.push(line))
  return { value, git: (JSON.parse(lines[0]!.slice('[turn-boundary] '.length)) as { git: number }).git }
}

/** What a turn's start asks: the lock identity, then a snapshot; the snapshot's sha is left out (its commit time differs). */
async function startReads(cwd: string): Promise<{ key: string; commonDir: string; capability: unknown; snapshot: Omit<Snapshot, 'sha'> }> {
  const identity = await resolveRepositoryIdentityAsync(cwd, { requireMutationCapability: true })
  const { sha: _sha, ...snapshot } = await takeSnapshotAsync(cwd, { reason: 'facts test' })
  return { key: identity.key, commonDir: identity.commonDir, capability: identity.capability, snapshot }
}

const STATES: Array<[string, (repo: string, base: string) => string]> = [
  ['on a branch, with an edit', (repo) => { writeFileSync(join(repo, 'value.txt'), 'edited\n'); return repo }],
  ['detached HEAD', (repo) => { git(repo, 'checkout', '-q', '--detach'); writeFileSync(join(repo, 'new.txt'), 'new\n'); return repo }],
  ['a merge waiting', (repo) => {
    git(repo, 'switch', '-q', '-c', 'side'); writeFileSync(join(repo, 'value.txt'), 'side\n'); git(repo, 'commit', '-qam', 'side')
    git(repo, 'switch', '-q', 'main'); writeFileSync(join(repo, 'value.txt'), 'main\n'); git(repo, 'commit', '-qam', 'main')
    try { git(repo, 'merge', 'side') } catch { /* The conflict is the point. */ }
    return repo
  }],
  ['a linked worktree', (repo, base) => {
    const worktree = join(base, 'linked'); git(repo, 'worktree', 'add', '-q', '-b', 'thread', worktree)
    writeFileSync(join(worktree, 'value.txt'), 'in the worktree\n'); return worktree
  }],
  ['a folder below the top', (repo) => { writeFileSync(join(repo, 'sub', 'inner.txt'), 'changed\n'); return join(repo, 'sub') }]
]

describe('one read of the folder per turn boundary', () => {
  it.each(STATES)('%s: the same lock key and snapshot as each caller asking Git, with fewer Git processes', async (_name, prepare) => {
    const { base, repo } = repository()
    const cwd = prepare(repo, base)
    const shared = await inWindow(() => startReads(cwd))
    // The snapshot just taken is reused when nothing changed: asking Git itself must reach the same state, or the
    // reuse check (same tree, exact tree, HEAD and gaps) would take a new one.
    const own = await asked(() => startReads(cwd))
    expect(shared.value).toEqual(own.value)
    const again = await inWindow(() => startReads(cwd).then(async (reads) => ({ reads, sha: (await takeSnapshotAsync(cwd, { reason: 'again' })).sha })))
    const plain = await asked(() => startReads(cwd).then(async (reads) => ({ reads, sha: (await takeSnapshotAsync(cwd, { reason: 'again' })).sha })))
    expect(again.value).toEqual(plain.value)
    // The same work, both reusing the snapshot: the shared read saves Git processes.
    expect(again.git).toBeLessThan(plain.git)
  })

  it('a repository with no commit yet reads the same capability', async () => {
    const base = mkdtempSync(join(tmpdir(), 'mousse-facts-')); roots.push(base)
    git(base, 'init', '-q')
    const identity = () => resolveRepositoryIdentityAsync(base)
    const shared = await inWindow(identity)
    const own = await identity()
    expect(shared.value.capability).toEqual({ allowed: false, reason: 'unborn-head' })
    expect(shared.value).toEqual(own)
  })

  it('a .git replaced between two turns is read anew by the next', async () => {
    const { repo } = repository()
    const before = await inWindow(() => resolveRepositoryIdentityAsync(repo))
    rmSync(join(repo, '.git'), { recursive: true, force: true })
    const other = repository()
    // The folder is now a checkout of another repository's Git folder.
    writeFileSync(join(repo, '.git'), `gitdir: ${join(other.repo, '.git')}\n`)
    const after = await inWindow(() => resolveRepositoryIdentityAsync(repo))
    expect(after.value.commonDir).not.toBe(before.value.commonDir)
    expect(after.value).toEqual(await resolveRepositoryIdentityAsync(repo))
  })

  it('HEAD moved while the turn waited for the repository\'s lease is the HEAD its snapshot records', async () => {
    const { base, repo } = repository()
    const threadDir = join(base, 'thread'); mkdirSync(threadDir)
    const identity = await resolveRepositoryIdentityAsync(repo, { requireMutationCapability: true })
    const held = await acquireRepositoryLease(identity)
    const result = await inWindow(async () => {
      // Read before the lease, as a turn's end reads its lock identity.
      await resolveRepositoryIdentityAsync(repo)
      const waiting = withGitMutationLocks(threadDir, repo, 'facts-test', () => takeSnapshotAsync(repo, { reason: 'after the wait' }))
      // Someone commits in the checkout while the turn waits.
      await new Promise((resolve) => setTimeout(resolve, 100))
      writeFileSync(join(repo, 'value.txt'), 'committed meanwhile\n'); git(repo, 'commit', '-qam', 'meanwhile')
      held.release()
      return waiting
    })
    expect(result.value.head).toBe(git(repo, 'rev-parse', 'HEAD'))
  })
})
