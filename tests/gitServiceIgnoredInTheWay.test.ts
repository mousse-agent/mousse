import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { GitService } from '../src/mms/git/GitService'
import { userAction } from '../src/mms/git/gitPolicy'
import { committedGitTemplate } from './support/gitBase'

/**
 * Git writes over and deletes ignored files without asking. A branch switch, a new branch started from a ref, and a
 * pull with each strategy are refused instead when they would, naming the files, and nothing is changed.
 */

const USER = userAction('button', 'Test action')
const roots: string[] = []
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const write = (cwd: string, name: string, text: string) => { mkdirSync(dirname(join(cwd, name)), { recursive: true }); writeFileSync(join(cwd, name), text) }
const read = (cwd: string, name: string) => readFileSync(join(cwd, name), 'utf8')
const identity = (cwd: string) => {
  git(cwd, 'config', 'user.name', 'Fixture'); git(cwd, 'config', 'user.email', 'fixture@example.invalid')
  git(cwd, 'config', 'commit.gpgsign', 'false'); git(cwd, 'config', 'core.hooksPath', join(cwd, '.no-hooks'))
}

const copyBase = committedGitTemplate((cwd) => {
  git(cwd, 'init', '-b', 'main'); identity(cwd)
  write(cwd, 'base.txt', 'base\n'); write(cwd, '.gitignore', '.env\nignored/\n')
  git(cwd, 'add', '.'); git(cwd, 'commit', '-m', 'baseline')
})
function repo(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'mousse-ignored-way-')); roots.push(cwd)
  copyBase(cwd); identity(cwd)
  return cwd
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

/** Everything a refusal must leave as it was: HEAD, the branch, the index, the files Git sees, the stash and the ignored bytes. */
function state(cwd: string, ignored: string[]) {
  return {
    head: git(cwd, 'rev-parse', 'HEAD'),
    branch: git(cwd, 'branch', '--show-current'),
    branches: git(cwd, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads/'),
    index: git(cwd, 'ls-files', '-s'),
    status: git(cwd, 'status', '--porcelain=v1', '-uall'),
    stash: git(cwd, 'for-each-ref', 'refs/stash'),
    ignored: Object.fromEntries(ignored.map((path) => [path, existsSync(join(cwd, path)) ? read(cwd, path) : null]))
  }
}

const refusal = (promise: Promise<unknown>) => promise.then(() => { throw new Error('expected a refusal') }, (error: unknown) => error as Error & { code?: string })

/** A branch `feature` that tracks `ignored/config.env`, and on main an ignored file of the same name holding the person's own bytes. */
function featureTracksIgnored(cwd: string): string {
  git(cwd, 'checkout', '-q', '-b', 'feature')
  write(cwd, 'ignored/config.env', 'tracked feature config\n'); git(cwd, 'add', '-f', 'ignored/config.env'); git(cwd, 'commit', '-qm', 'feature config')
  git(cwd, 'checkout', '-q', 'main')
  const mine = 'unique local config 767f0977\n'
  write(cwd, 'ignored/config.env', mine)
  return mine
}

/** A bare remote the main branch tracks, and a second clone that pushes to it. */
function withRemote(cwd: string): { other: string; push: (change: (other: string) => void) => void } {
  const origin = `${cwd}-origin.git`, other = `${cwd}-other`; roots.push(origin, other)
  git(dirname(cwd), 'init', '--bare', '-q', origin)
  git(cwd, 'remote', 'add', 'origin', origin); git(cwd, 'push', '-q', '-u', 'origin', 'main')
  git(dirname(cwd), 'clone', '-q', '-b', 'main', origin, other); identity(other)
  return { other, push: (change) => { change(other); git(other, 'push', '-q') } }
}
/** The upstream starts tracking `.env`, which is ignored here and holds the person's own bytes. */
function upstreamTracksEnv(cwd: string): string {
  const { push } = withRemote(cwd)
  push((other) => { write(other, '.env', 'committed by someone\n'); git(other, 'add', '-f', '.env'); git(other, 'commit', '-qm', 'track .env') })
  const mine = 'API_KEY=only-on-this-machine\n'
  write(cwd, '.env', mine)
  return mine
}
const localCommit = (cwd: string) => { write(cwd, 'local.txt', 'local\n'); git(cwd, 'add', 'local.txt'); git(cwd, 'commit', '-qm', 'local') }

describe('switching branches over ignored files', () => {
  it('refuses, naming the file, and keeps the ignored bytes, HEAD and the index', async () => {
    const cwd = repo(), mine = featureTracksIgnored(cwd)
    const before = state(cwd, ['ignored/config.env'])
    const error = await refusal(new GitService().checkout(cwd, USER, 'feature'))
    expect(error.code).toBe('git_ignored_in_the_way')
    expect(error.message).toBe('Switching to feature would overwrite an ignored file: ignored/config.env. Move it aside, then try again. Nothing was changed.')
    expect(state(cwd, ['ignored/config.env'])).toEqual(before)
    expect(read(cwd, 'ignored/config.env')).toBe(mine)
  })

  it('stash and switch refuses before it stashes anything', async () => {
    const cwd = repo(), mine = featureTracksIgnored(cwd)
    write(cwd, 'base.txt', 'edited\n'); write(cwd, 'draft.txt', 'untracked draft\n')
    git(cwd, 'add', 'base.txt'); write(cwd, 'base.txt', 'edited again\n')
    const before = state(cwd, ['ignored/config.env'])
    const error = await refusal(new GitService().checkout(cwd, USER, 'feature', { dirty: 'stash' }))
    expect(error.code).toBe('git_ignored_in_the_way')
    expect(git(cwd, 'stash', 'list')).toBe('')
    expect(state(cwd, ['ignored/config.env'])).toEqual(before)
    expect([read(cwd, 'base.txt'), read(cwd, 'draft.txt'), git(cwd, 'show', ':base.txt'), read(cwd, 'ignored/config.env')]).toEqual(['edited again\n', 'untracked draft\n', 'edited', mine])
  })

  it('names every file in the way, also inside an ignored folder the branch puts a file over', async () => {
    const cwd = repo()
    git(cwd, 'checkout', '-q', '-b', 'feature')
    write(cwd, '.env', 'tracked\n'); write(cwd, 'cache', 'a file where an ignored folder is\n'); git(cwd, 'add', '-f', '.env', 'cache'); git(cwd, 'commit', '-qm', 'feature')
    git(cwd, 'checkout', '-q', 'main')
    write(cwd, '.gitignore', '.env\nignored/\ncache/\n'); git(cwd, 'commit', '-qam', 'ignore cache')
    write(cwd, '.env', 'mine\n'); write(cwd, 'cache/one.bin', 'one\n'); write(cwd, 'cache/two.bin', 'two\n')
    const error = await refusal(new GitService().checkout(cwd, USER, 'feature'))
    expect(error.message).toBe('Switching to feature would overwrite ignored files: .env, cache/one.bin, cache/two.bin. Move them aside, then try again. Nothing was changed.')
    expect([read(cwd, '.env'), read(cwd, 'cache/one.bin'), read(cwd, 'cache/two.bin')]).toEqual(['mine\n', 'one\n', 'two\n'])
    expect(git(cwd, 'branch', '--show-current')).toBe('main')
  })

  it('a remote branch the switch would start a local branch from is checked too', async () => {
    const cwd = repo(), mine = featureTracksIgnored(cwd)
    withRemote(cwd)
    git(cwd, 'push', '-q', 'origin', 'feature'); git(cwd, 'branch', '-D', 'feature'); git(cwd, 'fetch', '-q')
    const error = await refusal(new GitService().checkout(cwd, USER, 'feature'))
    expect(error.code).toBe('git_ignored_in_the_way')
    expect(read(cwd, 'ignored/config.env')).toBe(mine)
    expect(git(cwd, 'for-each-ref', 'refs/heads/feature')).toBe('')
  })

  it('switches as before when no ignored file is in the way, and leaves the ignored files alone', async () => {
    const cwd = repo()
    git(cwd, 'checkout', '-q', '-b', 'feature'); write(cwd, 'feature.txt', 'feature\n'); git(cwd, 'add', '.'); git(cwd, 'commit', '-qm', 'feature'); git(cwd, 'checkout', '-q', 'main')
    write(cwd, '.env', 'mine\n'); write(cwd, 'ignored/notes.txt', 'notes\n'); write(cwd, 'base.txt', 'edited\n')
    const service = new GitService()
    await expect(service.checkout(cwd, USER, 'feature')).resolves.toEqual({})
    expect([git(cwd, 'branch', '--show-current'), read(cwd, 'feature.txt'), read(cwd, 'base.txt'), read(cwd, '.env'), read(cwd, 'ignored/notes.txt')]).toEqual(['feature', 'feature\n', 'edited\n', 'mine\n', 'notes\n'])
    await expect(service.checkout(cwd, USER, 'main', { dirty: 'stash' })).resolves.toEqual({})
    expect([git(cwd, 'branch', '--show-current'), existsSync(join(cwd, 'feature.txt')), read(cwd, 'base.txt'), read(cwd, '.env')]).toEqual(['main', false, 'edited\n', 'mine\n'])
  })
})

describe('creating a branch from a ref over ignored files', () => {
  it('refuses to create and switch, and creates nothing', async () => {
    const cwd = repo(), mine = featureTracksIgnored(cwd)
    const before = state(cwd, ['ignored/config.env'])
    const error = await refusal(new GitService().createBranch(cwd, USER, 'topic', { from: 'feature' }))
    expect(error.code).toBe('git_ignored_in_the_way')
    expect(error.message).toBe('Creating topic from feature would overwrite an ignored file: ignored/config.env. Move it aside, then try again. Nothing was changed.')
    expect(state(cwd, ['ignored/config.env'])).toEqual(before)
    expect(read(cwd, 'ignored/config.env')).toBe(mine)
  })

  it('creates the branch without switching, since that writes no file', async () => {
    const cwd = repo(), mine = featureTracksIgnored(cwd)
    await new GitService().createBranch(cwd, USER, 'topic', { from: 'feature', checkout: false })
    expect(git(cwd, 'rev-parse', 'topic')).toBe(git(cwd, 'rev-parse', 'feature'))
    expect([git(cwd, 'branch', '--show-current'), read(cwd, 'ignored/config.env')]).toEqual(['main', mine])
  })
})

describe('pulling over ignored files', () => {
  it.each(['ff-only', 'merge', 'rebase'] as const)('%s refuses when the upstream starts tracking an ignored file', async (strategy) => {
    const cwd = repo(), mine = upstreamTracksEnv(cwd)
    const before = state(cwd, ['.env'])
    const error = await refusal(new GitService().pull(cwd, USER, { strategy }))
    expect(error.code).toBe('git_ignored_in_the_way')
    expect(error.message).toBe('Pulling origin/main would overwrite an ignored file: .env. Move it aside, then try again. Nothing was changed.')
    expect(state(cwd, ['.env'])).toEqual(before)
    expect(read(cwd, '.env')).toBe(mine)
  }, 60_000)

  it.each(['merge', 'rebase'] as const)('%s refuses on a branch that has diverged from the upstream', async (strategy) => {
    const cwd = repo(), mine = upstreamTracksEnv(cwd)
    localCommit(cwd)
    const before = state(cwd, ['.env'])
    const error = await refusal(new GitService().pull(cwd, USER, { strategy }))
    expect(error.code).toBe('git_ignored_in_the_way')
    expect(state(cwd, ['.env'])).toEqual(before)
    expect(read(cwd, '.env')).toBe(mine)
    expect((await new GitService().getStatus(cwd)).inProgress).toBeNull()
  }, 60_000)

  it('rebase refuses when a local commit it replays adds and a later one deletes an ignored file', async () => {
    const cwd = repo(), { push } = withRemote(cwd)
    write(cwd, '.env', 'committed by mistake\n'); git(cwd, 'add', '-f', '.env'); git(cwd, 'commit', '-qm', 'add .env')
    git(cwd, 'rm', '-q', '--cached', '.env'); git(cwd, 'commit', '-qm', 'stop tracking .env')
    const mine = 'API_KEY=only-on-this-machine\n'
    write(cwd, '.env', mine)
    push((other) => { write(other, 'up.txt', 'up\n'); git(other, 'add', '.'); git(other, 'commit', '-qm', 'up') })
    const before = state(cwd, ['.env'])
    const error = await refusal(new GitService().pull(cwd, USER, { strategy: 'rebase' }))
    expect(error.code).toBe('git_ignored_in_the_way')
    expect(error.message).toContain('would overwrite an ignored file: .env.')
    expect(state(cwd, ['.env'])).toEqual(before)
    expect(read(cwd, '.env')).toBe(mine)
  }, 60_000)

  it('rebase is not refused for a file the upstream added and removed again, since only its last state is written', async () => {
    const cwd = repo(), { push } = withRemote(cwd)
    push((other) => {
      write(other, '.env', 'pushed by mistake\n'); git(other, 'add', '-f', '.env'); git(other, 'commit', '-qm', 'add .env')
      git(other, 'rm', '-q', '--cached', '.env'); git(other, 'commit', '-qm', 'stop tracking .env')
    })
    localCommit(cwd)
    write(cwd, '.env', 'mine\n')
    await expect(new GitService().pull(cwd, USER, { strategy: 'rebase' })).resolves.toEqual({ result: 'rebased' })
    expect(read(cwd, '.env')).toBe('mine\n')
  }, 60_000)

  it.each([
    ['ff-only', false, 'fast-forwarded'],
    ['merge', true, 'merged'],
    ['rebase', true, 'rebased']
  ] as const)('%s pulls as before when no ignored file is in the way', async (strategy, diverged, result) => {
    const cwd = repo(), { push } = withRemote(cwd)
    push((other) => { write(other, 'up.txt', 'up\n'); git(other, 'add', '.'); git(other, 'commit', '-qm', 'up') })
    if (diverged) localCommit(cwd)
    write(cwd, '.env', 'mine\n'); write(cwd, 'ignored/cache.bin', 'cache\n')
    await expect(new GitService().pull(cwd, USER, { strategy })).resolves.toEqual({ result })
    expect([read(cwd, 'up.txt'), read(cwd, '.env'), read(cwd, 'ignored/cache.bin')]).toEqual(['up\n', 'mine\n', 'cache\n'])
    expect(git(cwd, 'status', '--porcelain')).toBe('')
  }, 60_000)
})
