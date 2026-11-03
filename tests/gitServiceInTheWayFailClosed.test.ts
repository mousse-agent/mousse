import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GitService } from '../src/mms/git/GitService'
import { userAction } from '../src/mms/git/gitPolicy'

/**
 * The check before a switch or a pull fails closed: when a Git read it needs fails (a listing cut off, a merge Git
 * cannot work out), the action is refused in plain words and nothing is changed, rather than run with part of what it
 * writes unchecked.
 */

const faults = vi.hoisted(() => ({ command: '' }))
vi.mock('../src/mms/actions/git', async (original) => {
  const real = await original<typeof import('../src/mms/actions/git')>()
  return {
    ...real,
    tryGitRawAsync: async (cwd: string, args: string[], ...rest: [string?, { maxBuffer?: number }?]) =>
      args[0] === faults.command ? { ok: false, status: null, stdout: '', stderr: 'probe: listing exceeded limit' } : real.tryGitRawAsync(cwd, args, ...rest)
  }
})

const USER = userAction('button', 'Test action')
const roots: string[] = []
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const write = (cwd: string, name: string, text: string) => { mkdirSync(dirname(join(cwd, name)), { recursive: true }); writeFileSync(join(cwd, name), text) }
const bytes = (cwd: string, path: string) => (existsSync(join(cwd, path)) ? readFileSync(join(cwd, path), 'utf8') : '<missing>')
const identity = (cwd: string) => {
  git(cwd, 'config', 'user.name', 'Fixture'); git(cwd, 'config', 'user.email', 'fixture@example.invalid')
  git(cwd, 'config', 'commit.gpgsign', 'false'); git(cwd, 'config', 'core.hooksPath', join(cwd, '.no-hooks'))
}
const commitAll = (cwd: string, message: string) => { git(cwd, 'add', '-A'); git(cwd, 'commit', '-qm', message) }
function repo(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'mousse-fail-closed-')); roots.push(cwd)
  git(cwd, 'init', '-q', '-b', 'main'); identity(cwd)
  write(cwd, 'base.txt', 'base\n'); write(cwd, '.gitignore', '.env\nignored/\n'); commitAll(cwd, 'baseline')
  return cwd
}
function withRemote(cwd: string): (change: (other: string) => void) => void {
  const origin = `${cwd}-origin.git`, other = `${cwd}-other`; roots.push(origin, other)
  git(dirname(cwd), 'init', '--bare', '-q', origin)
  git(cwd, 'remote', 'add', 'origin', origin); git(cwd, 'push', '-q', '-u', 'origin', 'main')
  git(dirname(cwd), 'clone', '-q', '-b', 'main', origin, other); identity(other)
  return (change) => { change(other); git(other, 'push', '-q') }
}
const state = (cwd: string) => ({
  head: git(cwd, 'rev-parse', 'HEAD'),
  index: git(cwd, 'ls-files', '-s'),
  status: git(cwd, 'status', '--porcelain=v1', '-uall', '--ignored'),
  stash: git(cwd, 'for-each-ref', 'refs/stash')
})
const outcome = (promise: Promise<unknown>) => promise.then(() => ({}), (error: Error & { code?: string }) => ({ code: error.code, message: error.message }))

afterEach(() => {
  faults.command = ''
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('a check that cannot be made refuses', () => {
  it.each(['ls-files', 'diff-tree', 'check-ignore'])('when %s fails', async (command) => {
    const cwd = repo()
    git(cwd, 'checkout', '-q', '-b', 'feature'); write(cwd, 'ignored/config.env', 'tracked\n'); git(cwd, 'add', '-f', 'ignored/config.env'); git(cwd, 'commit', '-qm', 'feature'); git(cwd, 'checkout', '-q', 'main')
    // An untracked folder holding the file the branch writes: telling ignored from untracked there needs check-ignore.
    write(cwd, '.gitignore', '*.env\n'); commitAll(cwd, 'ignore env files')
    write(cwd, 'ignored/config.env', 'mine\n'); write(cwd, 'ignored/todo', 'todo\n')
    const before = state(cwd)
    faults.command = command
    expect(await outcome(new GitService().checkout(cwd, USER, 'feature'))).toEqual({
      code: 'git_in_the_way_unchecked',
      message: 'Mousse could not check which files switching to feature would overwrite, so nothing was changed. Try again.'
    })
    expect(state(cwd)).toEqual(before)
    expect(bytes(cwd, 'ignored/config.env')).toBe('mine\n')
  })

  it('when a rebase step cannot be worked out, rather than count only the commit\'s own paths', async () => {
    const cwd = repo()
    write(cwd, 'old/a', 'a\n'); commitAll(cwd, 'old')
    const push = withRemote(cwd)
    write(cwd, 'old/new', 'commit\n'); commitAll(cwd, 'add')
    git(cwd, 'rm', '-q', 'old/new'); git(cwd, 'commit', '-qm', 'rm')
    push((other) => { git(other, 'mv', 'old', 'ignored'); git(other, 'commit', '-qm', 'rename') })
    write(cwd, 'ignored/new', 'mine\n')
    const before = state(cwd)
    faults.command = 'merge-tree'
    expect(await outcome(new GitService().pull(cwd, USER, { strategy: 'rebase' }))).toMatchObject({ code: 'git_in_the_way_unchecked' })
    expect(state(cwd)).toEqual(before)
    expect(bytes(cwd, 'ignored/new')).toBe('mine\n')
  }, 60_000)

  it('when a merge cannot be worked out', async () => {
    const cwd = repo()
    const push = withRemote(cwd)
    push((other) => { write(other, '.env', 'upstream\n'); git(other, 'add', '-f', '.env'); git(other, 'commit', '-qm', 'env') })
    write(cwd, 'local.txt', 'local\n'); commitAll(cwd, 'local')
    write(cwd, '.env', 'mine\n')
    const before = state(cwd)
    faults.command = 'merge-tree'
    expect(await outcome(new GitService().pull(cwd, USER, { strategy: 'merge' }))).toMatchObject({ code: 'git_in_the_way_unchecked' })
    expect(state(cwd)).toEqual(before)
    expect(bytes(cwd, '.env')).toBe('mine\n')
  }, 60_000)

  it('when the commits a rebase replays cannot be listed', async () => {
    const cwd = repo()
    const push = withRemote(cwd)
    write(cwd, 'local.txt', 'local\n'); commitAll(cwd, 'local')
    push((other) => { write(other, 'up.txt', 'up\n'); commitAll(other, 'up') })
    const service = new GitService() as unknown as GitService & { runGit: (cwd: string, args: string[], ...rest: unknown[]) => Promise<unknown> }
    const original = service.runGit.bind(service)
    service.runGit = (cwd, args, ...rest) => (args[0] === 'rev-list' && args.includes('--cherry-pick') ? Promise.resolve({ ok: false, stdout: '', output: 'probe: listing exceeded limit' }) : original(cwd, args, ...rest))
    const before = state(cwd)
    expect(await outcome(service.pull(cwd, USER, { strategy: 'rebase' }))).toMatchObject({ code: 'git_in_the_way_unchecked' })
    expect(state(cwd)).toEqual(before)
  }, 60_000)
})
