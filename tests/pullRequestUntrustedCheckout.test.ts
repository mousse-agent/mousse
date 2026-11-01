import { execFileSync } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { git as actionGit } from '../src/mms/actions/git'
import { MousseMainService } from '../src/mms/MousseMainService'
import { execRunner, type ExecutableRunner } from '../src/mms/git/ghRunner'
import { GitHubCodeHost, parsePullRequestDetail } from '../src/mms/git/GitHubCodeHost'
import { PullRequestThreadService } from '../src/mms/git/PullRequestThreadService'
import { ThreadWorkspaceManager } from '../src/mms/workspace/ThreadWorkspaceManager'
import type { PullRequestDetail } from '../src/shared/pullRequests'
import { git, gitFoundationFixture } from './fixtures/gitFoundation'

const REMOTES = 'origin\thttps://github.com/bob/app.git (fetch)\norigin\thttps://github.com/bob/app.git (push)\nupstream\thttps://github.com/acme/app.git (fetch)\nupstream\thttps://github.com/acme/app.git (push)\n'
const HOOKS = ['pre-commit', 'commit-msg', 'post-commit', 'post-checkout', 'pre-push', 'reference-transaction', 'post-merge']

/**
 * A pull request from a fork that tries every way a commit can make Git run something: a relative hooks path
 * with hook scripts in the commit, filter and process drivers its `.gitattributes` selects (the project has
 * them configured at user level, as Git LFS does), and an `.lfsconfig` pointing at a server of its own.
 * Every script leaves a marker; the server counts requests.
 */
describe('a pull request that tries to run code', () => {
  let f: ReturnType<typeof gitFoundationFixture>
  let mms: MousseMainService
  let host: GitHubCodeHost
  let service: PullRequestThreadService
  let projectId: string
  let markers: string
  let server: Server
  let requests: string[]
  let prSha: string
  let previousGlobal: string | undefined
  let author: string
  let authorGit: (...args: string[]) => string

  const marked = () => readdirSync(markers).sort()
  /**
   * The server shares this process, whose event loop Git's synchronous runs block: a request is counted only once they
   * have returned. A moment to let it be counted makes "no request" mean no request.
   */
  const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 400))
  const workspaceOf = (threadId: string) => new ThreadWorkspaceManager(mms.threads.getThreadDir(threadId)).load()!

  const detailOf = (): PullRequestDetail => ({
    ...parsePullRequestDetail(
      { host: 'github.com', nameWithOwner: 'acme/app', number: 7 },
      readFileSync(new URL('./fixtures/github/pr-view.json', import.meta.url), 'utf8'),
      []
    )!,
    state: 'open',
    headRefName: 'fix-thing',
    headSha: prSha,
    headRepository: 'bob/app',
    baseRepository: 'acme/app',
    isCrossRepository: true
  })

  beforeEach(async () => {
    f = gitFoundationFixture()
    markers = join(f.root, 'markers')
    mkdirSync(markers)
    requests = []
    server = createServer((request, response) => {
      requests.push(request.url ?? '')
      response.end('{}')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    const marker = (name: string) => `echo ran > "${join(markers, name).split('\\').join('/')}"`

    const baseBare = join(f.root, 'base.git')
    git(f.root, 'init', '-q', '--bare', baseBare)
    git(f.repo, 'remote', 'add', 'origin', join(f.root, 'fork-does-not-exist.git'))
    git(f.repo, 'remote', 'add', 'upstream', baseBare)
    git(f.repo, 'push', '-q', 'upstream', 'HEAD:refs/heads/main')

    // The contributor's own Git runs with no system or user configuration (Git LFS is installed system-wide on some machines).
    author = join(f.root, 'author')
    const emptyConfig = join(f.root, 'empty.gitconfig')
    writeFileSync(emptyConfig, '')
    authorGit = (...args: string[]) =>
      execFileSync('git', args, { cwd: author, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: emptyConfig } }).trim()
    git(f.root, 'clone', '-q', '--branch', 'main', baseBare, author)
    authorGit('config', 'user.name', 'Contributor')
    authorGit('config', 'user.email', 'contributor@example.test')
    authorGit('config', 'core.autocrlf', 'false')
    authorGit('config', 'core.hooksPath', join(f.root, 'author-no-hooks'))
    mkdirSync(join(author, '.githooks'))
    mkdirSync(join(author, 'tools'))
    for (const hook of HOOKS) writeFileSync(join(author, '.githooks', hook), `#!/bin/sh\n${marker(hook)}\n`)
    writeFileSync(join(author, 'tools', 'smudge.sh'), `${marker('smudge')}\ncat\n`)
    writeFileSync(join(author, 'tools', 'clean.sh'), `${marker('clean')}\ncat\n`)
    writeFileSync(join(author, 'tools', 'process.sh'), `${marker('process')}\n`)
    writeFileSync(join(author, 'tools', 'lfs.sh'), `${marker('lfs')}\nnode -e "const r = require('http').get('http://127.0.0.1:${port}/lfs-smudge', { agent: false }); r.on('error', () => {}); setTimeout(() => process.exit(0), 300)"\ncat\n`)
    writeFileSync(join(author, '.lfsconfig'), `[lfs]\n\turl = http://127.0.0.1:${port}/lfs\n`)
    writeFileSync(join(author, '.gitattributes'), '*.dat filter=evil\n*.bin filter=lfsx\n*.prc filter=proc\n')
    // Named to sort after tools/, so the scripts are in the checkout before the first file that needs them.
    writeFileSync(join(author, 'zdata.dat'), 'dat content\n')
    writeFileSync(join(author, 'zbig.bin'), 'bin content\n')
    writeFileSync(join(author, 'zproc.prc'), 'prc content\n')
    writeFileSync(join(author, 'value.txt'), 'pull request value\n')
    authorGit('add', '-A')
    for (const hook of HOOKS) authorGit('update-index', '--chmod=+x', `.githooks/${hook}`)
    authorGit('commit', '-qm', 'pull request')
    authorGit('push', '-q', 'origin', 'HEAD:refs/pull/7/head')
    prSha = authorGit('rev-parse', 'HEAD')

    // The project's own setup: a repository-relative hooks folder, and filter drivers that run scripts of the checkout
    // (user-level configuration, as Git LFS installs it), put in place after the contributor made the commit.
    const globalConfig = join(f.root, 'global.gitconfig')
    writeFileSync(globalConfig, [
      '[filter "evil"]', '\tsmudge = sh tools/smudge.sh', '\tclean = sh tools/clean.sh', '\trequired = false',
      // Named like Git LFS's driver but not it: the machine's own Git LFS is installed system-wide on some machines.
      '[filter "lfsx"]', '\tsmudge = sh tools/lfs.sh %f', '\tclean = cat', '\trequired = false',
      '[filter "proc"]', '\tprocess = sh tools/process.sh', '\trequired = false',
      ''
    ].join('\n'))
    previousGlobal = process.env.GIT_CONFIG_GLOBAL
    process.env.GIT_CONFIG_GLOBAL = globalConfig
    git(f.repo, 'config', 'core.hooksPath', '.githooks')

    const runner: ExecutableRunner = async (executable, args, options) =>
      executable === 'git' && args[0] === 'remote' && args[1] === '-v' ? { stdout: REMOTES, stderr: '' } : execRunner(executable, args, options)
    host = new GitHubCodeHost(runner)
    vi.spyOn(host, 'repositoryIdentity').mockResolvedValue({ host: 'github.com', nameWithOwner: 'acme/app' })
    vi.spyOn(host, 'getPullRequestDetail').mockImplementation(async () => detailOf())

    mms = await MousseMainService.create({ homeDir: f.home, headless: true, ownerKind: 'test' })
    await mms.start()
    projectId = mms.projects.openProject(f.repo).id
    service = new PullRequestThreadService({ codeHost: host, projects: mms.projects, threads: mms.threads, trashThread: async () => ({}), send: async () => {} })
  }, 60_000)

  afterEach(async () => {
    vi.restoreAllMocks()
    await mms?.stop()
    server?.closeAllConnections()
    await new Promise<void>((resolve) => server?.close(() => resolve()))
    if (previousGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL
    else process.env.GIT_CONFIG_GLOBAL = previousGlobal
    f?.dispose()
  })

  it('control: an ordinary worktree of the same commit runs the filters and the hooks of the checkout, and reaches the server', async () => {
    // Without Mousse's care the setup does what the pull request wants, so the tests below can tell.
    git(f.repo, 'fetch', '-q', 'upstream', 'refs/pull/7/head:refs/mousse/control')
    const control = join(f.root, 'control-worktree')
    git(f.repo, 'worktree', 'add', '-q', control, 'refs/mousse/control')
    git(control, 'commit', '-q', '--no-verify', '--allow-empty', '-m', 'x')
    expect(marked()).toEqual(expect.arrayContaining(['smudge', 'lfs', 'process', 'post-commit', 'reference-transaction']))
    // The `lfs` marker is the proof that the smudge script, which also calls the server, ran. (The call itself is cut off
    // when that script exits, before this process can answer, so the request count is not asserted here.)
  })

  it("starts the thread without running a filter, a hook or a request to the pull request's server, and keeps the files as committed", async () => {
    const started = await service.startThread({ projectId, reference: '7', allowWorktreeConfig: true })
    const workspace = workspaceOf(started.thread.id)
    expect(workspace).toMatchObject({ lifecycle: 'ready', untrusted: true })

    expect(marked()).toEqual([])
    await settle()
    expect(requests).toEqual([])
    expect(git(workspace.worktreePath, 'rev-parse', 'HEAD')).toBe(prSha)
    expect(f.read(workspace.worktreePath, 'zdata.dat')).toBe('dat content\n')
    expect(f.read(workspace.worktreePath, 'zbig.bin')).toBe('bin content\n')
    expect(f.read(workspace.worktreePath, 'zproc.prc')).toBe('prc content\n')
    // The safety belongs to the worktree: nothing changed for the project's own checkout.
    expect(git(f.repo, 'config', '--local', '--get', 'core.hooksPath')).toBe('.githooks')
    expect(git(workspace.worktreePath, 'config', '--show-scope', '--get', 'core.hooksPath')).toMatch(/^worktree\s+\/dev\/null$/)
    expect(git(workspace.worktreePath, 'config', '--worktree', '--get', 'filter.evil.smudge')).toBe('')
    expect(git(workspace.worktreePath, 'config', '--worktree', '--get', 'filter.proc.process')).toBe('')
    expect(git(workspace.worktreePath, 'config', '--worktree', '--get', 'core.fsmonitor')).toBe('false')
    expect(git(workspace.worktreePath, 'config', '--worktree', '--get', 'submodule.recurse')).toBe('false')
  }, 60_000)

  it("runs no hook or filter in the commands Mousse runs there afterwards: the checkpoint commit, the side card's Commit and Push", async () => {
    const { thread } = await service.startThread({ projectId, reference: '7', allowWorktreeConfig: true })
    const { worktreePath } = workspaceOf(thread.id)
    expect(marked()).toEqual([])

    // The checkpoint commit of a turn, exactly as the action service runs it.
    writeFileSync(join(worktreePath, 'zturn.dat'), 'agent output\n')
    writeFileSync(join(worktreePath, 'zturn.bin'), 'agent binary\n')
    actionGit(worktreePath, ['add', '-A', '--', '.', ':(exclude).mousse/**'])
    actionGit(worktreePath, ['commit', '--no-verify', '-m', 'mousse: checkpoint turn'])
    expect(marked()).toEqual([])
    await settle()
    expect(requests).toEqual([])

    // The side card's Commit (which lets hooks run) and Push (to the pull request's branch).
    writeFileSync(join(worktreePath, 'edit.txt'), 'an edit\n')
    await mms.gitService.commit(worktreePath, 'A commit from the side card', { all: true })
    expect(marked()).toEqual([])
    await mms.gitService.push(worktreePath, { toRemote: 'upstream', toBranch: 'fix-thing' })
    expect(git(join(f.root, 'base.git'), 'rev-parse', 'refs/heads/fix-thing')).toBe(git(worktreePath, 'rev-parse', 'HEAD'))
    // A plain status or diff runs no filter either.
    git(worktreePath, 'status', '--porcelain')
    git(worktreePath, 'diff', 'HEAD~1')
    expect(marked()).toEqual([])
    await settle()
    expect(requests).toEqual([])
  }, 90_000)

  it('keeps the safety when the worktree is made again after it was removed', async () => {
    const { thread } = await service.startThread({ projectId, reference: '7', allowWorktreeConfig: true })
    const workspace = workspaceOf(thread.id)
    git(f.repo, 'worktree', 'remove', '--force', workspace.worktreePath)
    expect(existsSync(workspace.worktreePath)).toBe(false)

    const restored = await new ThreadWorkspaceManager(mms.threads.getThreadDir(thread.id)).restore(f.repo)
    expect(restored.lifecycle).toBe('ready')
    expect(git(restored.worktreePath, 'config', '--show-scope', '--get', 'core.hooksPath')).toMatch(/^worktree\s+\/dev\/null$/)
    git(restored.worktreePath, 'commit', '-q', '--no-verify', '--allow-empty', '-m', 'x')
    expect(marked()).toEqual([])
    await settle()
    expect(requests).toEqual([])
  }, 60_000)

  it('keeps the safety when storage cleanup retires the worktree and it is rebuilt from its manifest', async () => {
    // Storage cleanup keeps a checkout that uses external filters, so the pull request drops them in a later commit (the hooks remain).
    authorGit('rm', '-q', '.gitattributes')
    authorGit('commit', '-qm', 'drop the attributes')
    authorGit('push', '-q', '--force', 'origin', 'HEAD:refs/pull/7/head')
    prSha = authorGit('rev-parse', 'HEAD')
    const { thread } = await service.startThread({ projectId, reference: '7', allowWorktreeConfig: true })
    const workspace = workspaceOf(thread.id)
    // An inactive-worktree rule 40 days on retires it; only manual runs may act, as a scheduled one could retire it again.
    const manualRun = mms.storageCleanup.run.bind(mms.storageCleanup)
    vi.spyOn(mms.storageCleanup, 'run').mockImplementation((trigger) => (trigger === 'manual' ? manualRun(trigger) : Promise.resolve({} as never)))
    mms.storageCleanup.setClockForTests(() => Date.now() + 40 * 86_400_000)
    mms.storagePolicy.configure({ schemaVersion: 1, worktrees: { removeWithDeletedThreads: true, inactiveDays: 30, removeMerged: false }, browser: { captureDays: null } }, true)
    // The rule needs the repository's default branch, which a clone would have recorded.
    // Its commits count as published when the default branch already holds them (as after the pull request is merged).
    git(f.repo, 'update-ref', 'refs/remotes/origin/main', prSha)
    git(f.repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main')
    const report = await manualRun('manual')
    expect(report.items.find((entry) => entry.threadId === thread.id), JSON.stringify(report.items)).toMatchObject({ rule: 'worktree-inactive', outcome: 'removed' })
    expect(existsSync(workspace.worktreePath)).toBe(false)
    expect(marked()).toEqual([])

    // With the repository's per-worktree settings turned off since, the rebuild is refused before anything is registered:
    // no empty folder that would read as ready, and the setting is not turned on again.
    const registered = () => git(f.repo, 'worktree', 'list', '--porcelain').split('\n').filter((line) => line.startsWith('worktree '))
    const before = registered()
    git(f.repo, 'config', '--local', '--unset', 'extensions.worktreeConfig')
    const manager = new ThreadWorkspaceManager(mms.threads.getThreadDir(thread.id))
    await expect(manager.restore(f.repo)).rejects.toThrow(/per-worktree Git settings are off/)
    expect(registered()).toEqual(before)
    expect(existsSync(workspace.worktreePath)).toBe(false)
    expect(manager.verify().lifecycle).not.toBe('ready')
    expect(() => git(f.repo, 'config', '--local', '--get', 'extensions.worktreeConfig')).toThrow()

    // Turned on again, the same restore rebuilds the whole worktree with its safety.
    git(f.repo, 'config', '--local', 'extensions.worktreeConfig', 'true')
    const restored = await manager.restore(f.repo)
    expect(restored.lifecycle).toBe('ready')
    expect(git(restored.worktreePath, 'status', '--porcelain')).toBe('')
    expect(f.read(restored.worktreePath, 'value.txt')).toBe('pull request value\n')
    expect(git(restored.worktreePath, 'config', '--show-scope', '--get', 'core.hooksPath')).toMatch(/^worktree\s+\/dev\/null$/)
    expect(git(restored.worktreePath, 'config', '--worktree', '--get', 'filter.evil.smudge')).toBe('')
    git(restored.worktreePath, 'commit', '-q', '--no-verify', '--allow-empty', '-m', 'x')
    // Nothing ran while it was rebuilt or afterwards.
    expect(marked()).toEqual([])
    await settle()
    expect(requests).toEqual([])
  }, 120_000)

  it('refuses, and leaves nothing, when a filter driver is configured for the repository itself', async () => {
    git(f.repo, 'config', 'filter.evil.smudge', 'sh tools/smudge.sh')
    const threadsBefore = mms.threads.listAllThreads().length
    await expect(service.startThread({ projectId, reference: '7', allowWorktreeConfig: true })).rejects.toMatchObject({
      code: 'pull_request_workspace_failed',
      message: expect.stringContaining('Safe checkout refuses configured external clean, smudge or process filters.')
    })
    expect(mms.threads.listAllThreads()).toHaveLength(threadsBefore)
    expect(marked()).toEqual([])
    // Refused before the repository's configuration was changed.
    expect(() => git(f.repo, 'config', '--local', '--get', 'extensions.worktreeConfig')).toThrow()
  }, 60_000)
})
