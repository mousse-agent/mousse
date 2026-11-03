import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GitService } from '../src/mms/git/GitService'
import { userAction } from '../src/mms/git/gitPolicy'
import { configureInTheWay } from '../src/mms/git/inTheWay'
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

  it('names every file in the way, and an ignored folder the branch puts a file over as that folder', async () => {
    const cwd = repo()
    git(cwd, 'checkout', '-q', '-b', 'feature')
    write(cwd, '.env', 'tracked\n'); write(cwd, 'cache', 'a file where an ignored folder is\n'); git(cwd, 'add', '-f', '.env', 'cache'); git(cwd, 'commit', '-qm', 'feature')
    git(cwd, 'checkout', '-q', 'main')
    write(cwd, '.gitignore', '.env\nignored/\ncache/\n'); git(cwd, 'commit', '-qam', 'ignore cache')
    write(cwd, '.env', 'mine\n'); write(cwd, 'cache/one.bin', 'one\n'); write(cwd, 'cache/two.bin', 'two\n')
    const error = await refusal(new GitService().checkout(cwd, USER, 'feature'))
    expect(error.message).toBe('Switching to feature would overwrite ignored files and folders: .env, cache/. Move them aside, then try again. Nothing was changed.')
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

/** Whether this file system treats names that differ only in case as the same file (macOS and Windows by default). */
function caseInsensitive(): boolean {
  const dir = mkdtempSync(join(tmpdir(), 'mousse-case-')); roots.push(dir)
  writeFileSync(join(dir, 'probe'), ''); return existsSync(join(dir, 'PROBE'))
}
const commitAll = (cwd: string, message: string) => { git(cwd, 'add', '-A'); git(cwd, 'commit', '-qm', message) }

describe('what else a write can destroy', () => {
  it('refuses a switch that puts a file where a populated submodule is, and keeps its files', async () => {
    const cwd = repo(), library = `${cwd}-library`; roots.push(library)
    git(dirname(cwd), 'init', '-q', '-b', 'main', library); identity(library)
    write(library, 'lib.txt', 'library\n'); commitAll(library, 'library')
    git(cwd, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', library, 'sub'); git(cwd, 'commit', '-qm', 'add submodule')
    git(cwd, 'checkout', '-q', '-b', 'flat'); git(cwd, 'rm', '-q', 'sub'); write(cwd, 'sub', 'now a file\n'); commitAll(cwd, 'sub is a file')
    git(cwd, 'checkout', '-q', 'main'); git(cwd, '-c', 'protocol.file.allow=always', 'submodule', 'update', '-q', '--init')
    write(cwd, 'sub/.env', 'submodule secret\n')
    const before = state(cwd, ['sub/.env', 'sub/lib.txt'])
    const error = await refusal(new GitService().checkout(cwd, USER, 'flat'))
    expect(error.code).toBe('git_ignored_in_the_way')
    expect(error.message).toBe('Switching to flat would overwrite the files of submodule sub. Move them aside, then try again. Nothing was changed.')
    expect(state(cwd, ['sub/.env', 'sub/lib.txt'])).toEqual(before)
    expect([read(cwd, 'sub/.env'), read(cwd, 'sub/lib.txt')]).toEqual(['submodule secret\n', 'library\n'])
  }, 60_000)

  it('rebase counts where rename detection moves a replayed change: a local file added in a folder the upstream renamed', async () => {
    const cwd = repo(), { push } = withRemote(cwd)
    push((other) => {
      write(other, 'old/a.txt', 'one\ntwo\nthree\nfour\nfive\n'); write(other, 'old/b.txt', 'six\nseven\neight\nnine\n'); commitAll(other, 'old folder')
    })
    git(cwd, 'pull', '-q', '--ff-only')
    push((other) => { git(other, 'mv', 'old', 'ignored'); git(other, 'commit', '-qm', 'rename old to ignored') })
    write(cwd, 'old/new.txt', 'added locally\n'); commitAll(cwd, 'local file in old')
    const mine = 'ignored bytes only here\n'
    write(cwd, 'ignored/new.txt', mine)
    const before = state(cwd, ['ignored/new.txt'])
    const error = await refusal(new GitService().pull(cwd, USER, { strategy: 'rebase' }))
    expect(error.code).toBe('git_ignored_in_the_way')
    expect(error.message).toContain('an ignored file: ignored/new.txt.')
    expect(state(cwd, ['ignored/new.txt'])).toEqual(before)
    expect((await new GitService().getStatus(cwd)).inProgress).toBeNull()
  }, 60_000)

  it('rebase refuses for an untracked file that the upstream starts ignoring and a replayed commit adds and deletes', async () => {
    const cwd = repo()
    write(cwd, '.gitignore', 'ignored/\n'); commitAll(cwd, '.env not ignored')
    const { push } = withRemote(cwd)
    push((other) => { write(other, '.gitignore', 'ignored/\n.env\n'); commitAll(other, 'ignore .env') })
    write(cwd, '.env', 'committed by mistake\n'); commitAll(cwd, 'add .env')
    git(cwd, 'rm', '-q', '.env'); git(cwd, 'commit', '-qm', 'remove .env')
    const mine = 'untracked, not ignored here\n'
    write(cwd, '.env', mine)
    const before = state(cwd, ['.env'])
    const error = await refusal(new GitService().pull(cwd, USER, { strategy: 'rebase' }))
    expect(error.message).toBe('Pulling origin/main would overwrite an untracked file: .env. Move it aside, then try again. Nothing was changed.')
    expect(state(cwd, ['.env'])).toEqual(before)
  }, 60_000)

  it('reads names exactly, a line break at the start included, and quotes them in the message', async () => {
    const cwd = repo(), name = '\nkey.env'
    write(cwd, '.gitignore', '.env\nignored/\n*.env\n'); commitAll(cwd, 'ignore *.env')
    const { push } = withRemote(cwd)
    write(cwd, name, 'committed by mistake\n'); git(cwd, 'add', '-f', '--', name); git(cwd, 'commit', '-qm', 'add key')
    git(cwd, 'rm', '-q', '--', name); git(cwd, 'commit', '-qm', 'remove key')
    write(cwd, name, 'mine\n')
    push((other) => { write(other, 'up.txt', 'up\n'); commitAll(other, 'up') })
    const error = await refusal(new GitService().pull(cwd, USER, { strategy: 'rebase' }))
    expect(error.message).toBe('Pulling origin/main would overwrite an ignored file: "\\nkey.env". Move it aside, then try again. Nothing was changed.')
    expect(read(cwd, name)).toBe('mine\n')
  }, 60_000)

  it.runIf(caseInsensitive())('a rename that only changes case is not taken for an ignored file, on a switch and on a pull', async () => {
    const cwd = repo(), { push } = withRemote(cwd)
    write(cwd, 'src/Button.tsx', 'button\n'); write(cwd, 'Docs/guide.md', 'guide\n'); commitAll(cwd, 'files'); git(cwd, 'push', '-q')
    git(cwd, 'checkout', '-q', '-b', 'lower'); git(cwd, 'mv', 'src/Button.tsx', 'src/tmp'); git(cwd, 'mv', 'src/tmp', 'src/button.tsx'); git(cwd, 'commit', '-qm', 'lower case'); git(cwd, 'checkout', '-q', 'main')
    const service = new GitService()
    await expect(service.checkout(cwd, USER, 'lower')).resolves.toEqual({})
    await expect(service.checkout(cwd, USER, 'main')).resolves.toEqual({})
    push((other) => { git(other, 'pull', '-q'); git(other, 'mv', 'Docs', 'tmp'); git(other, 'mv', 'tmp', 'docs'); git(other, 'commit', '-qm', 'docs lower case') })
    await expect(service.pull(cwd, USER)).resolves.toEqual({ result: 'fast-forwarded' })
    expect(git(cwd, 'ls-files', 'docs')).toBe('docs/guide.md')
  }, 60_000)

  it.runIf(caseInsensitive())('names the file as it is spelled on disk', async () => {
    const cwd = repo()
    git(cwd, 'checkout', '-q', '-b', 'upper'); write(cwd, '.ENV', 'tracked\n'); git(cwd, 'add', '-f', '.ENV'); git(cwd, 'commit', '-qm', 'upper'); git(cwd, 'checkout', '-q', 'main')
    write(cwd, '.env', 'mine\n')
    const error = await refusal(new GitService().checkout(cwd, USER, 'upper'))
    expect(error.message).toBe('Switching to upper would overwrite an ignored file: .env. Move it aside, then try again. Nothing was changed.')
    expect(read(cwd, '.env')).toBe('mine\n')
  })
})

describe('the check stays out of the way', () => {
  it('an ignored .mousse folder does not stop a switch', async () => {
    const cwd = repo()
    write(cwd, '.gitignore', '.env\nignored/\n.mousse/\n'); commitAll(cwd, 'ignore .mousse')
    write(cwd, '.mousse/state.json', '{}\n')
    git(cwd, 'branch', 'same')
    git(cwd, 'checkout', '-q', '-b', 'other'); write(cwd, 'other.txt', 'other\n'); commitAll(cwd, 'other'); git(cwd, 'checkout', '-q', 'main')
    const service = new GitService()
    await expect(service.checkout(cwd, USER, 'same')).resolves.toEqual({})
    await expect(service.checkout(cwd, USER, 'other')).resolves.toEqual({})
    expect(read(cwd, '.mousse/state.json')).toBe('{}\n')
  })

  it('in a sparse checkout, a path outside its patterns is not written, so an ignored file there does not stop the switch', async () => {
    const cwd = repo(), mine = featureTracksIgnored(cwd)
    write(cwd, 'src/app.ts', 'app\n'); commitAll(cwd, 'src')
    git(cwd, 'sparse-checkout', 'set', '--cone', 'src')
    await expect(new GitService().checkout(cwd, USER, 'feature')).resolves.toEqual({})
    expect(git(cwd, 'branch', '--show-current')).toBe('feature')
    expect(read(cwd, 'ignored/config.env')).toBe(mine)
  })

  it('with two remotes, checks the branch checkout.defaultRemote picks, before stash and switch stashes anything', async () => {
    const cwd = repo(), mine = featureTracksIgnored(cwd)
    withRemote(cwd)
    const backup = `${cwd}-backup.git`; roots.push(backup)
    git(dirname(cwd), 'init', '--bare', '-q', backup); git(cwd, 'remote', 'add', 'backup', backup)
    // The two remotes' `feature` differ, so only `checkout.defaultRemote` says which one the switch takes.
    git(cwd, 'push', '-q', 'origin', 'feature'); git(cwd, 'push', '-q', 'backup', 'main:feature'); git(cwd, 'branch', '-D', 'feature')
    git(cwd, 'config', 'checkout.defaultRemote', 'origin')
    write(cwd, 'base.txt', 'edited\n')
    const before = state(cwd, ['ignored/config.env'])
    const error = await refusal(new GitService().checkout(cwd, USER, 'feature', { dirty: 'stash' }))
    expect(error.code).toBe('git_ignored_in_the_way')
    expect(git(cwd, 'stash', 'list')).toBe('')
    expect(state(cwd, ['ignored/config.env'])).toEqual(before)
    expect([read(cwd, 'ignored/config.env'), read(cwd, 'base.txt')]).toEqual([mine, 'edited\n'])
  }, 60_000)

  it('a merge counts the side name a folder/file conflict gives a file', async () => {
    const cwd = repo()
    write(cwd, '.gitignore', '.env\nignored/\nx~*\n'); write(cwd, 'x', 'file\n'); commitAll(cwd, 'x is a file')
    const { push } = withRemote(cwd)
    push((other) => { git(other, 'rm', '-q', 'x'); write(other, 'x/y', 'now a folder\n'); commitAll(other, 'x is a folder') })
    write(cwd, 'x', 'changed here\n'); commitAll(cwd, 'x changed')
    git(cwd, 'fetch', '-q')
    // Every name Git might pick for the side file is taken by an ignored file of the person's.
    for (const side of ['x~HEAD', 'x~@{upstream}', 'x~origin_main', `x~${git(cwd, 'rev-parse', 'HEAD')}`]) write(cwd, side, `mine ${side}\n`)
    const error = await refusal(new GitService().pull(cwd, USER, { strategy: 'merge' }))
    expect(error.code).toBe('git_ignored_in_the_way')
    expect(error.message).toMatch(/ignored files: x~/)
    expect(read(cwd, 'x~HEAD')).toBe('mine x~HEAD\n')
    expect((await new GitService().getStatus(cwd)).inProgress).toBeNull()
  }, 60_000)

  it('rebase checks a branch that holds a merge, even when the upstream is already in it', async () => {
    const cwd = repo()
    withRemote(cwd)
    git(cwd, 'checkout', '-q', '-b', 'side')
    write(cwd, '.env', 'committed by mistake\n'); git(cwd, 'add', '-f', '.env'); git(cwd, 'commit', '-qm', 'add .env')
    git(cwd, 'rm', '-q', '.env'); git(cwd, 'commit', '-qm', 'remove .env')
    git(cwd, 'checkout', '-q', 'main'); localCommit(cwd); git(cwd, 'merge', '-q', '--no-ff', '--no-edit', 'side')
    const mine = 'API_KEY=only-on-this-machine\n'
    write(cwd, '.env', mine)
    const before = state(cwd, ['.env'])
    const error = await refusal(new GitService().pull(cwd, USER, { strategy: 'rebase' }))
    expect(error.message).toBe('Pulling origin/main would overwrite an ignored file: .env. Move it aside, then try again. Nothing was changed.')
    expect(state(cwd, ['.env'])).toEqual(before)
  }, 60_000)

  it('a check that cannot be made refuses in plain words', async () => {
    const cwd = repo(); featureTracksIgnored(cwd)
    writeFileSync(join(cwd, '.git', 'index'), 'not an index')
    const error = await refusal(new GitService().checkout(cwd, USER, 'feature'))
    expect(error.code).toBe('git_in_the_way_unchecked')
    expect(error.message).toBe('Mousse could not check which files switching to feature would overwrite, so nothing was changed. Try again.')
  })

  it('writes nothing to check: no snapshot index, and no untracked file in the object store', async () => {
    const cwd = repo(); featureTracksIgnored(cwd)
    const draft = 'untracked draft 5f1c\n'
    write(cwd, 'draft.txt', draft)
    const blob = execFileSync('git', ['hash-object', '--stdin'], { cwd, input: draft, encoding: 'utf8' }).trim()
    await refusal(new GitService().checkout(cwd, USER, 'feature'))
    expect(existsSync(join(cwd, '.git', 'mousse', 'snapshot-index'))).toBe(false)
    expect(() => git(cwd, 'cat-file', '-e', blob)).toThrow()
  })
})

describe('ignored files Git lists only as part of an untracked folder', () => {
  const ignoreLogs = (cwd: string) => { write(cwd, '.gitignore', '.env\nignored/\n*.log\n'); commitAll(cwd, 'ignore logs') }
  /** `notes/` holds an untracked file and an ignored one; the other side tracks the ignored one's path. */
  const mixedFolder = (cwd: string) => { write(cwd, 'notes/todo.txt', 'untracked\n'); write(cwd, 'notes/run.log', 'ignored log only here\n') }

  it('a switch refuses for the ignored file', async () => {
    const cwd = repo()
    ignoreLogs(cwd)
    git(cwd, 'checkout', '-q', '-b', 'feature'); write(cwd, 'notes/run.log', 'tracked log\n'); git(cwd, 'add', '-f', 'notes/run.log'); git(cwd, 'commit', '-qm', 'track log'); git(cwd, 'checkout', '-q', 'main')
    mixedFolder(cwd)
    const error = await refusal(new GitService().checkout(cwd, USER, 'feature'))
    expect(error.message).toBe('Switching to feature would overwrite an ignored file: notes/run.log. Move it aside, then try again. Nothing was changed.')
    expect([read(cwd, 'notes/run.log'), read(cwd, 'notes/todo.txt')]).toEqual(['ignored log only here\n', 'untracked\n'])
  })

  it('a merge names it as ignored', async () => {
    const cwd = repo()
    ignoreLogs(cwd); mixedFolder(cwd)
    const { push } = withRemote(cwd)
    push((other) => { write(other, 'notes/run.log', 'tracked log\n'); git(other, 'add', '-f', 'notes/run.log'); git(other, 'commit', '-qm', 'track log') })
    localCommit(cwd)
    const error = await refusal(new GitService().pull(cwd, USER, { strategy: 'merge' }))
    expect(error.message).toBe('Pulling origin/main would overwrite an ignored file: notes/run.log. Move it aside, then try again. Nothing was changed.')
    expect(read(cwd, 'notes/run.log')).toBe('ignored log only here\n')
  }, 60_000)
})

const outcome = (promise: Promise<unknown>) => promise.catch((error: Error & { code?: string }) => ({ error: error.code, message: error.message }))
const bytes = (cwd: string, path: string) => (existsSync(join(cwd, path)) ? read(cwd, path) : '<missing>')

describe('replays and merges as Git really runs them', () => {
  it('rebase replays with the merge backend even when rebase.backend is apply, so the check matches the replay', async () => {
    const cwd = repo()
    write(cwd, 'old/a', 'a\n'); commitAll(cwd, 'old')
    const { push } = withRemote(cwd)
    write(cwd, 'old/new', 'local commit\n'); commitAll(cwd, 'add new')
    git(cwd, 'rm', '-q', 'old/new'); git(cwd, 'commit', '-qm', 'remove new')
    push((other) => { git(other, 'mv', 'old', 'renamed'); git(other, 'commit', '-qm', 'rename') })
    write(cwd, '.git/info/exclude', 'old/new\n'); write(cwd, 'old/new', 'mine\n')
    git(cwd, 'config', 'rebase.backend', 'apply')
    const before = state(cwd, ['old/new'])
    const error = await refusal(new GitService().pull(cwd, USER, { strategy: 'rebase' }))
    expect(error.code).toBe('git_ignored_in_the_way')
    expect(error.message).toContain('an ignored file: old/new.')
    expect(state(cwd, ['old/new'])).toEqual(before)
  }, 60_000)

  it('rebase counts the commits after a step that conflicts here, since a merge program can settle it in the real replay', async () => {
    const cwd = repo()
    write(cwd, '.gitattributes', 'base.txt merge=keep\n'); commitAll(cwd, 'attributes')
    git(cwd, 'config', 'merge.keep.driver', 'true')
    const { push } = withRemote(cwd)
    write(cwd, 'base.txt', 'local\n'); git(cwd, 'commit', '-qam', 'local conflicting change')
    write(cwd, '.env', 'committed\n'); git(cwd, 'add', '-f', '.env'); git(cwd, 'commit', '-qm', 'env')
    git(cwd, 'rm', '-q', '.env'); git(cwd, 'commit', '-qm', 'rm env')
    push((other) => { write(other, 'base.txt', 'upstream\n'); git(other, 'commit', '-qam', 'upstream conflicting change') })
    write(cwd, '.env', 'mine\n')
    const before = state(cwd, ['.env'])
    const error = await refusal(new GitService().pull(cwd, USER, { strategy: 'rebase' }))
    expect(error.message).toBe('Pulling origin/main would overwrite an ignored file: .env. Move it aside, then try again. Nothing was changed.')
    expect(state(cwd, ['.env'])).toEqual(before)
  }, 60_000)

  it.each(['merge', 'rebase'] as const)('%s refuses for an ignored file partway down an ignored folder, where the upstream needs a folder', async (strategy) => {
    const cwd = repo()
    write(cwd, '.gitignore', '.env\nignored/\nbuild/\n'); commitAll(cwd, 'ignore build')
    const { push } = withRemote(cwd)
    push((other) => { write(other, 'build/output/index.js', 'tracked\n'); git(other, 'add', '-f', 'build/output/index.js'); git(other, 'commit', '-qm', 'track build output') })
    localCommit(cwd)
    write(cwd, 'build/output', 'my build log\n')
    const before = state(cwd, ['build/output'])
    const error = await refusal(new GitService().pull(cwd, USER, { strategy }))
    expect(error.message).toBe('Pulling origin/main would overwrite an ignored file: build/output. Move it aside, then try again. Nothing was changed.')
    expect(state(cwd, ['build/output'])).toEqual(before)
  }, 60_000)

  it.each(['merge', 'rebase'] as const)('%s refuses for an untracked file partway down an untracked folder', async (strategy) => {
    const cwd = repo()
    const { push } = withRemote(cwd)
    push((other) => { write(other, 'data/raw/x.csv', 'tracked\n'); commitAll(other, 'track data') })
    localCommit(cwd)
    write(cwd, 'data/raw', 'my raw data\n'); write(cwd, 'data/notes.txt', 'notes\n')
    const before = state(cwd, ['data/raw', 'data/notes.txt'])
    const error = await refusal(new GitService().pull(cwd, USER, { strategy }))
    expect(error.message).toBe('Pulling origin/main would overwrite an untracked file: data/raw. Move it aside, then try again. Nothing was changed.')
    expect(state(cwd, ['data/raw', 'data/notes.txt'])).toEqual(before)
  }, 60_000)

  it('stash and switch names an ignored file inside an untracked folder the branch replaces with a file, before any stash', async () => {
    const cwd = repo()
    write(cwd, '.gitignore', '*.log\n'); commitAll(cwd, 'logs')
    git(cwd, 'checkout', '-q', '-b', 'feature'); write(cwd, 'notes', 'target\n'); commitAll(cwd, 'notes is a file'); git(cwd, 'checkout', '-q', 'main')
    write(cwd, 'notes/todo', 'todo\n'); write(cwd, 'notes/run.log', 'mine\n'); write(cwd, 'base.txt', 'edit\n')
    const service = new GitService() as unknown as GitService & { runGit: (cwd: string, args: string[], ...rest: unknown[]) => Promise<unknown> }
    const original = service.runGit.bind(service), commands: string[][] = []
    service.runGit = (cwd, args, ...rest) => { commands.push(args); return original(cwd, args, ...rest) }
    const before = state(cwd, ['notes/run.log'])
    const error = await refusal(service.checkout(cwd, USER, 'feature', { dirty: 'stash' }))
    expect(error.message).toBe('Switching to feature would overwrite an ignored file: notes/run.log. Move it aside, then try again. Nothing was changed.')
    expect(commands.some((args) => args[0] === 'stash')).toBe(false)
    expect(state(cwd, ['notes/run.log'])).toEqual(before)
  })
})

describe('what the check lets through', () => {
  it('a populated nested repository becoming a submodule is a safe switch', async () => {
    const cwd = repo(), library = repo()
    git(cwd, 'switch', '-q', '-c', 'feature'); git(cwd, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', library, 'sub'); git(cwd, 'commit', '-qm', 'add sub')
    git(cwd, 'submodule', 'deinit', '-q', '-f', 'sub'); git(cwd, 'switch', '-q', 'main'); rmSync(join(cwd, 'sub'), { recursive: true, force: true })
    git(cwd, 'clone', '-q', library, 'sub'); write(cwd, 'sub/.env', 'mine\n')
    expect(await outcome(new GitService().checkout(cwd, USER, 'feature'))).toEqual({})
    expect(bytes(cwd, 'sub/.env')).toBe('mine\n')
  }, 60_000)

  it('an ignored folder becoming a submodule is a safe switch', async () => {
    const cwd = repo(), library = repo()
    write(cwd, '.gitignore', 'sub/\n'); git(cwd, 'commit', '-qam', 'ignore sub')
    git(cwd, 'switch', '-q', '-c', 'feature'); git(cwd, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', '--force', library, 'sub'); git(cwd, 'commit', '-qm', 'add sub')
    git(cwd, 'submodule', 'deinit', '-q', '-f', 'sub'); git(cwd, 'switch', '-q', 'main'); write(cwd, 'sub/local', 'mine\n')
    expect(await outcome(new GitService().checkout(cwd, USER, 'feature'))).toEqual({})
    expect(bytes(cwd, 'sub/local')).toBe('mine\n')
  }, 60_000)

  it('a merge configured with the ours strategy writes nothing, so it is not refused', async () => {
    const cwd = repo(), { push } = withRemote(cwd)
    localCommit(cwd)
    push((other) => { write(other, '.env', 'upstream\n'); git(other, 'add', '-f', '.env'); git(other, 'commit', '-qm', 'env') })
    write(cwd, '.env', 'mine\n'); git(cwd, 'config', 'branch.main.mergeOptions', '-s ours')
    expect(await new GitService().pull(cwd, USER, { strategy: 'merge' })).toEqual({ result: 'merged' })
    expect(bytes(cwd, '.env')).toBe('mine\n')
  }, 60_000)

  it("an editor's backup x~ is not taken for the side name of a folder/file conflict", async () => {
    const cwd = repo()
    write(cwd, '.gitignore', '.env\nignored/\n*~\n'); write(cwd, 'x', 'file\n'); commitAll(cwd, 'x is a file')
    const { push } = withRemote(cwd)
    push((other) => { git(other, 'rm', '-q', 'x'); write(other, 'x/y', 'now a folder\n'); commitAll(other, 'x is a folder') })
    write(cwd, 'x', 'changed here\n'); commitAll(cwd, 'x changed')
    write(cwd, 'x~', 'editor backup\n')
    expect(await new GitService().pull(cwd, USER, { strategy: 'merge' })).toEqual({ result: 'conflicted' })
    expect(bytes(cwd, 'x~')).toBe('editor backup\n')
  }, 60_000)

  it('names a nested repository by its folder, and a single ignored folder as a folder', async () => {
    const cwd = repo()
    git(cwd, 'checkout', '-q', '-b', 'feature'); write(cwd, 'tools/run.sh', 'tracked\n'); write(cwd, 'logs', 'a file now\n'); commitAll(cwd, 'tools and logs'); git(cwd, 'checkout', '-q', 'main')
    write(cwd, '.gitignore', '.env\nignored/\nlogs/\n'); commitAll(cwd, 'ignore logs')
    write(cwd, 'logs/today.log', 'log\n')
    git(dirname(cwd), 'init', '-q', join(cwd, 'tools')); write(cwd, 'tools/run.sh', 'my script\n')
    const error = await refusal(new GitService().checkout(cwd, USER, 'feature'))
    expect(error.message).toBe('Switching to feature would overwrite an ignored folder: logs/; the files of the nested repository tools. Move them aside, then try again. Nothing was changed.')
    expect([read(cwd, 'tools/run.sh'), read(cwd, 'logs/today.log')]).toEqual(['my script\n', 'log\n'])
  })
})

describe('on a Git without merge-tree --write-tree, merges and rebases are counted conservatively', () => {
  beforeEach(() => configureInTheWay({ mergeTree: false }))
  afterEach(() => configureInTheWay())

  /** The upstream renames `old/` to `ignored/`; a local commit adds `old/new.txt`, which a merge or rebase moves to `ignored/new.txt`. */
  function renamedFolder(cwd: string): string {
    const { push } = withRemote(cwd)
    push((other) => { write(other, 'old/a.txt', 'one\ntwo\nthree\nfour\nfive\n'); write(other, 'old/b.txt', 'six\nseven\neight\nnine\n'); commitAll(other, 'old folder') })
    git(cwd, 'pull', '-q', '--ff-only')
    push((other) => { git(other, 'mv', 'old', 'ignored'); git(other, 'commit', '-qm', 'rename old to ignored') })
    write(cwd, 'old/new.txt', 'added locally\n'); commitAll(cwd, 'local file in old')
    const mine = 'ignored bytes only here\n'
    write(cwd, 'ignored/new.txt', mine)
    return mine
  }

  it.each(['merge', 'rebase'] as const)('%s refuses for a local file that the upstream folder rename carries over an ignored file', async (strategy) => {
    const cwd = repo(); renamedFolder(cwd)
    const before = state(cwd, ['ignored/new.txt'])
    const error = await refusal(new GitService().pull(cwd, USER, { strategy }))
    expect(error.message).toContain('an ignored file: ignored/new.txt.')
    expect(state(cwd, ['ignored/new.txt'])).toEqual(before)
  }, 60_000)

  it('rebase refuses when local commits add and delete a path that is ignored on disk, whatever the backend', async () => {
    const cwd = repo()
    write(cwd, 'old/a', 'a\n'); commitAll(cwd, 'old')
    const { push } = withRemote(cwd)
    write(cwd, 'old/new', 'local commit\n'); commitAll(cwd, 'add new')
    git(cwd, 'rm', '-q', 'old/new'); git(cwd, 'commit', '-qm', 'remove new')
    push((other) => { git(other, 'mv', 'old', 'renamed'); git(other, 'commit', '-qm', 'rename') })
    write(cwd, '.git/info/exclude', 'old/new\n'); write(cwd, 'old/new', 'mine\n')
    git(cwd, 'config', 'rebase.backend', 'apply')
    const before = state(cwd, ['old/new'])
    const error = await refusal(new GitService().pull(cwd, USER, { strategy: 'rebase' }))
    expect(error.message).toContain('an ignored file: old/new.')
    expect(state(cwd, ['old/new'])).toEqual(before)
  }, 60_000)

  it('rebase counts every local commit, also after one a merge program settles', async () => {
    const cwd = repo()
    write(cwd, '.gitattributes', 'base.txt merge=keep\n'); commitAll(cwd, 'attributes')
    git(cwd, 'config', 'merge.keep.driver', 'true')
    const { push } = withRemote(cwd)
    write(cwd, 'base.txt', 'local\n'); git(cwd, 'commit', '-qam', 'local conflicting change')
    write(cwd, '.env', 'committed\n'); git(cwd, 'add', '-f', '.env'); git(cwd, 'commit', '-qm', 'env')
    git(cwd, 'rm', '-q', '.env'); git(cwd, 'commit', '-qm', 'rm env')
    push((other) => { write(other, 'base.txt', 'upstream\n'); git(other, 'commit', '-qam', 'upstream conflicting change') })
    write(cwd, '.env', 'mine\n')
    const before = state(cwd, ['.env'])
    const error = await refusal(new GitService().pull(cwd, USER, { strategy: 'rebase' }))
    expect(error.message).toBe('Pulling origin/main would overwrite an ignored file: .env. Move it aside, then try again. Nothing was changed.')
    expect(state(cwd, ['.env'])).toEqual(before)
  }, 60_000)

  it.each(['merge', 'rebase'] as const)('%s refuses for an ignored file partway down an ignored folder', async (strategy) => {
    const cwd = repo()
    write(cwd, '.gitignore', '.env\nignored/\nbuild/\n'); commitAll(cwd, 'ignore build')
    const { push } = withRemote(cwd)
    push((other) => { write(other, 'build/output/index.js', 'tracked\n'); git(other, 'add', '-f', 'build/output/index.js'); git(other, 'commit', '-qm', 'track build output') })
    localCommit(cwd)
    write(cwd, 'build/output', 'my build log\n')
    const before = state(cwd, ['build/output'])
    const error = await refusal(new GitService().pull(cwd, USER, { strategy }))
    expect(error.message).toBe('Pulling origin/main would overwrite an ignored file: build/output. Move it aside, then try again. Nothing was changed.')
    expect(state(cwd, ['build/output'])).toEqual(before)
  }, 60_000)

  it.each(['merge', 'rebase'] as const)('%s refuses when the upstream starts tracking an ignored file', async (strategy) => {
    const cwd = repo(), mine = upstreamTracksEnv(cwd)
    localCommit(cwd)
    const error = await refusal(new GitService().pull(cwd, USER, { strategy }))
    expect(error.code).toBe('git_ignored_in_the_way')
    expect(read(cwd, '.env')).toBe(mine)
  }, 60_000)

  it.each([['merge', 'merged'], ['rebase', 'rebased']] as const)('a clean diverged %s still pulls, with ignored files beside it', async (strategy, result) => {
    const cwd = repo(), { push } = withRemote(cwd)
    write(cwd, 'src/app.ts', 'app\n'); commitAll(cwd, 'app'); git(cwd, 'push', '-q')
    push((other) => { git(other, 'pull', '-q'); git(other, 'mv', 'src', 'lib'); write(other, 'up.txt', 'up\n'); commitAll(other, 'move src to lib') })
    write(cwd, 'notes.txt', 'local\n'); commitAll(cwd, 'local')
    write(cwd, '.env', 'mine\n'); write(cwd, 'ignored/cache.bin', 'cache\n')
    await expect(new GitService().pull(cwd, USER, { strategy })).resolves.toEqual({ result })
    expect([read(cwd, 'up.txt'), read(cwd, 'lib/app.ts'), read(cwd, 'notes.txt'), read(cwd, '.env'), read(cwd, 'ignored/cache.bin')]).toEqual(['up\n', 'app\n', 'local\n', 'mine\n', 'cache\n'])
  }, 60_000)
})
