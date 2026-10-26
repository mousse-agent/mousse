import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { nonInteractiveGitEnv } from '../src/mms/git/gitEnv'
import { GitService } from '../src/mms/git/GitService'

const roots: string[] = []
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function repo() {
  const root = mkdtempSync(join(tmpdir(), 'mousse-upstream-regression-'))
  roots.push(root)
  const origin = join(root, 'origin.git')
  const upstream = join(root, 'upstream.git')
  const cwd = join(root, 'work')
  git(root, 'init', '--bare', origin)
  git(root, 'init', '--bare', upstream)
  git(root, 'init', '-b', 'main', cwd)
  git(cwd, 'config', 'user.name', 'Git regression fixture')
  git(cwd, 'config', 'user.email', 'git-fixture@example.invalid')
  // Prevent host signing/hooks/push defaults from influencing this fixture.
  git(cwd, 'config', 'commit.gpgsign', 'false')
  git(cwd, 'config', 'core.hooksPath', join(root, 'no-hooks'))
  git(cwd, 'config', 'push.default', 'upstream')
  git(cwd, 'remote', 'add', 'origin', origin)
  git(cwd, 'remote', 'add', 'team', upstream)
  writeFileSync(join(cwd, 'base.txt'), 'base\n')
  git(cwd, 'add', 'base.txt')
  git(cwd, 'commit', '-m', 'baseline')
  const base = git(cwd, 'rev-parse', 'HEAD')
  git(cwd, 'push', 'origin', 'HEAD:main')
  git(cwd, 'push', 'team', 'HEAD:release')
  git(cwd, 'checkout', '-b', 'feature')
  git(cwd, 'branch', '--set-upstream-to=team/release')
  writeFileSync(join(cwd, 'local.txt'), 'local change\n')
  git(cwd, 'add', 'local.txt')
  git(cwd, 'commit', '-m', 'local result')
  const local = git(cwd, 'rev-parse', 'HEAD')
  return { cwd, origin, upstream, base, local }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('GitService configured upstream and push behavior', () => {
  it('compares against a differently named branch on an alternate remote', async () => {
    const fixture = repo()
    // A same-name origin branch would conceal the configured-upstream bug.
    git(fixture.cwd, 'push', 'origin', 'HEAD:feature')
    const service = new GitService()
    const status = await service.getStatus(fixture.cwd)
    expect(status).toMatchObject({ branch: 'feature', ahead: 1, behind: 0, upstream: 'team/release', tracking: 'tracked' })
  })

  it('labels commits against the configured upstream even with an origin same-name branch', async () => {
    const fixture = repo()
    git(fixture.cwd, 'push', 'origin', 'HEAD:feature')
    const service = new GitService()
    const log = await service.getLog(fixture.cwd)
    expect(log.find((commit) => commit.hash === fixture.local)?.pushed).toBe(false)
    expect(log.find((commit) => commit.hash === fixture.base)?.pushed).toBe(true)
  })

  it('pushes to the configured differently named upstream without changing tracking', async () => {
    const fixture = repo()
    await new GitService().push(fixture.cwd)
    expect(git(fixture.upstream, 'rev-parse', 'refs/heads/release')).toBe(fixture.local)
    expect(git(fixture.cwd, 'rev-parse', '--abbrev-ref', '@{upstream}')).toBe('team/release')
    expect(() => git(fixture.origin, 'rev-parse', '--verify', 'refs/heads/feature')).toThrow()
  })

  it('honors branch pushRemote and push.default=current rather than rewriting upstream', async () => {
    const fixture = repo()
    git(fixture.cwd, 'config', 'branch.feature.pushRemote', 'team')
    git(fixture.cwd, 'config', 'push.default', 'current')
    await new GitService().push(fixture.cwd)
    expect(git(fixture.upstream, 'rev-parse', 'refs/heads/feature')).toBe(fixture.local)
    expect(git(fixture.upstream, 'rev-parse', 'refs/heads/release')).toBe(fixture.base)
    expect(git(fixture.cwd, 'rev-parse', '--abbrev-ref', '@{upstream}')).toBe('team/release')
  })

  it('publishes to origin and sets the upstream when plain push lacks one', async () => {
    const fixture = repo()
    git(fixture.cwd, 'branch', '--unset-upstream')
    await new GitService().push(fixture.cwd)
    expect(git(fixture.cwd, 'rev-parse', '--abbrev-ref', '@{upstream}')).toBe('origin/feature')
    expect(git(fixture.origin, 'rev-parse', '--verify', 'refs/heads/feature')).toBe(git(fixture.cwd, 'rev-parse', 'HEAD'))
  })

  it('publishes to the branch pushRemote when one is configured', async () => {
    const fixture = repo()
    git(fixture.cwd, 'branch', '--unset-upstream')
    git(fixture.cwd, 'config', 'branch.feature.pushRemote', 'team')
    await new GitService().push(fixture.cwd)
    expect(git(fixture.cwd, 'rev-parse', '--abbrev-ref', '@{upstream}')).toBe('team/feature')
    expect(() => git(fixture.origin, 'rev-parse', '--verify', 'refs/heads/feature')).toThrow()
  })

  it('reports no-upstream state separately from zero counts and marks all commits local', async () => {
    const fixture = repo()
    git(fixture.cwd, 'branch', '--unset-upstream')
    const service = new GitService()
    expect(await service.getStatus(fixture.cwd)).toMatchObject({ upstream: null, tracking: 'none', ahead: 0, behind: 0 })
    expect((await service.getLog(fixture.cwd)).every((commit) => !commit.pushed)).toBe(true)
  })

  it('reports detached HEAD rather than comparing an origin branch named HEAD', async () => {
    const fixture = repo()
    git(fixture.cwd, 'checkout', '--detach')
    expect(await new GitService().getStatus(fixture.cwd)).toMatchObject({ branch: null, upstream: null, tracking: 'detached', ahead: 0, behind: 0 })
  })

  it('reports an unborn branch without requiring rev-list to succeed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mousse-upstream-regression-')); roots.push(root)
    git(root, 'init', '-b', 'new-work')
    expect(await new GitService().getStatus(root)).toMatchObject({ branch: 'new-work', upstream: null, tracking: 'unborn', ahead: 0, behind: 0 })
  })

  it('commits the first files on an unborn branch', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mousse-upstream-regression-')); roots.push(root)
    git(root, 'init', '-b', 'new-work'); git(root, 'config', 'user.name', 'x'); git(root, 'config', 'user.email', 'x@example.invalid')
    git(root, 'config', 'commit.gpgsign', 'false'); git(root, 'config', 'core.hooksPath', join(root, 'no-hooks'))
    writeFileSync(join(root, 'a.txt'), 'a\n'); writeFileSync(join(root, 'b.txt'), 'b\n')
    await new GitService().stage(root, ['a.txt'])
    await new GitService().commit(root, 'first')
    expect(git(root, 'show', '--name-only', '--format=', 'HEAD')).toBe('a.txt')
    await new GitService().commit(root, 'second')
    expect(git(root, 'show', '--name-only', '--format=', 'HEAD')).toBe('b.txt')
  })
})

/** `main` tracks origin/main; `peer` is a second clone that moves the remote on. */
function synced() {
  const root = mkdtempSync(join(tmpdir(), 'mousse-sync-')); roots.push(root)
  const origin = join(root, 'origin.git'), cwd = join(root, 'work'), peer = join(root, 'peer')
  git(root, 'init', '--bare', '-b', 'main', origin)
  const configure = (dir: string) => {
    git(dir, 'config', 'user.name', 'Sync fixture'); git(dir, 'config', 'user.email', 'git-fixture@example.invalid')
    git(dir, 'config', 'commit.gpgsign', 'false'); git(dir, 'config', 'core.hooksPath', join(root, 'no-hooks'))
    git(dir, 'config', 'pull.rebase', 'false')
  }
  git(root, 'clone', origin, cwd); configure(cwd)
  writeFileSync(join(cwd, 'shared.txt'), 'one\n'); git(cwd, 'add', '-A'); git(cwd, 'commit', '-m', 'one'); git(cwd, 'push', '-u', 'origin', 'main')
  git(root, 'clone', origin, peer); configure(peer)
  const remoteCommit = (name: string, text: string, message: string) => {
    writeFileSync(join(peer, name), text); git(peer, 'add', '-A'); git(peer, 'commit', '-m', message); git(peer, 'push', 'origin', 'main')
  }
  const localCommit = (name: string, text: string, message: string) => {
    writeFileSync(join(cwd, name), text); git(cwd, 'add', '-A'); git(cwd, 'commit', '-m', message)
  }
  return { root, origin, cwd, peer, remoteCommit, localCommit }
}

describe('GitService fetch and pull', () => {
  it('fetch reports how far behind the branch was and is afterwards', async () => {
    const { cwd, remoteCommit } = synced(), service = new GitService()
    await expect(service.fetch(cwd)).resolves.toEqual({ behindBefore: 0, behindAfter: 0 })
    remoteCommit('two.txt', 'two\n', 'two'); remoteCommit('three.txt', 'three\n', 'three')
    await expect(service.fetch(cwd)).resolves.toEqual({ behindBefore: 0, behindAfter: 2 })
    expect(await service.getStatus(cwd)).toMatchObject({ behind: 2, ahead: 0 })
    await expect(service.fetch(cwd)).resolves.toEqual({ behindBefore: 2, behindAfter: 2 })
  })

  it('fetch without a remote says so', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mousse-sync-')); roots.push(root)
    git(root, 'init', '-b', 'main')
    await expect(new GitService().fetch(root)).rejects.toMatchObject({ code: 'git_no_remote' })
  })

  it('pull fast-forwards, and reports up to date when there is nothing new', async () => {
    const { cwd, remoteCommit } = synced(), service = new GitService()
    await expect(service.pull(cwd)).resolves.toEqual({ result: 'up-to-date' })
    remoteCommit('two.txt', 'two\n', 'two')
    await expect(service.pull(cwd)).resolves.toEqual({ result: 'fast-forwarded' })
    expect(git(cwd, 'log', '-1', '--format=%s')).toBe('two')
  })

  it('pull is fast-forward only: diverged branches report git_pull_diverged and change nothing', async () => {
    const { cwd, remoteCommit, localCommit } = synced(), service = new GitService()
    remoteCommit('remote.txt', 'r\n', 'remote'); localCommit('local.txt', 'l\n', 'local')
    const head = git(cwd, 'rev-parse', 'HEAD')
    // pull.rebase=false is configured on purpose: the strategy is the caller's choice, not the user's config.
    await expect(service.pull(cwd)).rejects.toMatchObject({ code: 'git_pull_diverged' })
    expect(git(cwd, 'rev-parse', 'HEAD')).toBe(head)
    expect((await service.getStatus(cwd)).inProgress).toBeNull()
  })

  it('pull with merge joins diverged branches', async () => {
    const { cwd, remoteCommit, localCommit } = synced()
    remoteCommit('remote.txt', 'r\n', 'remote'); localCommit('local.txt', 'l\n', 'local')
    await expect(new GitService().pull(cwd, { strategy: 'merge' })).resolves.toEqual({ result: 'merged' })
    expect(git(cwd, 'rev-list', '--parents', '-n', '1', 'HEAD').split(' ')).toHaveLength(3)
  })

  it('pull with rebase replays local commits on top', async () => {
    const { cwd, remoteCommit, localCommit } = synced()
    remoteCommit('remote.txt', 'r\n', 'remote'); localCommit('local.txt', 'l\n', 'local')
    await expect(new GitService().pull(cwd, { strategy: 'rebase' })).resolves.toEqual({ result: 'rebased' })
    expect(git(cwd, 'log', '--format=%s', '-3')).toBe('local\nremote\none')
  })

  it('pull with merge or rebase that stops on a conflict returns conflicted, shows it in status and can be aborted', async () => {
    for (const strategy of ['merge', 'rebase'] as const) {
      const { cwd, remoteCommit, localCommit } = synced(), service = new GitService()
      remoteCommit('shared.txt', 'remote edit\n', 'remote'); localCommit('shared.txt', 'local edit\n', 'local')
      const head = git(cwd, 'rev-parse', 'HEAD')
      await expect(service.pull(cwd, { strategy })).resolves.toEqual({ result: 'conflicted' })
      const status = await service.getStatus(cwd)
      expect(status.inProgress).toBe(strategy)
      expect(status.changes).toEqual([{ path: 'shared.txt', status: 'conflicted', staged: false }])
      await service.abortInProgress(cwd, strategy)
      expect((await service.getStatus(cwd)).inProgress).toBeNull()
      expect(git(cwd, 'rev-parse', 'HEAD')).toBe(head)
      expect(git(cwd, 'status', '--porcelain')).toBe('')
    }
  })

  it('pull on a branch without an upstream says so', async () => {
    const { cwd } = synced()
    git(cwd, 'checkout', '-b', 'local-only')
    await expect(new GitService().pull(cwd)).rejects.toMatchObject({ code: 'git_no_upstream' })
  })

  it('pull refuses to overwrite uncommitted changes', async () => {
    const { cwd, remoteCommit } = synced()
    remoteCommit('shared.txt', 'remote edit\n', 'remote'); writeFileSync(join(cwd, 'shared.txt'), 'dirty\n')
    await expect(new GitService().pull(cwd)).rejects.toMatchObject({ code: 'git_pull_dirty' })
    expect(readFileSync(join(cwd, 'shared.txt'), 'utf8')).toBe('dirty\n')
  })
})

describe('GitService push failures', () => {
  it('classifies a non-fast-forward push to a bare remote and honors expectedBranch', async () => {
    const { cwd, remoteCommit, localCommit } = synced(), service = new GitService()
    remoteCommit('remote.txt', 'r\n', 'remote'); localCommit('local.txt', 'l\n', 'local')
    await expect(service.push(cwd)).rejects.toMatchObject({ code: 'git_push_rejected', errorInfo: { category: 'conflict' } })
    git(cwd, 'checkout', '-b', 'moved')
    await expect(service.push(cwd, { expectedBranch: 'main' })).rejects.toMatchObject({ code: 'git_branch_changed' })
    expect(() => git(cwd, 'rev-parse', '--verify', 'origin/moved')).toThrow()
  })

  it('classifies a hook on the remote that rejects the push', async () => {
    const { cwd, origin, localCommit } = synced()
    const hooks = join(origin, 'hooks'); mkdirSync(hooks, { recursive: true })
    writeFileSync(join(hooks, 'pre-receive'), '#!/bin/sh\necho "no pushes today" >&2\nexit 1\n', { mode: 0o755 })
    localCommit('local.txt', 'l\n', 'local')
    await expect(new GitService().push(cwd)).rejects.toMatchObject({ code: 'git_push_rejected_by_remote' })
  })

  it('classifies an unreachable remote', async () => {
    const { cwd, localCommit } = synced()
    git(cwd, 'remote', 'set-url', 'origin', 'https://127.0.0.1:9/x.git'); git(cwd, 'config', 'credential.helper', '')
    localCommit('local.txt', 'l\n', 'local')
    await expect(new GitService().push(cwd)).rejects.toMatchObject({ code: 'git_remote_unreachable' })
  })

  it('classifies a remote that asks for credentials nobody can type, without opening a prompt', async () => {
    const { cwd, localCommit } = synced()
    const server = createServer((_request, response) => { response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="fixture"' }); response.end() })
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
    try {
      const { port } = server.address() as AddressInfo
      git(cwd, 'remote', 'set-url', 'origin', `http://127.0.0.1:${port}/x.git`); git(cwd, 'config', 'credential.helper', '')
      localCommit('local.txt', 'l\n', 'local')
      // The fixture must never open a credential window on a developer machine.
      for (const [key, value] of Object.entries(nonInteractiveGitEnv())) vi.stubEnv(key, value)
      const started = Date.now()
      await expect(new GitService().push(cwd)).rejects.toMatchObject({ code: 'git_auth_failed' })
      expect(Date.now() - started).toBeLessThan(30_000)
    } finally {
      vi.unstubAllEnvs()
      await new Promise((done) => server.close(done))
    }
  })
})
