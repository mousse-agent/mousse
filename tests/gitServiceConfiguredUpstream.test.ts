import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
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

  it('does not silently create an origin tracking branch when plain push lacks an upstream', async () => {
    const fixture = repo()
    git(fixture.cwd, 'branch', '--unset-upstream')
    await expect(new GitService().push(fixture.cwd)).rejects.toThrow()
    expect(() => git(fixture.cwd, 'rev-parse', '--abbrev-ref', '@{upstream}')).toThrow()
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
})
