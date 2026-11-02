import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ThreadWorkspaceManager } from '../src/mms/workspace/ThreadWorkspaceManager'
import { WorkspaceResolver } from '../src/mms/workspace/WorkspaceResolver'
import { isThreadOwnBranch } from '../src/mms/workspace/WorkflowWorkspace'

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

describe('a thread worktree\'s branch is named once, from the first message', () => {
  let base: string, repo: string, home: string, previous: string | undefined
  const threadDir = (name: string): string => { const dir = join(base, 'threads', name); mkdirSync(dir, { recursive: true }); return dir }

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'mousse-branch-names-'))
    repo = join(base, 'repo'); home = join(base, 'home'); mkdirSync(repo)
    git(repo, 'init', '-q'); git(repo, 'config', 'user.name', 'Test'); git(repo, 'config', 'user.email', 'test@example.test')
    writeFileSync(join(repo, 'README'), 'base\n'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'base')
    previous = process.env.MOUSSE_HOME; process.env.MOUSSE_HOME = home
  })
  afterEach(() => {
    if (previous === undefined) delete process.env.MOUSSE_HOME; else process.env.MOUSSE_HOME = previous
    rmSync(base, { recursive: true, force: true })
  })

  it('at the first editing turn, from the message the turn path passes in, and a read-only turn makes nothing', async () => {
    const dir = threadDir('one')
    const resolver = new WorkspaceResolver(dir, 'thread-one', repo)
    expect((await resolver.resolve('ask', 'main', undefined, undefined, 'Fix the login button')).lifecycle).toBe('unprovisioned')
    expect(new ThreadWorkspaceManager(dir).load()).toBeUndefined()
    const context = await resolver.resolve('agent', 'main', undefined, undefined, 'Fix the login button')
    expect(context.branch).toBe('mousse/fix-the-login-button')
    // A later turn with another message keeps the name: it is never picked again.
    await resolver.resolve('agent', 'main', undefined, undefined, 'Now something else entirely')
    expect(new ThreadWorkspaceManager(dir).load()!.branch).toBe('mousse/fix-the-login-button')
  })

  it('a taken name gets a suffix, and so does one with someone\'s branches under it', async () => {
    const first = await new ThreadWorkspaceManager(threadDir('one')).provision('thread-one', 'main', repo, undefined, undefined, undefined, { nameFrom: 'Add tests' })
    const second = await new ThreadWorkspaceManager(threadDir('two')).provision('thread-two', 'main', repo, undefined, undefined, undefined, { nameFrom: 'Add tests' })
    expect([first.branch, second.branch]).toEqual(['mousse/add-tests', 'mousse/add-tests-2'])
    // Git cannot hold `mousse/add-tests-3` as a branch while branches sit under it.
    git(repo, 'branch', 'mousse/add-tests-3/theirs')
    const third = await new ThreadWorkspaceManager(threadDir('three')).provision('thread-three', 'main', repo, undefined, undefined, undefined, { nameFrom: 'Add tests' })
    expect(third.branch).toBe('mousse/add-tests-4')
    expect(git(repo, 'branch', '--list', 'mousse/*', '--format=%(refname:short)').split('\n')).toEqual(['mousse/add-tests', 'mousse/add-tests-2', 'mousse/add-tests-3/theirs', 'mousse/add-tests-4'])
    // The worktree path and the retained ref stay keyed by ids.
    expect(third.worktreePath.endsWith(join('threads', 'thread-three', 'main'))).toBe(true)
    expect(third.retainedRef).toBe('refs/mousse/threads/thread-three/main')
  })

  it('falls back to the thread id when there is no usable first message', async () => {
    const metadata = await new ThreadWorkspaceManager(threadDir('one')).provision('7f3a9c21-0000-4000-8000-000000000000', 'main', repo)
    expect(metadata.branch).toBe('mousse/thread-7f3a9c21')
  })
})

describe('a thread workspace\'s recorded branch', () => {
  it('is the thread\'s own when it is a named mousse/ branch, or its own id-named one; never another thread\'s or one outside mousse/', () => {
    expect(isThreadOwnBranch('mousse/fix-the-login-button', 'task', 'main')).toBe(true)
    expect(isThreadOwnBranch('mousse/thread/task/main', 'task', 'main')).toBe(true)
    expect(isThreadOwnBranch('mousse/thread/other/main', 'task', 'main')).toBe(false)
    expect(isThreadOwnBranch('mousse/thread/task/fork-1', 'task', 'main')).toBe(false)
    expect(isThreadOwnBranch('feature/x', 'task', 'main')).toBe(false)
    // With an active conversation branch, any of the thread's id-named branches, and the fork's recorded one.
    expect(isThreadOwnBranch('mousse/thread/task/fork-1', 'task', 'fork-1', {})).toBe(true)
    expect(isThreadOwnBranch('mousse/thread/turn-9/fork-1', 'task', 'fork-1', { gitBranch: 'mousse/thread/turn-9/fork-1' })).toBe(true)
    expect(isThreadOwnBranch('mousse/thread/other/main', 'task', 'fork-1', {})).toBe(false)
  })
})
