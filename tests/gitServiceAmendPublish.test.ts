import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { withGitMutationLocks } from '../src/mms/actions/GitOperationCoordinator'
import { choosePushRemote, GitService } from '../src/mms/git/GitService'
import { userAction } from '../src/mms/git/gitPolicy'
import { resolveRepositoryIdentity } from '../src/mms/git/RepositoryIdentity'
import { acquireRepositoryLease } from '../src/mms/git/RepositoryLease'

/** The user's request a test passes to a GitService change. */
const USER = userAction('button', 'Test action')

const roots: string[] = []
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'mousse-git-amend-')); roots.push(root)
  const origin = join(root, 'origin.git'), cwd = join(root, 'work')
  git(root, 'init', '--bare', '-b', 'main', origin)
  git(root, 'init', '-b', 'main', cwd)
  git(cwd, 'config', 'user.name', 'Amend fixture'); git(cwd, 'config', 'user.email', 'git-fixture@example.invalid')
  git(cwd, 'config', 'commit.gpgsign', 'false'); git(cwd, 'config', 'core.hooksPath', join(root, 'no-hooks'))
  git(cwd, 'config', 'push.default', 'simple')
  return { root, origin, cwd }
}
const commitFile = (cwd: string, name: string, message: string) => {
  writeFileSync(join(cwd, name), `${name}\n`); git(cwd, 'add', name); git(cwd, 'commit', '-m', message)
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('choosePushRemote', () => {
  it('prefers branch pushRemote, then remote.pushDefault, then origin, then the only remote', () => {
    expect(choosePushRemote({ pushRemote: 'fork', pushDefault: 'team', remotes: ['origin', 'team', 'fork'] })).toBe('fork')
    expect(choosePushRemote({ pushRemote: null, pushDefault: 'team', remotes: ['origin', 'team'] })).toBe('team')
    expect(choosePushRemote({ pushRemote: null, pushDefault: null, remotes: ['team', 'origin'] })).toBe('origin')
    expect(choosePushRemote({ pushRemote: null, pushDefault: null, remotes: ['team'] })).toBe('team')
  })

  it('returns null with no remotes or an ambiguous set', () => {
    expect(choosePushRemote({ pushRemote: null, pushDefault: null, remotes: [] })).toBeNull()
    expect(choosePushRemote({ pushRemote: null, pushDefault: null, remotes: ['a', 'b'] })).toBeNull()
  })
})

describe('GitService amend', () => {
  it('amends an unpushed commit with new files and a new message', async () => {
    const { cwd } = fixture(); commitFile(cwd, 'a.txt', 'first')
    writeFileSync(join(cwd, 'b.txt'), 'b\n')
    await new GitService().commit(cwd, USER, 'first, reworded', { amend: true })
    expect(git(cwd, 'rev-list', '--count', 'HEAD')).toBe('1')
    expect(git(cwd, 'log', '-1', '--format=%s')).toBe('first, reworded')
    expect(git(cwd, 'show', '--name-only', '--format=', 'HEAD').split('\n').sort()).toEqual(['a.txt', 'b.txt'])
  })

  it('amends only the message when nothing changed', async () => {
    const { cwd } = fixture(); commitFile(cwd, 'a.txt', 'typo')
    await new GitService().commit(cwd, USER, 'fixed', { amend: true })
    expect(git(cwd, 'log', '-1', '--format=%s')).toBe('fixed')
    expect(git(cwd, 'rev-list', '--count', 'HEAD')).toBe('1')
  })

  it('refuses to amend a commit that is already pushed', async () => {
    const { cwd } = fixture(); git(cwd, 'remote', 'add', 'origin', join(cwd, '..', 'origin.git'))
    commitFile(cwd, 'a.txt', 'shared'); git(cwd, 'push', '-u', 'origin', 'main')
    const before = git(cwd, 'rev-parse', 'HEAD')
    await expect(new GitService().commit(cwd, USER, 'rewrite', { amend: true })).rejects.toMatchObject({ code: 'git_amend_pushed' })
    expect(git(cwd, 'rev-parse', 'HEAD')).toBe(before)
  })

  it('amends a commit made after the last push', async () => {
    const { cwd } = fixture(); git(cwd, 'remote', 'add', 'origin', join(cwd, '..', 'origin.git'))
    commitFile(cwd, 'a.txt', 'shared'); git(cwd, 'push', '-u', 'origin', 'main'); commitFile(cwd, 'b.txt', 'local')
    await new GitService().commit(cwd, USER, 'local, reworded', { amend: true })
    expect(git(cwd, 'log', '-1', '--format=%s')).toBe('local, reworded')
  })

  it('refuses to amend a pushed commit on a new branch without an upstream', async () => {
    const { cwd, origin } = fixture(); git(cwd, 'remote', 'add', 'origin', origin)
    commitFile(cwd, 'a.txt', 'shared'); git(cwd, 'push', '-u', 'origin', 'main'); git(cwd, 'checkout', '-b', 'thread-worktree')
    await expect(new GitService().commit(cwd, USER, 'rewrite', { amend: true })).rejects.toMatchObject({ code: 'git_amend_pushed' })
    const [head] = await new GitService().getLog(cwd)
    expect(head).toMatchObject({ pushed: false, onRemote: true })
    commitFile(cwd, 'b.txt', 'local')
    const [local] = await new GitService().getLog(cwd)
    expect(local).toMatchObject({ pushed: false, onRemote: false })
  })

  it('treats every commit as local in a repository without remotes', async () => {
    const { cwd } = fixture(); commitFile(cwd, 'a.txt', 'first')
    const [head] = await new GitService().getLog(cwd)
    expect(head.onRemote).toBe(false)
  })

  it('refuses to amend a repository without commits', async () => {
    const { cwd } = fixture()
    await expect(new GitService().commit(cwd, USER, 'nothing', { amend: true })).rejects.toMatchObject({ code: 'git_amend_no_commit' })
  })
})

describe('GitService last commit message', () => {
  it('returns the full HEAD message, or null without a commit or repository', async () => {
    const { cwd, root } = fixture(), service = new GitService()
    expect(await service.lastCommitMessage(cwd)).toBeNull()
    writeFileSync(join(cwd, 'a.txt'), 'a\n'); git(cwd, 'add', 'a.txt'); git(cwd, 'commit', '-m', 'subject', '-m', 'body line')
    expect(await service.lastCommitMessage(cwd)).toBe('subject\n\nbody line')
    expect(await service.lastCommitMessage(join(root, 'missing'))).toBeNull()
  })
})

describe('GitService push', () => {
  it('publishes a branch without an upstream to origin and sets the upstream', async () => {
    const { cwd, origin } = fixture(); git(cwd, 'remote', 'add', 'origin', origin)
    commitFile(cwd, 'a.txt', 'first'); git(cwd, 'checkout', '-b', 'feature')
    await new GitService().push(cwd, USER)
    expect(git(cwd, 'rev-parse', '--abbrev-ref', '@{upstream}')).toBe('origin/feature')
    expect(git(origin, 'rev-parse', 'refs/heads/feature')).toBe(git(cwd, 'rev-parse', 'HEAD'))
  })

  it('publishes to the only remote when it is not called origin', async () => {
    const { cwd, origin } = fixture(); git(cwd, 'remote', 'add', 'team', origin)
    commitFile(cwd, 'a.txt', 'first')
    await new GitService().push(cwd, USER)
    expect(git(cwd, 'rev-parse', '--abbrev-ref', '@{upstream}')).toBe('team/main')
  })

  it('pushes to the existing upstream as before', async () => {
    const { cwd, origin } = fixture(); git(cwd, 'remote', 'add', 'origin', origin)
    commitFile(cwd, 'a.txt', 'first'); git(cwd, 'push', '-u', 'origin', 'main'); commitFile(cwd, 'b.txt', 'second')
    await new GitService().push(cwd, USER)
    expect(git(origin, 'rev-parse', 'refs/heads/main')).toBe(git(cwd, 'rev-parse', 'HEAD'))
  })

  it('reports a missing remote and a detached HEAD with typed errors', async () => {
    const { cwd } = fixture(), service = new GitService()
    commitFile(cwd, 'a.txt', 'first')
    await expect(service.push(cwd, USER)).rejects.toMatchObject({ code: 'git_no_remote', message: 'Add a remote before pushing.' })
    git(cwd, 'checkout', '--detach')
    await expect(service.push(cwd, USER)).rejects.toMatchObject({ code: 'git_detached_head' })
  })
})

describe('GitService rejected push', () => {
  it('reports a push the remote refused because it has newer commits', async () => {
    const { root, cwd, origin } = fixture(); git(cwd, 'remote', 'add', 'origin', origin)
    commitFile(cwd, 'a.txt', 'first'); git(cwd, 'push', '-u', 'origin', 'main')
    const other = join(root, 'other'); git(root, 'clone', '-q', '-b', 'main', origin, other)
    git(other, 'config', 'user.name', 'Other'); git(other, 'config', 'user.email', 'other@example.invalid'); git(other, 'config', 'commit.gpgsign', 'false')
    commitFile(other, 'b.txt', 'theirs'); git(other, 'push', '-q')
    commitFile(cwd, 'c.txt', 'mine')
    await expect(new GitService().push(cwd, USER)).rejects.toMatchObject({ code: 'git_push_rejected' })
  })
})

describe('GitService status', () => {
  it('lists unstaged, staged and partly staged changes', async () => {
    const { cwd } = fixture(); commitFile(cwd, 'a.txt', 'first'); commitFile(cwd, 'b.txt', 'second')
    writeFileSync(join(cwd, 'a.txt'), 'edited\n')
    writeFileSync(join(cwd, 'b.txt'), 'staged\n'); git(cwd, 'add', 'b.txt')
    writeFileSync(join(cwd, 'c.txt'), 'new\n')
    const { changes } = await new GitService().getStatus(cwd)
    expect(changes).toEqual(expect.arrayContaining([
      { path: 'a.txt', status: 'modified', staged: false, originalPath: undefined },
      { path: 'b.txt', status: 'modified', staged: true, originalPath: undefined },
      { path: 'c.txt', status: 'untracked', staged: false }
    ]))
    expect(changes).toHaveLength(3)
  })
})

describe('GitService mutations', () => {
  it('runs changes to one folder one at a time', async () => {
    const { cwd, origin } = fixture(); git(cwd, 'remote', 'add', 'origin', origin)
    commitFile(cwd, 'a.txt', 'first'); git(cwd, 'push', '-u', 'origin', 'main')
    const service = new GitService()
    const writes = Array.from({ length: 4 }, (_, index) => {
      writeFileSync(join(cwd, `f${index}.txt`), `${index}\n`)
      return service.commit(cwd, USER, `commit ${index}`)
    })
    // Every commit after the first finds nothing left to stage, so only the first may succeed;
    // none may fail on Git's index lock, which concurrent `git add` runs would hit.
    const results = await Promise.allSettled([...writes, service.push(cwd, USER)])
    const lockErrors = results.filter((result) => result.status === 'rejected' && /index\.lock/.test(String(result.reason)))
    expect(lockErrors).toEqual([])
    expect(git(cwd, 'status', '--porcelain')).toBe('')
    expect(git(origin, 'rev-parse', 'refs/heads/main')).toBe(git(cwd, 'rev-parse', 'HEAD'))
  })
})

describe('GitService init', () => {
  it('initializes a plain folder and refuses an existing repository or a missing folder', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mousse-git-init-')); roots.push(root)
    const folder = join(root, 'plain'); mkdirSync(folder)
    const service = new GitService()
    await service.init(folder, USER)
    expect((await service.getStatus(folder)).isRepo).toBe(true)
    await expect(service.init(folder, USER)).rejects.toMatchObject({ code: 'git_already_repo' })
    await expect(service.init(join(root, 'missing'), USER)).rejects.toMatchObject({ code: 'git_init_no_folder' })
  })
})

describe('GitService lease', () => {
  it('waits for the repository mutation lease, which every worktree shares', async () => {
    const { root, cwd } = fixture(); commitFile(cwd, 'a.txt', 'first')
    const linked = join(root, 'linked'); git(cwd, 'worktree', 'add', '-q', '-b', 'other', linked)
    // Another holder, here the lease taken through a linked worktree of the same repository.
    const held = await acquireRepositoryLease(resolveRepositoryIdentity(linked))
    writeFileSync(join(cwd, 'b.txt'), 'b\n')
    let done = false
    const committing = new GitService().commit(cwd, USER, 'second').then(() => { done = true })
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(done).toBe(false)
    held.release()
    await committing
    expect(git(cwd, 'log', '-1', '--format=%s')).toBe('second')
  })

  it('runs inside a Git action that already holds the lease instead of waiting on itself', async () => {
    const { root, cwd, origin } = fixture(); git(cwd, 'remote', 'add', 'origin', origin)
    commitFile(cwd, 'a.txt', 'first')
    const threadDir = join(root, 'thread'); mkdirSync(threadDir)
    await withGitMutationLocks(threadDir, cwd, 'test-push', () => new GitService().push(cwd, USER))
    expect(git(origin, 'rev-parse', 'refs/heads/main')).toBe(git(cwd, 'rev-parse', 'HEAD'))
  })

  it('covers two service instances, as the desktop app and the background service run', async () => {
    const { cwd, origin } = fixture(); git(cwd, 'remote', 'add', 'origin', origin)
    commitFile(cwd, 'a.txt', 'first'); git(cwd, 'push', '-u', 'origin', 'main')
    const results = await Promise.allSettled(Array.from({ length: 4 }, (_, index) => {
      writeFileSync(join(cwd, `f${index}.txt`), `${index}\n`)
      return new GitService().commit(cwd, USER, `commit ${index}`)
    }))
    expect(results.filter((result) => result.status === 'rejected' && /index\.lock/.test(String(result.reason)))).toEqual([])
    expect(git(cwd, 'status', '--porcelain')).toBe('')
  })
})
