import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ThreadWorkspaceManager } from '../src/mms/workspace/ThreadWorkspaceManager'
import { WorkspaceResolver } from '../src/mms/workspace/WorkspaceResolver'
import { isThreadOwnBranch } from '../src/mms/workspace/WorkflowWorkspace'
import { registerBranchNamer, requestBranchName, type BranchNamer } from '../src/mms/workspace/branchNaming'
import { BRANCH_RENAME_OPERATION } from '../src/mms/workspace/threadBranchRecords'
import type { BranchNamingSettings } from '../src/shared/settings'
import { gitLeftInPlaceNoticeAsync } from '../src/mms/actions/snapshots'

// Each test runs Git dozens of times; starting a process on Windows takes several times longer. Nothing here waits on a timer.
if (process.platform === 'win32') vi.setConfig({ testTimeout: 90_000 })

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const branches = (repo: string): string[] => git(repo, 'branch', '--format=%(refname:short)').split('\n').filter(Boolean).sort()

let base: string, repo: string, home: string, previous: string | undefined
let forget: (() => void) | undefined
const threadDir = (name: string, meta: Record<string, unknown> = {}): string => {
  const dir = join(home, 'thread-data', name); mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'meta.json'), JSON.stringify({ id: name, ...meta }))
  return dir
}
/** The profile's namer: the settings given, and the title model's answer from `answer`. */
const namer = (settings: Partial<BranchNamingSettings>, answer: BranchNamer['ask']): ReturnType<typeof vi.fn> => {
  const ask = vi.fn(answer)
  forget = registerBranchNamer(home, { settings: () => ({ mode: 'static', prefix: 'mousse', instructions: '', ...settings }), ask })
  return ask
}
const workspace = (dir: string) => JSON.parse(readFileSync(join(dir, 'workspace.json'), 'utf8')) as { branch: string; worktreePath: string }

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'mousse-branch-names-'))
  repo = join(base, 'repo'); home = join(base, 'home'); mkdirSync(repo)
  git(repo, 'init', '-q', '-b', 'main'); git(repo, 'config', 'user.name', 'Test'); git(repo, 'config', 'user.email', 'test@example.test')
  writeFileSync(join(repo, 'README'), 'base\n'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'base')
  previous = process.env.MOUSSE_HOME; process.env.MOUSSE_HOME = home
  vi.spyOn(console, 'info').mockImplementation(() => undefined)
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})
afterEach(() => {
  forget?.(); forget = undefined
  vi.restoreAllMocks()
  if (previous === undefined) delete process.env.MOUSSE_HOME; else process.env.MOUSSE_HOME = previous
  rmSync(base, { recursive: true, force: true })
})

describe('a thread worktree starts on a temporary branch and is named in the background', () => {
  it('the turn gets the worktree before the title model answers; the answer then renames the branch the worktree is on', async () => {
    let answer!: (text: string) => void
    const ask = namer({}, () => new Promise<string>((done) => { answer = done }))
    const dir = threadDir('one')
    const resolver = new WorkspaceResolver(dir, 'thread-one', repo)
    const context = await resolver.resolve('agent', 'main', undefined, undefined, 'Fix the login button on Safari')
    // Made at once, on `mousse/<random id>`, while the model has not answered.
    expect(context.branch).toMatch(/^mousse\/[0-9a-f]{8}$/)
    expect(ask).toHaveBeenCalledTimes(1)
    expect(ask.mock.calls[0][0].prompt).toContain('Fix the login button on Safari')
    const temporary = context.branch!
    answer('login-button-on-safari')
    await vi.waitFor(() => expect(workspace(dir).branch).toBe('mousse/login-button-on-safari'), { timeout: 60_000, interval: 50 })
    expect(git(context.workspacePath!, 'symbolic-ref', '--short', 'HEAD')).toBe('mousse/login-button-on-safari')
    expect(branches(repo)).toEqual(['main', 'mousse/login-button-on-safari'])
    // The folder keeps its first name, and the next turn uses the renamed branch.
    expect(workspace(dir).worktreePath).toBe(context.workspacePath)
    expect((await resolver.resolve('agent', 'main', undefined, undefined, 'Something else')).branch).toBe('mousse/login-button-on-safari')
    expect(temporary).not.toBe('mousse/login-button-on-safari')
  })

  // Every way naming can fail leaves the temporary branch, and nothing else in the repository changes.
  it.each([
    ['no title model', async () => undefined],
    ['the request fails', async () => { throw new Error('refused') }],
    ['an answer that names nothing', async () => '日本語'],
    ['a name in the id-named folders', async () => 'mousse/thread/other/main']
  ] as const)('%s: the temporary name stays', async (_case, answer) => {
    const ask = namer({ mode: 'custom' }, answer)
    const manager = new ThreadWorkspaceManager(threadDir('one'))
    const made = await manager.provision('thread-one', 'main', repo, undefined, undefined, undefined, { nameFrom: 'Fix the login button' })
    await manager.branchNaming
    expect(ask).toHaveBeenCalled()
    expect(manager.load()!.branch).toBe(made.branch)
    expect(branches(repo)).toEqual(['main', made.branch])
  })

  it('a name someone already has stays theirs: their branch is untouched and the temporary name stays', async () => {
    git(repo, 'branch', 'mousse/login-button')
    const theirs = git(repo, 'rev-parse', 'mousse/login-button')
    namer({}, async () => 'login-button')
    const manager = new ThreadWorkspaceManager(threadDir('one'))
    const made = await manager.provision('thread-one', 'main', repo, undefined, undefined, undefined, { nameFrom: 'Fix the login button' })
    await manager.branchNaming
    expect(manager.load()!.branch).toBe(made.branch)
    expect(git(repo, 'rev-parse', 'mousse/login-button')).toBe(theirs)
    expect(manager.branchRecord().owned.has('mousse/login-button')).toBe(false)
  })

  it('a temporary branch that was pushed already (it has an upstream) keeps its name', async () => {
    let answer!: (text: string) => void
    namer({}, () => new Promise<string>((done) => { answer = done }))
    const manager = new ThreadWorkspaceManager(threadDir('one'))
    const made = await manager.provision('thread-one', 'main', repo, undefined, undefined, undefined, { nameFrom: 'Fix the login button' })
    git(repo, 'config', `branch.${made.branch}.remote`, 'origin')
    git(repo, 'config', `branch.${made.branch}.merge`, `refs/heads/${made.branch}`)
    answer('login-button')
    await manager.branchNaming
    expect(manager.load()!.branch).toBe(made.branch)
    expect(branches(repo)).toEqual(['main', made.branch])
  })

  it('a title model that takes too long is not waited for', async () => {
    namer({}, () => new Promise(() => undefined))
    expect(await requestBranchName(threadDir('one'), 'thread-one', 'Fix the login button', 20)).toBeUndefined()
  })

  it('a name that differs from someone\'s branch only in case leaves their branch exactly as it was', async () => {
    // Where refs are files on a case-insensitive disk (Windows, macOS), `mousse/Login-Button` and `mousse/login-button`
    // are one file, though Git lists only the first.
    git(repo, 'branch', 'mousse/Login-Button')
    const refs = () => git(repo, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads').split('\n')
    const theirs = refs().find((line) => line.startsWith('refs/heads/mousse/Login-Button '))!
    namer({}, async () => 'login-button')
    const manager = new ThreadWorkspaceManager(threadDir('one'))
    const made = await manager.provision('thread-one', 'main', repo, undefined, undefined, undefined, { nameFrom: 'Fix the login button' })
    expect(made.branch).toMatch(/^mousse\/[0-9a-f]{8}$/)
    await manager.branchNaming
    expect(refs()).toContain(theirs)
    expect(manager.branchRecord().owned.has('mousse/Login-Button')).toBe(false)
    if (process.platform !== 'linux') expect(manager.load()!.branch).toBe(made.branch)
  })

  it('a private thread\'s first message is never sent, and its branch keeps the random name', async () => {
    const ask = namer({}, async () => 'login-button')
    const manager = new ThreadWorkspaceManager(threadDir('one', { localOnly: true }))
    const made = await manager.provision('thread-one', 'main', repo, undefined, undefined, undefined, { nameFrom: 'Fix the login button' })
    expect(manager.branchNaming).toBeUndefined()
    expect(ask).not.toHaveBeenCalled()
    expect(made.branch).toMatch(/^mousse\/[0-9a-f]{8}$/)
  })
})

describe('the person\'s naming settings', () => {
  it.each([
    ['team/alex', /^team\/alex\/[0-9a-f]{8}$/],
    ['', /^[0-9a-f]{8}$/]
  ])('prefix %j gives temporary names like %s', async (prefix, shape) => {
    namer({ prefix }, async () => undefined)
    const made = await new ThreadWorkspaceManager(threadDir('one')).provision('thread-one', 'main', repo)
    expect(made.branch).toMatch(shape)
  })

  it('a prefix that is a branch itself falls back to mousse/', async () => {
    git(repo, 'branch', 'team')
    namer({ prefix: 'team/alex' }, async () => undefined)
    expect((await new ThreadWorkspaceManager(threadDir('one')).provision('thread-one', 'main', repo)).branch).toMatch(/^mousse\/[0-9a-f]{8}$/)
  })

  it.each([
    ['static', 'team', 'login-button', 'team/login-button'],
    ['semantic', 'mousse', 'fix/login-button', 'fix/login-button'],
    ['custom', 'mousse', 'abc-123/login-button', 'abc-123/login-button']
  ] as const)('%s mode names the branch %s → %s, which is Mousse\'s by its records', async (mode, prefix, answer, name) => {
    const ask = namer({ mode, prefix, instructions: 'Start with the ticket number.' }, async () => answer)
    const dir = threadDir('one')
    const manager = new ThreadWorkspaceManager(dir)
    await manager.provision('thread-one', 'main', repo, undefined, undefined, undefined, { nameFrom: 'ABC-123 fix the login button' })
    await manager.branchNaming
    expect(manager.load()!.branch).toBe(name)
    if (mode === 'custom') expect(ask.mock.calls[0][0].system).toContain('Start with the ticket number.')
    // Outside `mousse/`, the branch is the thread's own because its journal says Mousse made it and renamed it.
    expect(isThreadOwnBranch(name, 'thread-one', 'main')).toBe(name.startsWith('mousse/'))
    expect(isThreadOwnBranch(name, 'thread-one', 'main', undefined, manager.branchRecord().owned)).toBe(true)
  })
})

describe('what Undo says about Git work after the branch was renamed', () => {
  it('a turn that started on the temporary name neither switched branches nor left commits on a branch that is gone', async () => {
    let answer!: (text: string) => void
    namer({ mode: 'semantic' }, () => new Promise<string>((done) => { answer = done }))
    const manager = new ThreadWorkspaceManager(threadDir('one'))
    const made = await manager.provision('thread-one', 'main', repo, undefined, undefined, undefined, { nameFrom: 'Fix the login button' })
    // The first turn commits on the temporary branch; the name arrives afterwards.
    writeFileSync(join(made.worktreePath, 'fix.txt'), 'fixed\n'); git(made.worktreePath, 'add', '.'); git(made.worktreePath, 'commit', '-qm', 'fix')
    const commit = git(made.worktreePath, 'rev-parse', 'HEAD')
    answer('fix/login-button')
    await manager.branchNaming
    expect(manager.load()!.branch).toBe('fix/login-button')
    const renamedTo = manager.branchRecord().renamedTo
    // Recorded before the rename: the commit's branch is the temporary name.
    const before = await gitLeftInPlaceNoticeAsync(made.worktreePath, 'Undo', { commits: [commit], git: { branchBefore: made.branch, branchAfter: made.branch, rewroteHistory: false } }, renamedTo)
    expect(before).toContain('stays on fix/login-button')
    expect(before).not.toContain('no longer exists')
    // Recorded across the rename: the start has the temporary name, the end the new one; that is no switch.
    expect(await gitLeftInPlaceNoticeAsync(made.worktreePath, 'Undo', { commits: [], git: { branchBefore: made.branch, branchAfter: 'fix/login-button', rewroteHistory: false } }, renamedTo)).toBeUndefined()
  })
})

describe('a rename a stop interrupted is settled from the repository', () => {
  /** A ready worktree on a temporary branch, and a planned rename to `fix/login-button` as the journal records it first. */
  async function interrupted() {
    const dir = threadDir('one')
    const manager = new ThreadWorkspaceManager(dir)
    const made = await manager.provision('thread-one', 'main', repo)
    const fromSha = git(repo, 'rev-parse', made.branch)
    manager.journal.append({ operationId: 'rename-1', operationType: BRANCH_RENAME_OPERATION, state: 'planned', expectedPreState: { from: made.branch, to: 'fix/login-button', worktreePath: made.worktreePath, fromSha } })
    return { dir, manager, made, from: made.branch, to: 'fix/login-button', fromSha }
  }

  // Each row: what happened before the stop, then what Mousse owns once the next turn settles it.
  it.each([
    ['only the journal\'s planned record', () => undefined, 'from'],
    ['Git renamed the branch; workspace.json not yet written', (f: Awaited<ReturnType<typeof interrupted>>) => git(repo, 'branch', '-m', f.from, f.to), 'to'],
    ['Git renamed the branch and workspace.json names it', (f: Awaited<ReturnType<typeof interrupted>>) => {
      git(repo, 'branch', '-m', f.from, f.to)
      writeFileSync(join(f.dir, 'workspace.json'), JSON.stringify({ ...workspace(f.dir), branch: f.to }))
    }, 'to'],
    // `git branch -m` renames the ref before it moves the worktree's HEAD: a stop between leaves HEAD on a branch that is gone.
    ['Git renamed the ref but not yet the worktree\'s HEAD', (f: Awaited<ReturnType<typeof interrupted>>) => {
      git(repo, 'update-ref', `refs/heads/${f.to}`, f.fromSha)
      git(repo, 'update-ref', '-d', `refs/heads/${f.from}`)
    }, 'to']
  ] as const)('%s', async (_case, before, owner) => {
    const f = await interrupted()
    before(f)
    // While unsettled, nothing may rename it again.
    expect(await f.manager.renameOwnBranch(workspace(f.dir).branch, 'fix/other')).not.toBe('renamed')
    // The next turn settles it before it reads the record.
    const context = await new WorkspaceResolver(f.dir, 'thread-one', repo).resolve('agent', 'main')
    const name = owner === 'from' ? f.from : f.to
    expect(context.branch).toBe(name)
    expect(workspace(f.dir).branch).toBe(name)
    // The worktree is on the branch, never on one that is gone.
    expect(git(f.made.worktreePath, 'symbolic-ref', 'HEAD')).toBe(`refs/heads/${name}`)
    expect(git(f.made.worktreePath, 'rev-parse', 'HEAD')).toBe(f.fromSha)
    const record = f.manager.branchRecord()
    expect(record.pending).toBeUndefined()
    expect([...record.owned]).toEqual([name])
  })

  it('a branch of the new name that holds other commits is not the renamed one: Mousse gives up both names and moves nothing', async () => {
    const f = await interrupted()
    // The old name is gone and someone's branch has the new one, on a commit the old branch never held.
    git(repo, 'update-ref', '-d', `refs/heads/${f.from}`)
    git(repo, 'branch', f.to, git(repo, 'commit-tree', `${f.fromSha}^{tree}`, '-m', 'theirs'))
    const theirs = git(repo, 'rev-parse', f.to)
    await f.manager.settleBranchRename()
    const record = f.manager.branchRecord()
    expect(record.pending).toBeUndefined()
    expect(record.owned.size).toBe(0)
    expect(git(repo, 'rev-parse', f.to)).toBe(theirs)
    expect(workspace(f.dir).branch).toBe(f.from)
  })

  it('when the repository cannot tell (both names there, the worktree on neither), Mousse gives up both names', async () => {
    const f = await interrupted()
    git(repo, 'branch', f.to)
    git(f.made.worktreePath, 'switch', '-q', '--detach')
    await f.manager.settleBranchRename()
    const record = f.manager.branchRecord()
    expect(record.pending).toBeUndefined()
    expect(record.owned.size).toBe(0)
    expect(branches(repo)).toEqual(['fix/login-button', 'main', f.from].sort())
  })
})

describe('a thread workspace\'s recorded branch', () => {
  it('is the thread\'s own when it is a mousse/ branch, its own id-named one, or one its journal names; never another thread\'s', () => {
    expect(isThreadOwnBranch('mousse/fix-the-login-button', 'task', 'main')).toBe(true)
    expect(isThreadOwnBranch('mousse/thread/task/main', 'task', 'main')).toBe(true)
    expect(isThreadOwnBranch('mousse/thread/other/main', 'task', 'main')).toBe(false)
    expect(isThreadOwnBranch('mousse/thread/task/fork-1', 'task', 'main')).toBe(false)
    expect(isThreadOwnBranch('feature/x', 'task', 'main')).toBe(false)
    expect(isThreadOwnBranch('feature/x', 'task', 'main', undefined, new Set(['feature/x']))).toBe(true)
    // A journal can never make another thread's id-named branch this thread's.
    expect(isThreadOwnBranch('mousse/thread/other/main', 'task', 'main', undefined, new Set(['mousse/thread/other/main']))).toBe(false)
    // With an active conversation branch, any of the thread's id-named branches, and the fork's recorded one.
    expect(isThreadOwnBranch('mousse/thread/task/fork-1', 'task', 'fork-1', {})).toBe(true)
    expect(isThreadOwnBranch('mousse/thread/turn-9/fork-1', 'task', 'fork-1', { gitBranch: 'mousse/thread/turn-9/fork-1' })).toBe(true)
    expect(isThreadOwnBranch('mousse/thread/other/main', 'task', 'fork-1', {})).toBe(false)
  })
})
