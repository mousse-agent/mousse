import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearGitPolicyLog, GitPolicyError, gitPolicyLog, userAction, type UserAction } from '../src/mms/git/gitPolicy'
import { GitService } from '../src/mms/git/GitService'

/**
 * A canary for the central Git check on GitService: with refusal on, every read and every change the user
 * asked for runs without a single violation, and a change without the user's request is refused before
 * Git changes anything.
 */

const roots: string[] = []
const USER = userAction('button', 'Canary')
const NO_REQUEST = undefined as unknown as UserAction

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mousse-policy-canary-')))
  roots.push(root)
  const origin = join(root, 'origin.git')
  const cwd = join(root, 'work')
  git(root, 'init', '-q', '--bare', '-b', 'main', origin)
  git(root, 'init', '-q', '-b', 'main', cwd)
  for (const [key, value] of [['user.name', 'Canary'], ['user.email', 'canary@example.invalid'], ['commit.gpgsign', 'false'], ['core.hooksPath', join(root, 'no-hooks')]]) git(cwd, 'config', key!, value!)
  git(cwd, 'remote', 'add', 'origin', origin)
  writeFileSync(join(cwd, 'a.txt'), 'a\n')
  git(cwd, 'add', '-A'); git(cwd, 'commit', '-qm', 'base'); git(cwd, 'push', '-q', '-u', 'origin', 'main')
  return { root, origin, cwd }
}

beforeEach(() => {
  vi.stubEnv('MOUSSE_GIT_POLICY', 'refuse')
  clearGitPolicyLog()
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('GitService under the central Git check', () => {
  it('reads without a violation', async () => {
    const { cwd } = fixture()
    writeFileSync(join(cwd, 'a.txt'), 'changed\n'); writeFileSync(join(cwd, 'new.txt'), 'new\n')
    const service = new GitService()
    await service.getStatus(cwd)
    await service.getDiff(cwd, 'a.txt', false)
    await service.getDiff(cwd, 'new.txt', false)
    await service.getLog(cwd)
    await service.getBranches(cwd)
    await service.getDiffStats(cwd)
    await service.lastCommitMessage(cwd)
    await service.describeCommitInput(cwd)
    await service.readBranchSummary(cwd, { branch: 'main', base: 'main', remote: 'origin' })
    expect(gitPolicyLog()).toEqual([])
  })

  it('runs every change the user asked for without a violation', async () => {
    const { origin, cwd, root } = fixture()
    const service = new GitService()
    writeFileSync(join(cwd, 'b.txt'), 'b\n')
    await service.stage(cwd, USER, ['b.txt'])
    await service.unstage(cwd, USER, ['b.txt'])
    await service.stageAll(cwd, USER)
    await service.unstageAll(cwd, USER)
    await service.commit(cwd, USER, 'b')
    await service.createBranch(cwd, USER, 'feature', { checkout: false })
    await service.renameBranch(cwd, USER, 'feature', 'feature-2')
    await service.checkout(cwd, USER, 'feature-2')
    await service.checkout(cwd, USER, 'main')
    await service.deleteBranch(cwd, USER, 'feature-2', { force: true })
    await service.push(cwd, USER)
    await service.fetch(cwd, USER)
    await service.pull(cwd, USER)
    writeFileSync(join(cwd, 'a.txt'), 'discard me\n')
    await service.discard(cwd, USER, ['a.txt'])
    mkdirSync(join(root, 'fresh'))
    await service.init(join(root, 'fresh'), USER)
    expect(gitPolicyLog()).toEqual([])
    expect(git(origin, 'rev-parse', 'main')).toBe(git(cwd, 'rev-parse', 'HEAD'))
  })

  it('refuses a change without the user\'s request before Git changes anything', async () => {
    const { origin, cwd } = fixture()
    const service = new GitService()
    const head = git(cwd, 'rev-parse', 'HEAD')
    writeFileSync(join(cwd, 'b.txt'), 'b\n')
    git(cwd, 'add', 'b.txt')
    await expect(service.commit(cwd, NO_REQUEST, 'sneaky')).rejects.toBeInstanceOf(GitPolicyError)
    expect(git(cwd, 'rev-parse', 'HEAD')).toBe(head)
    git(cwd, 'commit', '-qm', 'local')
    await expect(service.push(cwd, NO_REQUEST)).rejects.toBeInstanceOf(GitPolicyError)
    expect(git(origin, 'rev-parse', 'main')).toBe(head)
    await expect(service.createBranch(cwd, NO_REQUEST, 'sneaky', { checkout: false })).rejects.toBeInstanceOf(GitPolicyError)
    expect(git(cwd, 'branch', '--list', 'sneaky')).toBe('')
    expect(gitPolicyLog().every((entry) => entry.kind === 'violation')).toBe(true)
    expect(gitPolicyLog().length).toBeGreaterThanOrEqual(3)
  })

  it('only logs a missing request while refusal is off', async () => {
    vi.stubEnv('MOUSSE_GIT_POLICY', 'log')
    const { cwd } = fixture()
    await new GitService().createBranch(cwd, NO_REQUEST, 'logged', { checkout: false })
    expect(git(cwd, 'branch', '--list', 'logged')).toBe('logged')
    expect(gitPolicyLog().at(-1)).toMatchObject({ kind: 'violation', command: expect.stringContaining('git branch logged') })
  })
})
