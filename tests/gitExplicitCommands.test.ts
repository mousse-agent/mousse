import { execFileSync } from 'node:child_process'
import { lutimesSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { gitDirectoryEnv, isGitDirectory, withGitConfigEnv } from '../src/mms/git/gitEnv'
import { GitService } from '../src/mms/git/GitService'
import { readOnlyGit, runReadOnlyGit } from '../src/mms/git/readOnlyGit'
import { conflictPair, readWorkingTreeStatus, readWorkingTreeStatusSync } from '../src/mms/git/workingTreeStatus'
import { inspectPendingChanges } from '../src/mms/actions/git'
import { lifecycleGit, lifecycleRead } from '../src/mms/lifecycle/WorktreeRetirementService'

const roots: string[] = []
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}
function scratch(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  roots.push(root)
  return root
}
function configure(cwd: string): void {
  git(cwd, 'config', 'user.name', 'Explicit fixture')
  git(cwd, 'config', 'user.email', 'explicit@example.invalid')
  git(cwd, 'config', 'commit.gpgsign', 'false')
  git(cwd, 'config', 'tag.gpgsign', 'false')
}
function write(cwd: string, name: string, text = `${name}\n`): void {
  writeFileSync(join(cwd, name), text)
}

/** `work` clones `origin.git` on `main`, with a second branch `other` that is also on the remote. */
function cloned() {
  const root = scratch('mousse-explicit-')
  const origin = join(root, 'origin.git')
  const cwd = join(root, 'work')
  git(root, 'init', '--bare', '-b', 'main', origin)
  git(root, 'init', '-b', 'main', cwd)
  configure(cwd)
  git(cwd, 'config', 'core.hooksPath', join(root, 'no-hooks'))
  git(cwd, 'remote', 'add', 'origin', origin)
  write(cwd, 'base.txt')
  git(cwd, 'add', '-A')
  git(cwd, 'commit', '-qm', 'base')
  git(cwd, 'push', '-q', '-u', 'origin', 'main')
  git(cwd, 'branch', 'other')
  git(cwd, 'push', '-q', '-u', 'origin', 'other')
  const base = git(cwd, 'rev-parse', 'HEAD')
  return { root, origin, cwd, base }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('Push sends only the branch it names', () => {
  it('pushes the current branch alone, whatever push.default, remote push refspecs and push.followTags say', async () => {
    const { origin, cwd, base } = cloned()
    git(cwd, 'config', 'push.default', 'matching')
    git(cwd, 'config', 'remote.origin.push', 'refs/heads/*:refs/heads/*')
    git(cwd, 'config', 'push.followTags', 'true')
    git(cwd, 'checkout', '-q', 'other')
    write(cwd, 'other.txt'); git(cwd, 'add', '-A'); git(cwd, 'commit', '-qm', 'other')
    git(cwd, 'checkout', '-q', 'main')
    write(cwd, 'main.txt'); git(cwd, 'add', '-A'); git(cwd, 'commit', '-qm', 'main')
    git(cwd, 'tag', '-a', 'v1', '-m', 'v1')
    await new GitService().push(cwd)
    expect(git(origin, 'rev-parse', 'refs/heads/main')).toBe(git(cwd, 'rev-parse', 'main'))
    expect(git(origin, 'rev-parse', 'refs/heads/other')).toBe(base)
    expect(git(origin, 'tag', '--list')).toBe('')
  })

  it('refuses a branch whose upstream has another name on the same remote, so it never pushes into main', async () => {
    const { origin, cwd, base } = cloned()
    git(cwd, 'checkout', '-q', '-b', 'feature', '--track', 'origin/main')
    write(cwd, 'feature.txt'); git(cwd, 'add', '-A'); git(cwd, 'commit', '-qm', 'feature')
    await expect(new GitService().push(cwd)).rejects.toMatchObject({ code: 'git_upstream_name_differs' })
    expect(git(origin, 'rev-parse', 'refs/heads/main')).toBe(base)
    expect(git(origin, 'for-each-ref', '--format=%(refname)', 'refs/heads/feature')).toBe('')
  })

  it('refuses a branch that tracks a local branch instead of publishing it over that choice', async () => {
    const { cwd } = cloned()
    git(cwd, 'checkout', '-q', '-b', 'feature', '--track', 'main')
    await expect(new GitService().push(cwd)).rejects.toMatchObject({ code: 'git_upstream_local' })
    expect(git(cwd, 'rev-parse', '--abbrev-ref', '@{upstream}')).toBe('main')
  })

  it('publishes a new branch under its own name and tracks it, ignoring push.default=nothing', async () => {
    const { origin, cwd } = cloned()
    git(cwd, 'config', 'push.default', 'nothing')
    git(cwd, 'checkout', '-q', '-b', 'fresh')
    write(cwd, 'fresh.txt'); git(cwd, 'add', '-A'); git(cwd, 'commit', '-qm', 'fresh')
    await new GitService().push(cwd)
    expect(git(origin, 'rev-parse', 'refs/heads/fresh')).toBe(git(cwd, 'rev-parse', 'HEAD'))
    expect(git(cwd, 'rev-parse', '--abbrev-ref', '@{upstream}')).toBe('origin/fresh')
  })
})

describe('Fetch and pull never prune', () => {
  it('keeps remote-tracking branches and local tags that fetch.prune and fetch.pruneTags would delete', async () => {
    const { origin, cwd } = cloned()
    git(cwd, 'tag', 'local-only')
    git(origin, 'branch', '-D', 'other')
    git(cwd, 'config', 'fetch.prune', 'true')
    git(cwd, 'config', 'fetch.pruneTags', 'true')
    git(cwd, 'config', 'remote.origin.prune', 'true')
    const service = new GitService()
    await service.fetch(cwd)
    await service.pull(cwd)
    expect(git(cwd, 'for-each-ref', '--format=%(refname)', 'refs/remotes/origin/other')).toBe('refs/remotes/origin/other')
    expect(git(cwd, 'tag', '--list', 'local-only')).toBe('local-only')
  })
})

/** Every path state `git status` knows, with a staged rename, an intent-to-add file and a conflict. */
function busy(): string {
  const root = scratch('mousse-plumbing-status-')
  const cwd = join(root, 'work')
  git(root, 'init', '-q', '-b', 'main', cwd)
  configure(cwd)
  for (const name of ['modified.txt', 'staged.txt', 'both.txt', 'deleted.txt', 'removed.txt', 'renamed.txt', 'conflict.txt', 'touched.txt']) write(cwd, name, `${name} original\n`)
  mkdirSync(join(cwd, 'dir'))
  write(cwd, 'dir/nested.txt')
  git(cwd, 'add', '-A'); git(cwd, 'commit', '-qm', 'base')
  git(cwd, 'checkout', '-q', '-b', 'side')
  write(cwd, 'conflict.txt', 'side\n'); git(cwd, 'commit', '-qam', 'side')
  git(cwd, 'checkout', '-q', 'main')
  write(cwd, 'conflict.txt', 'main\n'); git(cwd, 'commit', '-qam', 'main')
  try { git(cwd, 'merge', '-q', 'side') } catch { /* stops on the conflict */ }
  write(cwd, 'modified.txt', 'changed\n')
  write(cwd, 'staged.txt', 'staged\n'); git(cwd, 'add', 'staged.txt')
  write(cwd, 'both.txt', 'one\n'); git(cwd, 'add', 'both.txt'); write(cwd, 'both.txt', 'two\n')
  rmSync(join(cwd, 'deleted.txt'))
  git(cwd, 'rm', '-q', 'removed.txt')
  git(cwd, 'mv', 'renamed.txt', 'moved.txt')
  write(cwd, 'added.txt'); git(cwd, 'add', 'added.txt')
  write(cwd, 'intent.txt'); git(cwd, 'add', '-N', 'intent.txt')
  write(cwd, 'untracked.txt'); write(cwd, 'dir/untracked.txt')
  write(cwd, '.gitignore', 'ignored.txt\n'); write(cwd, 'ignored.txt')
  // Same content, other times: only a stat refresh would tell it apart.
  utimesSync(join(cwd, 'touched.txt'), new Date('2020-01-01'), new Date('2020-01-01'))
  return cwd
}

/** `git status --porcelain=v1 -z` as entries, for comparing with the plumbing read. */
function porcelain(cwd: string) {
  const fields = git(cwd, 'status', '--porcelain=v1', '-z', '--untracked-files=all').split('\0')
  const entries: Array<{ path: string; index: string; workdir: string; from?: string }> = []
  for (let index = 0; index < fields.length; index++) {
    const line = fields[index]!
    if (!line) continue
    const [x, y, path] = [line[0]!, line[1]!, line.slice(3)]
    const entry = { path, index: x === ' ' ? '' : x, workdir: y === ' ' ? '' : y } as { path: string; index: string; workdir: string; from?: string }
    if (x === 'R' || x === 'C') entry.from = fields[++index]
    entries.push(entry)
  }
  return entries.sort((a, b) => (a.path < b.path ? -1 : 1))
}

describe('Status reads use plumbing and never write the index', () => {
  it('reports what git status reports, including a rename, an intent-to-add file, a conflict and a touched file', async () => {
    const cwd = busy()
    const index = join(cwd, '.git', 'index')
    const before = readFileSync(index)
    const mtime = statSync(index).mtimeMs
    const read = (await readWorkingTreeStatus(cwd)).sort((a, b) => (a.path < b.path ? -1 : 1))
    expect(readFileSync(index).equals(before)).toBe(true)
    expect(statSync(index).mtimeMs).toBe(mtime)
    expect(read.find((entry) => entry.path === 'touched.txt')).toBeUndefined()
    expect(read.find((entry) => entry.path === 'conflict.txt')).toMatchObject({ index: 'U', workdir: 'U' })
    expect(read.find((entry) => entry.path === 'moved.txt')).toMatchObject({ index: 'R', from: 'renamed.txt' })
    expect(read.find((entry) => entry.path === 'intent.txt')).toMatchObject({ index: '', workdir: 'A' })
    // Compared last: `git status` itself refreshes the index.
    expect(read).toEqual(porcelain(cwd))
  })

  it('GitService.getStatus leaves the index as it was', async () => {
    const cwd = busy()
    const index = join(cwd, '.git', 'index')
    const before = readFileSync(index)
    const status = await new GitService().getStatus(cwd)
    expect(readFileSync(index).equals(before)).toBe(true)
    expect(status.changes.some((change) => change.path === 'touched.txt')).toBe(false)
    expect(status.changes).toEqual(expect.arrayContaining([
      { path: 'modified.txt', status: 'modified', staged: false },
      { path: 'both.txt', status: 'modified', staged: true },
      { path: 'both.txt', status: 'modified', staged: false },
      { path: 'conflict.txt', status: 'conflicted', staged: false },
      { path: 'untracked.txt', status: 'untracked', staged: false }
    ]))
  })

  it('GitService diffs and diff stats leave the index alone, where plain git diff rewrites it', async () => {
    const cwd = busy()
    const index = join(cwd, '.git', 'index')
    const before = readFileSync(index)
    const service = new GitService()
    expect(await service.getDiff(cwd, 'modified.txt', false)).toContain('+changed')
    expect(await service.getDiff(cwd, 'touched.txt', false)).toBe('')
    expect((await service.getDiffStats(cwd)).filesChanged).toBeGreaterThan(0)
    expect(readFileSync(index).equals(before)).toBe(true)
    // The control: Git's own default refreshes the touched file into the index.
    execFileSync('git', ['diff', '--quiet', '--', 'touched.txt'], { cwd, stdio: 'ignore' })
    expect(readFileSync(index).equals(before)).toBe(false)
  })

  it('reads an unborn branch against the empty tree', async () => {
    const cwd = join(scratch('mousse-plumbing-unborn-'), 'work')
    git(tmpdir(), 'init', '-q', cwd)
    write(cwd, 'new.txt'); git(cwd, 'add', 'new.txt'); write(cwd, 'loose.txt')
    expect(await readWorkingTreeStatus(cwd)).toEqual([
      { path: 'new.txt', index: 'A', workdir: '' },
      { path: 'loose.txt', index: '?', workdir: '?' }
    ])
  })

  it('names each conflict the way git status does', () => {
    expect(conflictPair(new Set([1, 2, 3]))).toBe('UU')
    expect(conflictPair(new Set([2, 3]))).toBe('AA')
    expect(conflictPair(new Set([1, 2]))).toBe('UD')
    expect(conflictPair(new Set([1, 3]))).toBe('DU')
    expect(conflictPair(new Set([2]))).toBe('AU')
    expect(conflictPair(new Set([3]))).toBe('UA')
    expect(conflictPair(new Set([1]))).toBe('DD')
  })

  it.skipIf(process.platform === 'win32')('compares a link by its target: new times are no change, a new target is', async () => {
    const cwd = join(scratch('mousse-plumbing-link-'), 'work')
    git(tmpdir(), 'init', '-q', '-b', 'main', cwd)
    configure(cwd)
    write(cwd, 'target.txt'); write(cwd, 'other.txt')
    symlinkSync('target.txt', join(cwd, 'link'))
    git(cwd, 'add', '-A'); git(cwd, 'commit', '-qm', 'base')
    // Same target, other times: a stat-only difference `diff-files` reports as a change.
    lutimesSync(join(cwd, 'link'), new Date('2020-01-01'), new Date('2020-01-01'))
    expect(git(cwd, 'diff-files', '--name-only')).toBe('link')
    expect(await readWorkingTreeStatus(cwd)).toEqual([])
    expect(readWorkingTreeStatusSync(cwd)).toEqual([])
    unlinkSync(join(cwd, 'link')); symlinkSync('other.txt', join(cwd, 'link'))
    expect(await readWorkingTreeStatus(cwd)).toEqual([{ path: 'link', index: '', workdir: 'M' }])
  })

  it('inspectPendingChanges reads with plumbing and leaves the index alone', () => {
    const cwd = busy()
    const index = join(cwd, '.git', 'index')
    const before = readFileSync(index)
    const mtime = statSync(index).mtimeMs
    const pending = inspectPendingChanges(cwd)
    expect(readFileSync(index).equals(before)).toBe(true)
    expect(statSync(index).mtimeMs).toBe(mtime)
    expect(pending.unmerged).toEqual(['conflict.txt'])
    expect(pending.operation).toBe('merge')
    expect(pending.files).toContain('moved.txt')
    expect(pending.files).toContain('dir/untracked.txt')
    expect(pending.files).not.toContain('touched.txt')
    expect(pending.files).not.toContain('ignored.txt')
    expect(pending.files[0]).toBe('conflict.txt')
  })

  it('lifecycle reads before a delete take no optional lock', () => {
    const cwd = busy()
    const index = join(cwd, '.git', 'index')
    const before = readFileSync(index)
    expect(lifecycleRead(cwd, ['status', '--porcelain=v1', '--untracked-files=all'])).not.toBe('')
    expect(readFileSync(index).equals(before)).toBe(true)
  })
})

describe('Every Git run carries safe.bareRepository=explicit', () => {
  it('appends after the entries the environment already has, once', () => {
    const env = withGitConfigEnv({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'Someone' })
    expect(env).toMatchObject({ GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'Someone', GIT_CONFIG_KEY_1: 'safe.bareRepository', GIT_CONFIG_VALUE_1: 'explicit' })
    expect(withGitConfigEnv(env)).toEqual(env)
    // A later entry of the user's own would win, so ours goes after it.
    const overridden = withGitConfigEnv({ ...env, GIT_CONFIG_COUNT: '3', GIT_CONFIG_KEY_2: 'safe.bareRepository', GIT_CONFIG_VALUE_2: 'all' })
    expect(overridden).toMatchObject({ GIT_CONFIG_COUNT: '4', GIT_CONFIG_KEY_3: 'safe.bareRepository', GIT_CONFIG_VALUE_3: 'explicit' })
    expect(withGitConfigEnv({ GIT_CONFIG_COUNT: 'x', GIT_CONFIG_KEY_0: 'a.b' })).toEqual({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'safe.bareRepository', GIT_CONFIG_VALUE_0: 'explicit' })
  })

  it('never finds a bare repository left inside a project', () => {
    const root = scratch('mousse-embedded-bare-')
    const embedded = join(root, 'project', 'vendor.git')
    git(root, 'init', '-q', '--bare', embedded)
    mkdirSync(join(embedded, 'objects', 'deep'), { recursive: true })
    // Plain Git finds it from below; Mousse's Git does not.
    expect(git(join(embedded, 'objects', 'deep'), 'rev-parse', '--is-bare-repository')).toBe('true')
    const run = runReadOnlyGit(join(embedded, 'objects', 'deep'), ['rev-parse', '--is-bare-repository'])
    expect(run.status).not.toBe(0)
    expect(run.stderr).toMatch(/safe\.bareRepository/)
  })

  it('still runs in a common directory Mousse names, for a worktree of a bare repository', () => {
    const root = realpathSync(scratch('mousse-bare-worktree-'))
    const bare = join(root, 'repo.git')
    git(root, 'init', '-q', '--bare', '-b', 'main', bare)
    const seed = join(root, 'seed')
    git(root, 'clone', '-q', bare, seed); configure(seed)
    write(seed, 'a.txt'); git(seed, 'add', '-A'); git(seed, 'commit', '-qm', 'a'); git(seed, 'push', '-q', 'origin', 'main')
    git(bare, 'worktree', 'add', '-q', join(root, 'main'), 'main')
    expect(isGitDirectory(bare)).toBe(true)
    expect(isGitDirectory(join(root, 'main'))).toBe(false)
    expect(gitDirectoryEnv(bare)).toEqual({ GIT_DIR: bare })
    expect(lifecycleGit(bare, ['worktree', 'list', '--porcelain'])).toContain(`worktree ${join(root, 'main')}`)
    expect(readOnlyGit(join(root, 'main'), ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('main')
  })
})
