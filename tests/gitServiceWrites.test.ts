import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { GitService } from '../src/mms/git/GitService'
import type { GitOperationEvent } from '../src/shared/types'

const roots: string[] = []
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

function repo() {
  const cwd = mkdtempSync(join(tmpdir(), 'mousse-git-writes-')); roots.push(cwd)
  git(cwd, 'init', '-b', 'main')
  git(cwd, 'config', 'user.name', 'Git write fixture'); git(cwd, 'config', 'user.email', 'git-fixture@example.invalid')
  git(cwd, 'config', 'commit.gpgsign', 'false'); git(cwd, 'config', 'core.hooksPath', join(cwd, '.no-hooks'))
  writeFileSync(join(cwd, 'base.txt'), 'base\n'); git(cwd, 'add', 'base.txt'); git(cwd, 'commit', '-m', 'baseline')
  return cwd
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

// Not trimmed: the first status code of a line can be a space.
const porcelain = (cwd: string) => execFileSync('git', ['status', '--porcelain=v1', '-uall'], { cwd, encoding: 'utf8' }).split('\n').filter(Boolean).sort()
const changes = async (cwd: string) => (await new GitService().getStatus(cwd)).changes
const write = (cwd: string, name: string, text = `${name}\n`) => {
  mkdirSync(dirname(join(cwd, name)), { recursive: true }); writeFileSync(join(cwd, name), text)
}
/** Points the repository's hooks at a directory holding a `pre-commit` that runs a node script from the repository folder. */
function withHook(cwd: string, script: string, name = 'pre-commit'): string {
  const dir = join(dirname(cwd), `${basename(cwd)}-hooks`); roots.push(dir); mkdirSync(dir, { recursive: true })
  const body = join(dir, `${name}.cjs`); writeFileSync(body, script)
  writeFileSync(join(dir, name), `#!/bin/sh\nexec node "${body.replace(/\\/g, '/')}"\n`, { mode: 0o755 })
  git(cwd, 'config', 'core.hooksPath', dir)
  return dir
}
const rejectingHook = "console.error('hook says no'); process.exit(1)"
const renameSource = 'rename me\nwith some lines\nto keep it similar\n'

describe('GitService writes', () => {
  it('commit stages tracked, new and deleted files together under the given message', async () => {
    const cwd = repo()
    writeFileSync(join(cwd, 'base.txt'), 'changed\n'); writeFileSync(join(cwd, 'added.txt'), 'new\n')
    writeFileSync(join(cwd, 'doomed.txt'), 'bye\n'); git(cwd, 'add', 'doomed.txt'); git(cwd, 'commit', '-m', 'add doomed')
    rmSync(join(cwd, 'doomed.txt'))
    await new GitService().commit(cwd, 'all changes')
    expect(git(cwd, 'log', '-1', '--format=%s')).toBe('all changes')
    expect(git(cwd, 'show', '--name-status', '--format=', 'HEAD').split('\n').sort()).toEqual(['A\tadded.txt', 'D\tdoomed.txt', 'M\tbase.txt'])
    expect(git(cwd, 'status', '--porcelain')).toBe('')
  })

  it('commit with a clean tree leaves the history alone', async () => {
    const cwd = repo(), before = git(cwd, 'rev-parse', 'HEAD')
    await new GitService().commit(cwd, 'empty attempt')
    expect(git(cwd, 'rev-parse', 'HEAD')).toBe(before)
  })

  it('checkout switches to an existing branch and rejects an unknown one without moving HEAD', async () => {
    const cwd = repo(); git(cwd, 'branch', 'feature')
    const service = new GitService()
    await service.checkout(cwd, 'feature')
    expect(git(cwd, 'symbolic-ref', '--short', 'HEAD')).toBe('feature')
    await expect(service.checkout(cwd, 'does-not-exist')).rejects.toThrow()
    expect(git(cwd, 'symbolic-ref', '--short', 'HEAD')).toBe('feature')
    expect(existsSync(join(cwd, 'base.txt'))).toBe(true)
  })

  it('checkout refuses to overwrite uncommitted work that the target branch changes', async () => {
    const cwd = repo()
    git(cwd, 'checkout', '-b', 'other'); writeFileSync(join(cwd, 'base.txt'), 'other branch\n'); git(cwd, 'commit', '-am', 'other change'); git(cwd, 'checkout', 'main')
    writeFileSync(join(cwd, 'base.txt'), 'uncommitted local work\n')
    await expect(new GitService().checkout(cwd, 'other')).rejects.toThrow()
    expect(git(cwd, 'symbolic-ref', '--short', 'HEAD')).toBe('main')
    expect(readFileSync(join(cwd, 'base.txt'), 'utf8')).toBe('uncommitted local work\n')
  })
})

describe('GitService status', () => {
  it('reports a staged file edited again on both sides', async () => {
    const cwd = repo()
    write(cwd, 'base.txt', 'staged\n'); git(cwd, 'add', 'base.txt'); write(cwd, 'base.txt', 'staged and edited\n')
    expect((await changes(cwd)).filter((change) => change.path === 'base.txt')).toEqual([
      { path: 'base.txt', status: 'modified', staged: true },
      { path: 'base.txt', status: 'modified', staged: false }
    ])
  })

  it('reports an untracked file once and a staged add edited again twice', async () => {
    const cwd = repo()
    write(cwd, 'new.txt'); write(cwd, 'both.txt'); git(cwd, 'add', 'both.txt'); write(cwd, 'both.txt', 'again\n')
    const found = await changes(cwd)
    expect(found.filter((change) => change.path === 'new.txt')).toEqual([{ path: 'new.txt', status: 'untracked', staged: false }])
    expect(found.filter((change) => change.path === 'both.txt').map((change) => [change.status, change.staged])).toEqual([['added', true], ['modified', false]])
  })

  it('maps unmerged paths to one conflicted entry each and reports the merge in progress', async () => {
    const cwd = repo()
    git(cwd, 'checkout', '-b', 'other'); write(cwd, 'base.txt', 'other\n'); write(cwd, 'both.txt', 'other\n'); git(cwd, 'add', '-A'); git(cwd, 'commit', '-m', 'other')
    git(cwd, 'checkout', 'main'); write(cwd, 'base.txt', 'main\n'); write(cwd, 'both.txt', 'main\n'); git(cwd, 'add', '-A'); git(cwd, 'commit', '-m', 'main')
    expect((await new GitService().getStatus(cwd)).inProgress).toBeNull()
    expect(() => git(cwd, 'merge', 'other')).toThrow()
    const status = await new GitService().getStatus(cwd)
    expect(status.inProgress).toBe('merge')
    expect(status.changes).toEqual([
      { path: 'base.txt', status: 'conflicted', staged: false },
      { path: 'both.txt', status: 'conflicted', staged: false }
    ])
    expect(porcelain(cwd)).toEqual(['AA both.txt', 'UU base.txt'])
  })

  it('maps deleted by both to conflicted', async () => {
    const cwd = repo()
    write(cwd, 'gone.txt', renameSource); git(cwd, 'add', '-A'); git(cwd, 'commit', '-m', 'gone')
    git(cwd, 'checkout', '-b', 'other'); git(cwd, 'mv', 'gone.txt', 'other-name.txt'); git(cwd, 'commit', '-m', 'move')
    git(cwd, 'checkout', 'main'); git(cwd, 'mv', 'gone.txt', 'main-name.txt'); git(cwd, 'commit', '-m', 'move elsewhere')
    expect(() => git(cwd, 'merge', 'other')).toThrow()
    expect((await changes(cwd)).find((change) => change.path === 'gone.txt')).toEqual({ path: 'gone.txt', status: 'conflicted', staged: false })
  })

  it('reports a rebase in progress until it is aborted', async () => {
    const cwd = repo()
    git(cwd, 'checkout', '-b', 'topic'); write(cwd, 'base.txt', 'topic\n'); git(cwd, 'commit', '-am', 'topic')
    git(cwd, 'checkout', 'main'); write(cwd, 'base.txt', 'main\n'); git(cwd, 'commit', '-am', 'main')
    git(cwd, 'checkout', 'topic'); expect(() => git(cwd, 'rebase', 'main')).toThrow()
    expect((await new GitService().getStatus(cwd)).inProgress).toBe('rebase')
    await new GitService().abortInProgress(cwd, 'rebase')
    expect((await new GitService().getStatus(cwd)).inProgress).toBeNull()
  })

  it('hides every mousse/ branch from the branch list', async () => {
    const cwd = repo()
    for (const name of ['mousse/thread/abc/main', 'mousse/agent/x', 'mousse/workflow/y', 'mousse/agent-z', 'feature']) git(cwd, 'branch', name)
    expect((await new GitService().getBranches(cwd)).branches.sort()).toEqual(['feature', 'main'])
  })
})

describe('GitService stage, unstage and discard', () => {
  it('stages and unstages only the named paths, including a deletion and a rename', async () => {
    const cwd = repo(), service = new GitService()
    write(cwd, 'a.txt'); write(cwd, 'b.txt'); write(cwd, 'old.txt', renameSource); write(cwd, 'doomed.txt')
    git(cwd, 'add', '-A'); git(cwd, 'commit', '-m', 'more files')
    rmSync(join(cwd, 'doomed.txt')); write(cwd, 'a.txt', 'changed a\n'); write(cwd, 'b.txt', 'changed b\n')
    git(cwd, 'mv', 'old.txt', 'new.txt')
    await service.stage(cwd, ['a.txt', 'doomed.txt'])
    expect(porcelain(cwd)).toEqual(['D  doomed.txt', 'M  a.txt', 'R  old.txt -> new.txt', ' M b.txt'].sort())
    await service.unstage(cwd, ['a.txt', 'doomed.txt', 'new.txt'])
    expect(porcelain(cwd)).toEqual([' D doomed.txt', ' M a.txt', ' M b.txt', ' D old.txt', '?? new.txt'].sort())
  })

  it('treats glob characters in file names literally and handles spaces', async () => {
    const cwd = repo(), service = new GitService()
    // `*` cannot be part of a Windows file name; `[` and spaces can.
    const star = process.platform === 'win32' ? 'star[x].txt' : 'star*.txt'
    write(cwd, star); write(cwd, 'starX.txt'); write(cwd, 'br[a].txt'); write(cwd, 'bra.txt'); write(cwd, 'with space.txt')
    await service.stage(cwd, [star, 'br[a].txt', 'with space.txt'])
    expect(porcelain(cwd)).toEqual(['?? bra.txt', '?? starX.txt', 'A  br[a].txt', `A  ${star}`, 'A  "with space.txt"'].sort())
    await service.unstage(cwd, [star])
    expect(porcelain(cwd)).toContain(`?? ${star}`)
    expect(porcelain(cwd)).toContain('A  br[a].txt')
  })

  it('skips paths that no longer have a change instead of failing', async () => {
    const cwd = repo(), service = new GitService()
    write(cwd, 'a.txt')
    await service.stage(cwd, ['a.txt', 'vanished.txt'])
    await service.unstage(cwd, ['vanished.txt'])
    await service.discard(cwd, ['vanished.txt'])
    expect(porcelain(cwd)).toEqual(['A  a.txt'])
  })

  it('stages and unstages everything at once', async () => {
    const cwd = repo(), service = new GitService()
    write(cwd, 'a.txt'); write(cwd, 'dir/b.txt'); write(cwd, 'base.txt', 'changed\n')
    await service.stageAll(cwd)
    expect(porcelain(cwd)).toEqual(['A  a.txt', 'A  dir/b.txt', 'M  base.txt'])
    await service.unstageAll(cwd)
    expect(porcelain(cwd)).toEqual([' M base.txt', '?? a.txt', '?? dir/b.txt'])
  })

  it('stages, unstages and discards 1,500 tracked and 1,500 untracked paths in one call each', async () => {
    const cwd = repo(), service = new GitService()
    const tracked = Array.from({ length: 1500 }, (_, index) => `tracked/file-${String(index).padStart(4, '0')}-with-a-longish-name.txt`)
    const untracked = Array.from({ length: 1500 }, (_, index) => `loose/file-${String(index).padStart(4, '0')}-with-a-longish-name.txt`)
    for (const name of tracked) write(cwd, name)
    git(cwd, 'add', '-A'); git(cwd, 'commit', '-q', '-m', 'many')
    for (const name of tracked) write(cwd, name, 'edited\n')
    for (const name of untracked) write(cwd, name)
    await service.stage(cwd, [...tracked, ...untracked])
    expect(git(cwd, 'diff', '--cached', '--name-only').split('\n')).toHaveLength(3000)
    await service.unstage(cwd, [...tracked, ...untracked])
    expect(git(cwd, 'diff', '--cached', '--name-only')).toBe('')
    await service.discard(cwd, [...tracked, ...untracked])
    expect(porcelain(cwd)).toEqual([])
    expect(readFileSync(join(cwd, tracked[7]), 'utf8')).toBe(`${tracked[7]}\n`)
    expect(existsSync(join(cwd, 'loose'))).toBe(false)
  }, 120_000)

  it('stages the unstaged half of an MM file and keeps both edits in the index', async () => {
    const cwd = repo(), service = new GitService()
    write(cwd, 'base.txt', 'first\n'); git(cwd, 'add', 'base.txt'); write(cwd, 'base.txt', 'first\nsecond\n')
    expect(porcelain(cwd)).toEqual(['MM base.txt'])
    await service.stage(cwd, ['base.txt'])
    expect(porcelain(cwd)).toEqual(['M  base.txt'])
    expect(git(cwd, 'show', ':base.txt')).toBe('first\nsecond')
  })

  it('discards tracked edits, a staged add, a staged edit edited again, and untracked files and directories', async () => {
    const cwd = repo(), service = new GitService()
    write(cwd, 'keep.txt'); git(cwd, 'add', '-A'); git(cwd, 'commit', '-m', 'keep')
    write(cwd, 'base.txt', 'edited\n'); write(cwd, 'keep.txt', 'staged\n'); git(cwd, 'add', 'keep.txt'); write(cwd, 'keep.txt', 'staged and edited\n')
    write(cwd, 'added.txt'); git(cwd, 'add', 'added.txt'); write(cwd, 'added.txt', 'edited after add\n')
    write(cwd, 'loose.txt'); write(cwd, 'untracked-dir/deep/x.txt'); write(cwd, 'untouched.txt')
    await service.discard(cwd, ['base.txt', 'keep.txt', 'added.txt', 'loose.txt', 'untracked-dir'])
    expect(porcelain(cwd)).toEqual(['?? untouched.txt'])
    expect(readFileSync(join(cwd, 'base.txt'), 'utf8')).toBe('base\n')
    expect(readFileSync(join(cwd, 'keep.txt'), 'utf8')).toBe('keep.txt\n')
    expect(existsSync(join(cwd, 'untracked-dir'))).toBe(false)
  })

  it('discards a deleted file, a staged deletion and a renamed file back to HEAD', async () => {
    const cwd = repo(), service = new GitService()
    write(cwd, 'gone.txt'); write(cwd, 'staged-gone.txt'); write(cwd, 'old.txt', renameSource)
    git(cwd, 'add', '-A'); git(cwd, 'commit', '-m', 'files')
    rmSync(join(cwd, 'gone.txt')); git(cwd, 'rm', 'staged-gone.txt'); git(cwd, 'mv', 'old.txt', 'new.txt')
    await service.discard(cwd, ['gone.txt', 'staged-gone.txt', 'new.txt'])
    expect(porcelain(cwd)).toEqual([])
    expect(existsSync(join(cwd, 'old.txt'))).toBe(true)
    expect(existsSync(join(cwd, 'new.txt'))).toBe(false)
  })

  it('discards an intent-to-add file', async () => {
    const cwd = repo()
    write(cwd, 'ita.txt'); git(cwd, 'add', '-N', 'ita.txt')
    await new GitService().discard(cwd, ['ita.txt'])
    expect(porcelain(cwd)).toEqual([])
    expect(existsSync(join(cwd, 'ita.txt'))).toBe(false)
  })

  it('discards a conflicted file back to the current branch version', async () => {
    const cwd = repo()
    git(cwd, 'checkout', '-b', 'other'); write(cwd, 'base.txt', 'other\n'); git(cwd, 'commit', '-am', 'other')
    git(cwd, 'checkout', 'main'); write(cwd, 'base.txt', 'main\n'); git(cwd, 'commit', '-am', 'main')
    expect(() => git(cwd, 'merge', 'other')).toThrow()
    await new GitService().discard(cwd, ['base.txt'])
    expect(readFileSync(join(cwd, 'base.txt'), 'utf8')).toBe('main\n')
    expect(porcelain(cwd)).toEqual([])
  })

  it('works on an unborn branch', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'mousse-git-unborn-')); roots.push(cwd)
    git(cwd, 'init', '-b', 'main'); git(cwd, 'config', 'user.name', 'x'); git(cwd, 'config', 'user.email', 'x@example.invalid')
    const service = new GitService()
    write(cwd, 'a.txt'); write(cwd, 'b.txt')
    await service.stage(cwd, ['a.txt', 'b.txt'])
    expect(porcelain(cwd)).toEqual(['A  a.txt', 'A  b.txt'])
    await service.unstage(cwd, ['a.txt'])
    expect(porcelain(cwd)).toEqual(['?? a.txt', 'A  b.txt'])
    await service.stageAll(cwd); await service.unstageAll(cwd)
    expect(porcelain(cwd)).toEqual(['?? a.txt', '?? b.txt'])
    await service.stage(cwd, ['a.txt']); await service.discard(cwd, ['a.txt', 'b.txt'])
    expect(porcelain(cwd)).toEqual([])
  })

  it('never removes anything outside the folder', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mousse-git-outside-')); roots.push(root)
    const cwd = join(root, 'work'); mkdirSync(cwd); git(cwd, 'init', '-b', 'main')
    writeFileSync(join(root, 'precious.txt'), 'keep me\n'); write(cwd, 'inside.txt')
    await new GitService().discard(cwd, ['../precious.txt', 'inside.txt'])
    expect(existsSync(join(root, 'precious.txt'))).toBe(true)
    expect(existsSync(join(cwd, 'inside.txt'))).toBe(false)
  })
})

describe('GitService commit', () => {
  it('commits only the index when anything is staged', async () => {
    const cwd = repo()
    write(cwd, 'a.txt'); write(cwd, 'b.txt'); git(cwd, 'add', 'a.txt')
    await new GitService().commit(cwd, 'only a')
    expect(git(cwd, 'show', '--name-only', '--format=', 'HEAD')).toBe('a.txt')
    expect(porcelain(cwd)).toEqual(['?? b.txt'])
  })

  it('stages everything when the index is empty', async () => {
    const cwd = repo()
    write(cwd, 'a.txt'); write(cwd, 'base.txt', 'changed\n')
    await new GitService().commit(cwd, 'everything')
    expect(git(cwd, 'show', '--name-only', '--format=', 'HEAD').split('\n').sort()).toEqual(['a.txt', 'base.txt'])
  })

  it('with all, commits staged A and unstaged B in one commit that a pre-commit hook sees whole', async () => {
    const cwd = repo()
    withHook(cwd, "const { execFileSync } = require('node:child_process'); require('node:fs').writeFileSync('../hook-saw.log', execFileSync('git', ['diff', '--cached', '--name-only'], { encoding: 'utf8' }).trim().split('\\n').sort().join(','))")
    write(cwd, 'a.txt'); write(cwd, 'b.txt'); write(cwd, '.mousse/state.json'); git(cwd, 'add', 'a.txt')
    const before = Number(git(cwd, 'rev-list', '--count', 'HEAD'))
    await new GitService().commit(cwd, 'both', { all: true })
    expect(Number(git(cwd, 'rev-list', '--count', 'HEAD'))).toBe(before + 1)
    expect(git(cwd, 'show', '--name-only', '--format=', 'HEAD').split('\n').sort()).toEqual(['a.txt', 'b.txt'])
    const log = join(dirname(cwd), 'hook-saw.log'); roots.push(log)
    expect(readFileSync(log, 'utf8')).toBe('a.txt,b.txt')
    expect(porcelain(cwd)).toEqual(['?? .mousse/state.json'])
  })

  it('leaves HEAD, index and tree as they were when a hook rejects an empty-index commit', async () => {
    const cwd = repo(); withHook(cwd, rejectingHook)
    write(cwd, 'a.txt'); write(cwd, 'base.txt', 'changed\n')
    const head = git(cwd, 'rev-parse', 'HEAD'), state = porcelain(cwd)
    await expect(new GitService().commit(cwd, 'nope')).rejects.toMatchObject({ code: 'git_commit_failed', message: expect.stringContaining('hook says no') })
    expect(git(cwd, 'rev-parse', 'HEAD')).toBe(head)
    expect(porcelain(cwd)).toEqual(state)
    expect(git(cwd, 'diff', '--cached', '--name-only')).toBe('')
  })

  it('leaves a partially staged index as it was when a hook rejects an all commit', async () => {
    const cwd = repo(); withHook(cwd, rejectingHook)
    write(cwd, 'a.txt'); write(cwd, 'b.txt'); write(cwd, 'base.txt', 'changed\n'); git(cwd, 'add', 'a.txt')
    const head = git(cwd, 'rev-parse', 'HEAD'), state = porcelain(cwd)
    await expect(new GitService().commit(cwd, 'nope', { all: true })).rejects.toMatchObject({ code: 'git_commit_failed' })
    expect(git(cwd, 'rev-parse', 'HEAD')).toBe(head)
    expect(porcelain(cwd)).toEqual(state)
    expect(git(cwd, 'diff', '--cached', '--name-only')).toBe('a.txt')
  })

  it('commits again once the hook is fixed', async () => {
    const cwd = repo(); const dir = withHook(cwd, rejectingHook)
    write(cwd, 'a.txt')
    await expect(new GitService().commit(cwd, 'nope')).rejects.toThrow()
    rmSync(join(dir, 'pre-commit'))
    await new GitService().commit(cwd, 'now')
    expect(git(cwd, 'log', '-1', '--format=%s')).toBe('now')
  })

  it('refuses while a file is conflicted, then commits with two parents once it is staged', async () => {
    const cwd = repo()
    git(cwd, 'checkout', '-b', 'other'); write(cwd, 'base.txt', 'other\n'); git(cwd, 'commit', '-am', 'other')
    git(cwd, 'checkout', 'main'); write(cwd, 'base.txt', 'main\n'); git(cwd, 'commit', '-am', 'main')
    expect(() => git(cwd, 'merge', 'other')).toThrow()
    const service = new GitService()
    await expect(service.commit(cwd, 'merge')).rejects.toMatchObject({ code: 'git_merge_unresolved' })
    write(cwd, 'base.txt', 'resolved\n'); write(cwd, 'unrelated.txt')
    await service.stage(cwd, ['base.txt'])
    await service.commit(cwd, 'merge other')
    expect(git(cwd, 'rev-list', '--parents', '-n', '1', 'HEAD').split(' ')).toHaveLength(3)
    expect(porcelain(cwd)).toEqual(['?? unrelated.txt'])
    expect((await service.getStatus(cwd)).inProgress).toBeNull()
  })

  it('refuses when the branch is not the expected one', async () => {
    const cwd = repo(); git(cwd, 'checkout', '-b', 'moved'); write(cwd, 'a.txt')
    const head = git(cwd, 'rev-parse', 'HEAD')
    await expect(new GitService().commit(cwd, 'x', { expectedBranch: 'main' })).rejects.toMatchObject({ code: 'git_branch_changed' })
    expect(git(cwd, 'rev-parse', 'HEAD')).toBe(head)
    await new GitService().commit(cwd, 'x', { expectedBranch: 'moved' })
    expect(git(cwd, 'log', '-1', '--format=%s')).toBe('x')
  })

  it('amend with staged files amends only the index', async () => {
    const cwd = repo(); write(cwd, 'a.txt'); git(cwd, 'add', 'a.txt'); git(cwd, 'commit', '-m', 'first')
    write(cwd, 'b.txt'); write(cwd, 'c.txt'); git(cwd, 'add', 'b.txt')
    await new GitService().commit(cwd, 'first, again', { amend: true })
    expect(git(cwd, 'show', '--name-only', '--format=', 'HEAD').split('\n').sort()).toEqual(['a.txt', 'b.txt'])
    expect(porcelain(cwd)).toEqual(['?? c.txt'])
  })
})

describe('GitService checkout options', () => {
  /** `main` and `other` differ in base.txt, so a dirty base.txt cannot be carried to `other`. */
  function diverged() {
    const cwd = repo()
    git(cwd, 'checkout', '-b', 'other'); write(cwd, 'base.txt', 'other branch\n'); git(cwd, 'commit', '-am', 'other change'); git(cwd, 'checkout', 'main')
    return cwd
  }

  it('carries uncommitted changes that do not collide', async () => {
    const cwd = repo(); git(cwd, 'branch', 'feature'); write(cwd, 'new.txt'); write(cwd, 'base.txt', 'edited\n')
    await expect(new GitService().checkout(cwd, 'feature')).resolves.toEqual({})
    expect(git(cwd, 'symbolic-ref', '--short', 'HEAD')).toBe('feature')
    expect(porcelain(cwd)).toEqual([' M base.txt', '?? new.txt'])
  })

  it('classifies uncommitted changes that would be overwritten', async () => {
    const cwd = diverged(); write(cwd, 'base.txt', 'mine\n')
    await expect(new GitService().checkout(cwd, 'other')).rejects.toMatchObject({ code: 'git_checkout_dirty' })
    expect(git(cwd, 'symbolic-ref', '--short', 'HEAD')).toBe('main')
  })

  it('classifies an untracked file in the way', async () => {
    const cwd = repo()
    git(cwd, 'checkout', '-b', 'other'); write(cwd, 'clash.txt', 'tracked there\n'); git(cwd, 'add', '-A'); git(cwd, 'commit', '-m', 'clash'); git(cwd, 'checkout', 'main')
    write(cwd, 'clash.txt', 'mine\n')
    await expect(new GitService().checkout(cwd, 'other')).rejects.toMatchObject({ code: 'git_checkout_untracked_collision' })
    expect(readFileSync(join(cwd, 'clash.txt'), 'utf8')).toBe('mine\n')
  })

  it('stashes, switches and re-applies the changes, untracked files included', async () => {
    const cwd = repo(); git(cwd, 'branch', 'feature'); write(cwd, 'base.txt', 'mine\n'); write(cwd, 'scratch.txt')
    await expect(new GitService().checkout(cwd, 'feature', { dirty: 'stash' })).resolves.toEqual({})
    expect(git(cwd, 'symbolic-ref', '--short', 'HEAD')).toBe('feature')
    expect(git(cwd, 'stash', 'list')).toBe('')
    expect(porcelain(cwd)).toEqual([' M base.txt', '?? scratch.txt'])
  })

  it('keeps the stash when it conflicts after the switch', async () => {
    const cwd = diverged(); write(cwd, 'base.txt', 'mine\n')
    await expect(new GitService().checkout(cwd, 'other', { dirty: 'stash' })).resolves.toEqual({ stashKept: true })
    expect(git(cwd, 'symbolic-ref', '--short', 'HEAD')).toBe('other')
    expect(git(cwd, 'stash', 'list')).toContain('mousse: switch to other')
  })

  it('with nothing to stash switches and does not pop an older stash', async () => {
    const cwd = repo(); git(cwd, 'branch', 'feature')
    write(cwd, 'old.txt', 'old work\n'); git(cwd, 'stash', '-u')
    const stashes = git(cwd, 'stash', 'list')
    await expect(new GitService().checkout(cwd, 'feature', { dirty: 'stash' })).resolves.toEqual({})
    expect(git(cwd, 'symbolic-ref', '--short', 'HEAD')).toBe('feature')
    expect(git(cwd, 'stash', 'list')).toBe(stashes)
    expect(existsSync(join(cwd, 'old.txt'))).toBe(false)
  })

  it('puts the changes back when the switch itself fails', async () => {
    const cwd = repo(); write(cwd, 'mine.txt')
    await expect(new GitService().checkout(cwd, 'missing', { dirty: 'stash' })).rejects.toMatchObject({ code: 'git_checkout_failed' })
    expect(porcelain(cwd)).toEqual(['?? mine.txt'])
    expect(git(cwd, 'stash', 'list')).toBe('')
  })
})

describe('GitService branches', () => {
  it('creates a branch and switches to it, or only creates it, from the current branch or another one', async () => {
    const cwd = repo(), service = new GitService()
    git(cwd, 'branch', 'base-here'); write(cwd, 'later.txt'); git(cwd, 'add', '-A'); git(cwd, 'commit', '-m', 'later')
    await service.createBranch(cwd, 'feature/one')
    expect(git(cwd, 'symbolic-ref', '--short', 'HEAD')).toBe('feature/one')
    await service.createBranch(cwd, 'quiet', { checkout: false })
    expect(git(cwd, 'symbolic-ref', '--short', 'HEAD')).toBe('feature/one')
    await service.createBranch(cwd, 'from-old', { from: 'base-here' })
    expect(git(cwd, 'symbolic-ref', '--short', 'HEAD')).toBe('from-old')
    expect(existsSync(join(cwd, 'later.txt'))).toBe(false)
  })

  it('creating a branch carries uncommitted changes along', async () => {
    const cwd = repo(); write(cwd, 'wip.txt')
    await new GitService().createBranch(cwd, 'topic')
    expect(porcelain(cwd)).toEqual(['?? wip.txt'])
  })

  it('refuses an existing name, an invalid name, an unknown start point and mousse/ names', async () => {
    const cwd = repo(), service = new GitService()
    await expect(service.createBranch(cwd, 'main')).rejects.toMatchObject({ code: 'git_branch_exists' })
    await expect(service.createBranch(cwd, 'bad name')).rejects.toMatchObject({ code: 'git_branch_invalid' })
    await expect(service.createBranch(cwd, '--force')).rejects.toMatchObject({ code: 'git_branch_invalid' })
    await expect(service.createBranch(cwd, 'x', { from: 'nowhere' })).rejects.toMatchObject({ code: 'git_ref_not_found' })
    await expect(service.createBranch(cwd, 'mousse/thread/x/main')).rejects.toMatchObject({ code: 'git_branch_protected' })
    expect(git(cwd, 'branch', '--format=%(refname:short)')).toBe('main')
  })

  it('renames a branch and refuses to clash or touch mousse/ names', async () => {
    const cwd = repo(), service = new GitService()
    git(cwd, 'branch', 'old'); git(cwd, 'branch', 'taken'); git(cwd, 'branch', 'mousse/agent/x')
    await service.renameBranch(cwd, 'old', 'new')
    expect(git(cwd, 'branch', '--format=%(refname:short)').split('\n').sort()).toEqual(['main', 'mousse/agent/x', 'new', 'taken'])
    await expect(service.renameBranch(cwd, 'new', 'taken')).rejects.toMatchObject({ code: 'git_branch_exists' })
    await expect(service.renameBranch(cwd, 'new', 'mousse/renamed')).rejects.toMatchObject({ code: 'git_branch_protected' })
    await expect(service.renameBranch(cwd, 'mousse/agent/x', 'free')).rejects.toMatchObject({ code: 'git_branch_protected' })
    await expect(service.renameBranch(cwd, 'ghost', 'free')).rejects.toMatchObject({ code: 'git_ref_not_found' })
  })

  it('deletes a merged branch, asks before an unmerged one, then force-deletes it', async () => {
    const cwd = repo(), service = new GitService()
    git(cwd, 'branch', 'merged')
    git(cwd, 'checkout', '-b', 'unmerged'); write(cwd, 'u.txt'); git(cwd, 'add', '-A'); git(cwd, 'commit', '-m', 'unmerged work'); git(cwd, 'checkout', 'main')
    await service.deleteBranch(cwd, 'merged')
    await expect(service.deleteBranch(cwd, 'unmerged')).rejects.toMatchObject({ code: 'git_branch_unmerged', errorInfo: { category: 'conflict' } })
    await service.deleteBranch(cwd, 'unmerged', { force: true })
    expect(git(cwd, 'branch', '--format=%(refname:short)')).toBe('main')
  })

  it('refuses to delete the current branch, a mousse/ branch, or a branch another worktree has checked out', async () => {
    const cwd = repo(), service = new GitService()
    git(cwd, 'branch', 'mousse/agent/x'); git(cwd, 'branch', 'elsewhere')
    const other = join(dirname(cwd), `${basename(cwd)}-wt`); roots.push(other)
    git(cwd, 'worktree', 'add', other, 'elsewhere')
    await expect(service.deleteBranch(cwd, 'main')).rejects.toMatchObject({ code: 'git_branch_current' })
    await expect(service.deleteBranch(cwd, 'mousse/agent/x', { force: true })).rejects.toMatchObject({ code: 'git_branch_protected' })
    await expect(service.deleteBranch(cwd, 'elsewhere', { force: true })).rejects.toMatchObject({ code: 'git_branch_in_worktree' })
  })
})

describe('GitService in a project folder inside the repository', () => {
  /** Paths from status are relative to the repository, whatever folder the project is. A root README and pkg/README.md share a name on purpose. */
  function nested() {
    const top = repo(), cwd = join(top, 'pkg')
    write(top, 'pkg/README.md', 'pkg readme\n'); write(top, 'other/keep.txt'); git(top, 'add', '-A'); git(top, 'commit', '-m', 'pkg')
    return { top, cwd }
  }

  it('reports repository-relative paths, and stage and unstage act on them', async () => {
    const { top, cwd } = nested(), service = new GitService()
    write(top, 'pkg/README.md', 'edited\n'); write(top, 'other/keep.txt', 'edited\n'); write(top, 'README.md')
    expect((await changes(cwd)).map((change) => change.path).sort()).toEqual(['README.md', 'other/keep.txt', 'pkg/README.md'])
    await service.stage(cwd, ['pkg/README.md', 'other/keep.txt', 'README.md'])
    expect(porcelain(top)).toEqual(['A  README.md', 'M  other/keep.txt', 'M  pkg/README.md'])
    await service.unstage(cwd, ['pkg/README.md', 'other/keep.txt'])
    expect(porcelain(top)).toEqual([' M other/keep.txt', ' M pkg/README.md', 'A  README.md'])
    await service.unstageAll(cwd)
    expect(porcelain(top)).toEqual([' M other/keep.txt', ' M pkg/README.md', '?? README.md'])
    await service.stageAll(cwd)
    expect(porcelain(top)).toEqual(['A  README.md', 'M  other/keep.txt', 'M  pkg/README.md'])
  })

  it('discards the file the path names, not a same-named file under the project folder', async () => {
    const { top, cwd } = nested()
    write(top, 'pkg/README.md', 'precious edit\n'); write(top, 'README.md', 'untracked root file\n'); write(top, 'other/keep.txt', 'edited\n')
    await new GitService().discard(cwd, ['README.md', 'other/keep.txt'])
    expect(existsSync(join(top, 'README.md'))).toBe(false)
    expect(readFileSync(join(top, 'pkg/README.md'), 'utf8')).toBe('precious edit\n')
    expect(readFileSync(join(top, 'other/keep.txt'), 'utf8')).toBe('other/keep.txt\n')
    expect(porcelain(top)).toEqual([' M pkg/README.md'])
  })

  it('commits everything in the repository with all, not only the project folder', async () => {
    const { top, cwd } = nested()
    write(top, 'pkg/new.txt'); write(top, 'other/new.txt'); write(top, '.mousse/state.json'); git(top, 'add', 'pkg/new.txt')
    await new GitService().commit(cwd, 'everything', { all: true })
    expect(git(top, 'show', '--name-only', '--format=', 'HEAD').split('\n').sort()).toEqual(['other/new.txt', 'pkg/new.txt'])
    expect(porcelain(top)).toEqual(['?? .mousse/state.json'])
  })
})

describe('GitService discard of a nested repository', () => {
  it('leaves an untracked nested repository and its history alone, also through a parent folder', async () => {
    const cwd = repo()
    const inner = join(cwd, 'vendor/lib'); mkdirSync(inner, { recursive: true })
    git(inner, 'init', '-b', 'main'); git(inner, 'config', 'user.name', 'x'); git(inner, 'config', 'user.email', 'x@example.invalid'); git(inner, 'config', 'commit.gpgsign', 'false')
    write(inner, 'inner.txt'); git(inner, 'add', '-A'); git(inner, 'commit', '-m', 'inner history')
    write(cwd, 'vendor/loose.txt')
    await new GitService().discard(cwd, ['vendor'])
    expect(existsSync(join(cwd, 'vendor/loose.txt'))).toBe(false)
    expect(git(inner, 'log', '-1', '--format=%s')).toBe('inner history')
    await new GitService().discard(cwd, ['vendor/lib'])
    expect(existsSync(join(inner, '.git'))).toBe(true)
  })
})

describe('GitService unstage before the first commit', () => {
  it('unstages a file that was edited again after it was added, and keeps the file', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'mousse-git-unborn-')); roots.push(cwd)
    git(cwd, 'init', '-b', 'main')
    const service = new GitService()
    write(cwd, 'a.txt', 'first\n'); write(cwd, 'b.txt', 'first\n'); git(cwd, 'add', '-A'); write(cwd, 'a.txt', 'edited again\n'); write(cwd, 'b.txt', 'edited again\n')
    expect(porcelain(cwd)).toEqual(['AM a.txt', 'AM b.txt'])
    await service.unstage(cwd, ['a.txt'])
    expect(porcelain(cwd)).toEqual(['?? a.txt', 'AM b.txt'])
    await service.unstageAll(cwd)
    expect(porcelain(cwd)).toEqual(['?? a.txt', '?? b.txt'])
    expect(readFileSync(join(cwd, 'a.txt'), 'utf8')).toBe('edited again\n')
  })
})

describe('GitService commit that stalls or lands late', () => {
  it('keeps the commit and the index when only a slow post-commit hook is stopped', async () => {
    const cwd = repo()
    withHook(cwd, 'setTimeout(() => {}, 60000)', 'post-commit')
    write(cwd, 'a.txt'); write(cwd, 'base.txt', 'changed\n')
    const before = Number(git(cwd, 'rev-list', '--count', 'HEAD'))
    await new GitService({ commitSilenceMs: 4000 }).commit(cwd, 'lands')
    expect(Number(git(cwd, 'rev-list', '--count', 'HEAD'))).toBe(before + 1)
    expect(porcelain(cwd)).toEqual([])
  }, 60_000)

  it('stops a silent pre-commit hook and everything it started, then puts the index back', async () => {
    const cwd = repo(), pidFile = join(dirname(cwd), `${basename(cwd)}.pid`); roots.push(pidFile)
    withHook(cwd, `const { spawn } = require('node:child_process'); const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' }); require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(child.pid)); setTimeout(() => {}, 60000)`)
    write(cwd, 'a.txt'); write(cwd, 'b.txt'); git(cwd, 'add', 'a.txt')
    const head = git(cwd, 'rev-parse', 'HEAD'), state = porcelain(cwd)
    await expect(new GitService({ commitSilenceMs: 4000 }).commit(cwd, 'stuck', { all: true })).rejects.toMatchObject({ code: 'git_silence_timeout' })
    expect(git(cwd, 'rev-parse', 'HEAD')).toBe(head)
    expect(porcelain(cwd)).toEqual(state)
    expect(existsSync(join(cwd, '.git', 'index.lock'))).toBe(false)
    const pid = Number(readFileSync(pidFile, 'utf8'))
    expect(() => process.kill(pid, 0)).toThrow()
  }, 60_000)
})

describe('GitService stash and switch keeps the staged part', () => {
  it('a failed switch puts a staged-then-edited file back as it was', async () => {
    const cwd = repo()
    write(cwd, 'base.txt', 'staged\n'); git(cwd, 'add', 'base.txt'); write(cwd, 'base.txt', 'edited again\n')
    await expect(new GitService().checkout(cwd, 'missing', { dirty: 'stash' })).rejects.toMatchObject({ code: 'git_checkout_failed' })
    expect(porcelain(cwd)).toEqual(['MM base.txt'])
    expect(git(cwd, 'show', ':base.txt')).toBe('staged')
    expect(readFileSync(join(cwd, 'base.txt'), 'utf8')).toBe('edited again\n')
    expect(git(cwd, 'stash', 'list')).toBe('')
  })

  it('a successful switch brings the staged part along too', async () => {
    const cwd = repo(); git(cwd, 'branch', 'feature')
    write(cwd, 'base.txt', 'staged\n'); git(cwd, 'add', 'base.txt'); write(cwd, 'base.txt', 'edited again\n')
    await new GitService().checkout(cwd, 'feature', { dirty: 'stash' })
    expect(porcelain(cwd)).toEqual(['MM base.txt'])
  })
})

describe('GitService describeCommitInput', () => {
  const lines = (count: number, label: string) => Array.from({ length: count }, (_, index) => `${label} line ${index} with some padding text`).join('\n') + '\n'

  it('describes the staged changes only, and nothing outside the staged set', async () => {
    const cwd = repo()
    write(cwd, 'tracked.txt', 'tracked\n'); git(cwd, 'add', 'tracked.txt'); git(cwd, 'commit', '-m', 'add tracked')
    write(cwd, 'base.txt', 'staged edit\n'); git(cwd, 'add', 'base.txt')
    write(cwd, 'staged-new.txt', 'staged new file\n'); git(cwd, 'add', 'staged-new.txt')
    write(cwd, 'tracked.txt', 'UNSTAGED SECRET EDIT\n')
    write(cwd, 'untracked.txt', 'UNTRACKED SECRET\n')
    write(cwd, '.gitignore', 'ignored.log\n'); write(cwd, 'ignored.log', 'IGNORED SECRET\n')
    const input = await new GitService().describeCommitInput(cwd)
    expect(input.files.sort()).toEqual(['base.txt', 'staged-new.txt'])
    expect(input.untracked).toEqual([])
    expect(input.diff).toContain('+staged edit')
    expect(input.diff).toContain('+staged new file')
    expect(input.stat).toContain('base.txt')
    for (const text of [input.diff, input.stat]) expect(text).not.toMatch(/SECRET|tracked\.txt|ignored\.log|\.gitignore/)
    expect(input.truncated).toBe(false)
  })

  it('without anything staged describes the working tree, names untracked files without reading them, and skips ignored ones', async () => {
    const cwd = repo()
    write(cwd, 'base.txt', 'working edit\n')
    write(cwd, 'fresh.txt', 'FRESH CONTENT\n')
    write(cwd, '.gitignore', 'ignored.log\n'); write(cwd, 'ignored.log', 'IGNORED SECRET\n')
    const input = await new GitService().describeCommitInput(cwd)
    expect(input.diff).toContain('+working edit')
    expect(input.untracked.sort()).toEqual(['.gitignore', 'fresh.txt'])
    expect(input.files).toEqual(expect.arrayContaining(['base.txt', 'fresh.txt', '.gitignore']))
    expect(input.files).not.toContain('ignored.log')
    for (const text of [input.diff, input.stat]) expect(text).not.toMatch(/FRESH CONTENT|IGNORED/)
  })

  it('with `all` ignores the index, describes everything the commit takes, and leaves out .mousse', async () => {
    const cwd = repo()
    write(cwd, 'a.txt', 'staged a\n'); git(cwd, 'add', 'a.txt')
    write(cwd, 'base.txt', 'unstaged b\n')
    write(cwd, '.mousse/state.json', '{"internal":true}\n'); write(cwd, 'new.txt')
    const input = await new GitService().describeCommitInput(cwd, { all: true })
    expect(input.files.sort()).toEqual(['a.txt', 'base.txt', 'new.txt'])
    expect(input.diff).toContain('+staged a')
    expect(input.diff).toContain('+unstaged b')
    expect(`${input.diff}${input.stat}${input.files.join()}`).not.toContain('.mousse')
  })

  it('shows a binary file as "Binary files differ" and never its bytes', async () => {
    const cwd = repo()
    writeFileSync(join(cwd, 'logo.bin'), Buffer.concat([Buffer.from([0, 1, 2, 255]), Buffer.from('BINARY-PAYLOAD'.repeat(50))]))
    write(cwd, 'base.txt', 'edit\n'); git(cwd, 'add', '.')
    const input = await new GitService().describeCommitInput(cwd)
    expect(input.files.sort()).toEqual(['base.txt', 'logo.bin'])
    expect(input.diff).toMatch(/Binary files .*logo\.bin differ/)
    expect(input.diff).not.toContain('BINARY-PAYLOAD')
    expect(input.diff).toContain('+edit')
  })

  it('caps the patch at the byte limit at a line boundary and keeps every file in the summary', async () => {
    const cwd = repo()
    for (let index = 0; index < 12; index++) write(cwd, `file${String(index).padStart(2, '0')}.txt`, lines(70, `f${index}`))
    git(cwd, 'add', '.')
    const input = await new GitService().describeCommitInput(cwd)
    expect(Buffer.byteLength(input.diff)).toBeLessThanOrEqual(20_000)
    expect(input.truncated).toBe(true)
    expect(input.diff.startsWith('diff --git ')).toBe(true)
    expect(input.diff.split('\n').every((line) => line === '' || /^(diff --git |index |new file mode|--- |\+\+\+ |@@ |\+f\d+ line \d+ with some padding text$|\(cut\)$)/.test(line))).toBe(true)
    expect(input.files).toHaveLength(12)
    for (let index = 0; index < 12; index++) expect(input.stat).toContain(`file${String(index).padStart(2, '0')}.txt`)
    const small = await new GitService().describeCommitInput(cwd, { maxBytes: 3_000 })
    expect(Buffer.byteLength(small.diff)).toBeLessThanOrEqual(3_000)
  })

  it('leaves a file that changed a great many lines, or a very large patch, out of the patch but names it', async () => {
    const cwd = repo()
    write(cwd, 'generated.json', lines(1_500, 'gen')); write(cwd, 'wide.txt', `${'x'.repeat(30_000)}\n`)
    write(cwd, 'base.txt', 'small edit\n'); git(cwd, 'add', '.')
    const input = await new GitService().describeCommitInput(cwd)
    expect(input.files.sort()).toEqual(['base.txt', 'generated.json', 'wide.txt'])
    expect(input.stat).toContain('generated.json')
    expect(input.diff).toContain('+small edit')
    expect(input.diff).not.toContain('gen line')
    expect(input.diff).not.toContain('xxxxxxxxxx')
    expect(input.truncated).toBe(true)
  })

  it('caps the list of names', async () => {
    const cwd = repo()
    for (let index = 0; index < 250; index++) write(cwd, `many/f${index}.txt`, `${index}\n`)
    git(cwd, 'add', '.')
    const input = await new GitService().describeCommitInput(cwd)
    expect(input.files).toHaveLength(200)
    expect(input.truncated).toBe(true)
  })

  it('redacts credentials in what it reads', async () => {
    const cwd = repo()
    write(cwd, 'config.txt', 'remote = https://user:hunter2@example.com/repo.git\n'); git(cwd, 'add', 'config.txt')
    const input = await new GitService().describeCommitInput(cwd)
    expect(input.diff).not.toContain('hunter2')
  })

  it('works from a project folder inside the repository, before the first commit, and outside a repository', async () => {
    const cwd = repo()
    write(cwd, 'app/inner.txt', 'inner\n'); write(cwd, 'outer.txt', 'outer\n'); git(cwd, 'add', '.')
    const fromSubfolder = await new GitService().describeCommitInput(join(cwd, 'app'))
    expect(fromSubfolder.files.sort()).toEqual(['app/inner.txt', 'outer.txt'])
    expect(fromSubfolder.diff).toContain('+inner')

    const fresh = mkdtempSync(join(tmpdir(), 'mousse-git-writes-')); roots.push(fresh)
    git(fresh, 'init', '-b', 'main')
    write(fresh, 'first.txt', 'first\n'); git(fresh, 'add', 'first.txt'); write(fresh, 'later.txt')
    const unborn = await new GitService().describeCommitInput(fresh)
    expect(unborn.files).toEqual(['first.txt'])
    expect(unborn.diff).toContain('+first')

    const plain = mkdtempSync(join(tmpdir(), 'mousse-git-writes-')); roots.push(plain)
    expect((await new GitService().describeCommitInput(plain)).files).toEqual([])
  })
})

describe('GitService live output and cancel', () => {
  const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch { return false } }
  const waitDead = async (pid: number): Promise<boolean> => {
    for (const end = Date.now() + 5_000; Date.now() < end && alive(pid);) await new Promise((resolve) => setTimeout(resolve, 50))
    return !alive(pid)
  }
  const until = async (ready: () => boolean, ms = 15_000) => {
    for (const end = Date.now() + ms; !ready();) {
      if (Date.now() > end) throw new Error('timed out waiting')
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }
  /** Runs until the sentinel file exists; `before` runs first. */
  const blocksUntil = (sentinel: string, before = '') => `${before}\nconst t = setInterval(() => { if (require('node:fs').existsSync(${JSON.stringify(sentinel)})) { clearInterval(t); process.exit(0) } }, 25)`
  /** Starts a grandchild, records both pids and hangs. */
  const hangs = (pidFile: string) => `const { spawn } = require('node:child_process'); const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, process.pid + ',' + child.pid); console.error('hook started'); setInterval(() => {}, 1000)`
  const scratch = (cwd: string, name: string): string => { const file = join(dirname(cwd), `${basename(cwd)}.${name}`); roots.push(file); return file }
  const pidsOf = (file: string): number[] => readFileSync(file, 'utf8').split(',').map(Number)
  const collect = () => { const events: GitOperationEvent[] = []; return { events, onEvent: (event: GitOperationEvent) => events.push(event) } }
  const phases = (events: GitOperationEvent[]) => events.map((event) => event.phase)
  const outputText = (events: GitOperationEvent[]) => events.flatMap((event) => event.lines ?? []).join('\n')
  /** A bare remote the branch tracks, with a commit waiting to be pushed. */
  function withRemote(cwd: string, ahead = true): string {
    const origin = join(dirname(cwd), `${basename(cwd)}-origin.git`); roots.push(origin)
    git(dirname(cwd), 'init', '--bare', '-q', origin)
    git(cwd, 'remote', 'add', 'origin', origin); git(cwd, 'push', '-q', '-u', 'origin', 'main')
    if (ahead) { write(cwd, 'ahead.txt'); git(cwd, 'add', '.'); git(cwd, 'commit', '-qm', 'ahead') }
    return origin
  }
  /** A transport program that records its pids and never answers, as a stalled server would. */
  function stalledTransport(cwd: string, key: 'uploadpack' | 'receivepack', pidFile: string): void {
    const script = scratch(cwd, `${key}.cjs`)
    writeFileSync(script, hangs(pidFile))
    git(cwd, 'config', `remote.origin.${key}`, `node "${script.replace(/\\/g, '/')}"`)
  }

  it('a commit rejected by a hook says which hook and how it ended, then shows what it printed', async () => {
    const cwd = repo()
    withHook(cwd, "console.log('lint: 3 problems'); console.error('hook says no'); process.exit(1)")
    write(cwd, 'a.txt')
    const error = await new GitService().commit(cwd, 'rejected').then(() => null, (cause: unknown) => cause as Error & { code?: string })
    expect(error).toMatchObject({ code: 'git_commit_failed' })
    expect(error!.message).toMatch(/^pre-commit hook failed \(exit 1\):\n/)
    expect(error!.message).toContain('hook says no')
  })

  it('reports a hook as it starts and as it ends, while the commit is still running', async () => {
    const cwd = repo(), sentinel = scratch(cwd, 'go')
    // The hook runs Git itself, so the trace holds events of two processes with their own session and child ids.
    withHook(cwd, blocksUntil(sentinel, "require('node:child_process').execFileSync('git', ['status', '--porcelain']); console.error('linting')"))
    write(cwd, 'a.txt')
    const { events, onEvent } = collect()
    const commit = new GitService().commit(cwd, 'with a hook', { operationId: 'op-hook', onEvent })
    await until(() => events.some((event) => event.phase === 'hook'))
    expect(events.filter((event) => event.phase === 'hook')).toEqual([expect.objectContaining({ hook: { name: 'pre-commit' } })])
    expect(phases(events)).not.toContain('done')
    writeFileSync(sentinel, '')
    await commit
    const hooks = events.filter((event) => event.phase === 'hook').map((event) => event.hook)
    expect(hooks).toEqual([{ name: 'pre-commit' }, { name: 'pre-commit', exitCode: 0 }])
    expect(phases(events)[0]).toBe('started')
    expect(phases(events).at(-1)).toBe('done')
    expect(events.every((event) => event.operationId === 'op-hook' && event.kind === 'commit' && event.path === cwd)).toBe(true)
    expect(outputText(events)).toContain('linting')
    expect(git(cwd, 'log', '-1', '--format=%s')).toBe('with a hook')
  }, 30_000)

  it('a push to a bare remote reports started, its output, and done', async () => {
    const cwd = repo(); withRemote(cwd)
    const { events, onEvent } = collect()
    await new GitService().push(cwd, { operationId: 'op-push', onEvent })
    expect(phases(events)[0]).toBe('started')
    expect(events[0]).toMatchObject({ cancellable: true, kind: 'push' })
    expect(phases(events)).toContain('output')
    expect(phases(events).at(-1)).toBe('done')
    expect(outputText(events)).toMatch(/Writing objects|Total|Enumerating/)
  })

  it('a failed action ends with failed, its code and the redacted message', async () => {
    const cwd = repo()
    const { events, onEvent } = collect()
    await expect(new GitService().push(cwd, { operationId: 'op-fail', onEvent })).rejects.toMatchObject({ code: 'git_no_remote' })
    expect(events.at(-1)).toMatchObject({ phase: 'failed', code: 'git_no_remote', message: expect.any(String) })
  })

  it('redacts credentials in live output and in the failure message', async () => {
    const cwd = repo()
    withHook(cwd, "console.error('fatal: unable to access https://user:s3cret-token@example.com/repo.git/'); process.exit(1)")
    write(cwd, 'a.txt')
    const { events, onEvent } = collect()
    await expect(new GitService().commit(cwd, 'leaky', { operationId: 'op-redact', onEvent })).rejects.toThrow()
    const everything = JSON.stringify(events)
    expect(everything).not.toContain('s3cret-token')
    expect(outputText(events)).toContain('https://[redacted]@example.com')
  })

  it('bounds live output: short lines, small batches, a total cap and a notice at the cap', async () => {
    const cwd = repo()
    withHook(cwd, "for (let i = 0; i < 20000; i++) console.error('line ' + i + ' ' + 'x'.repeat(2000))")
    write(cwd, 'a.txt')
    const normal = collect()
    await new GitService().commit(cwd, 'noisy', { operationId: 'op-noisy', onEvent: normal.onEvent })
    const sent = normal.events.flatMap((event) => event.lines ?? [])
    expect(sent.length).toBeGreaterThan(0)
    expect(sent.length).toBeLessThanOrEqual(5001)
    expect(Math.max(...sent.map((line) => line.length))).toBeLessThanOrEqual(501)
    // At most 40 lines, and a note when some were dropped; a batch stays far below the 64 KiB a connection event may carry.
    expect(Math.max(...normal.events.map((event) => event.lines?.length ?? 0))).toBeLessThanOrEqual(41)
    expect(Math.max(...normal.events.map((event) => Buffer.byteLength(JSON.stringify(event))))).toBeLessThan(48 * 1024)
    expect(phases(normal.events).at(-1)).toBe('done')

    write(cwd, 'b.txt')
    const capped = collect()
    await new GitService({ liveOutput: { intervalMs: 5, maxLines: 30 } }).commit(cwd, 'noisy again', { operationId: 'op-capped', onEvent: capped.onEvent })
    const lines = capped.events.flatMap((event) => event.lines ?? []).filter((line) => !/^… \d+ lines? not shown$/.test(line))
    expect(lines.length).toBeLessThanOrEqual(31)
    expect(lines.at(-1)).toBe('The rest of the output is not shown.')
  }, 60_000)

  it('never lets a throwing listener or a missing one stop the command', async () => {
    const cwd = repo(); write(cwd, 'a.txt')
    await new GitService().commit(cwd, 'listener throws', { operationId: 'op-throws', onEvent: () => { throw new Error('boom') } })
    expect(git(cwd, 'log', '-1', '--format=%s')).toBe('listener throws')
  })

  it('refuses an operation id that is already running', async () => {
    const cwd = repo(), sentinel = scratch(cwd, 'go')
    withHook(cwd, blocksUntil(sentinel))
    write(cwd, 'a.txt')
    const service = new GitService()
    const { events, onEvent } = collect()
    const first = service.commit(cwd, 'first', { operationId: 'same', onEvent })
    await until(() => events.some((event) => event.phase === 'hook'))
    await expect(service.push(cwd, { operationId: 'same' })).rejects.toMatchObject({ code: 'git_operation_exists' })
    writeFileSync(sentinel, '')
    await first
  }, 30_000)

  it.each([['an empty index', false], ['a partly staged index', true]])('cancelling a commit during its hook leaves %s, HEAD and the tree as they were', async (_name, prestaged) => {
    const cwd = repo(), pidFile = scratch(cwd, 'pids')
    withHook(cwd, hangs(pidFile))
    write(cwd, 'a.txt'); write(cwd, 'b.txt'); if (prestaged) git(cwd, 'add', 'a.txt')
    const head = git(cwd, 'rev-parse', 'HEAD'), state = porcelain(cwd)
    const service = new GitService()
    const { events, onEvent } = collect()
    const commit = service.commit(cwd, 'never lands', { operationId: 'op-cancel', owner: 'window-1', onEvent })
    const settled = commit.then(() => null, (error: unknown) => error as { code?: string })
    await until(() => outputText(events).includes('hook started'))
    expect(service.cancelOperation('nobody', 'window-1')).toBe(false)
    // Only the client that started it may cancel it.
    expect(service.cancelOperation('op-cancel', 'window-2')).toBe(false)
    expect(service.cancelOperation('op-cancel', 'window-1')).toBe(true)
    expect(await settled).toMatchObject({ code: 'git_cancelled' })
    expect(phases(events).at(-1)).toBe('cancelled')
    expect(git(cwd, 'rev-parse', 'HEAD')).toBe(head)
    expect(porcelain(cwd)).toEqual(state)
    expect(existsSync(join(cwd, '.git', 'index.lock'))).toBe(false)
    for (const pid of pidsOf(pidFile)) expect(await waitDead(pid)).toBe(true)
    // Nothing is left half done: the same commit works once the hook is gone.
    withHook(cwd, 'process.exit(0)')
    await service.commit(cwd, 'now it lands')
    expect(git(cwd, 'log', '-1', '--format=%s')).toBe('now it lands')
    expect(service.cancelOperation('op-cancel', 'window-1')).toBe(false)
  }, 60_000)

  it('cancelling a fetch whose server never answers ends the whole process tree and leaves the repository usable', async () => {
    const cwd = repo(); withRemote(cwd, false)
    const pidFile = scratch(cwd, 'pids'); stalledTransport(cwd, 'uploadpack', pidFile)
    const service = new GitService()
    const { events, onEvent } = collect()
    const fetching = service.fetch(cwd, { operationId: 'op-fetch', onEvent }).then(() => null, (error: unknown) => error as { code?: string })
    await until(() => existsSync(pidFile) && outputText(events).includes('hook started'))
    expect(service.cancelOperation('op-fetch')).toBe(true)
    expect(await fetching).toMatchObject({ code: 'git_cancelled' })
    expect(phases(events).at(-1)).toBe('cancelled')
    for (const pid of pidsOf(pidFile)) expect(await waitDead(pid)).toBe(true)
    expect((await service.getStatus(cwd)).changes).toEqual([])
    git(cwd, 'config', '--unset', 'remote.origin.uploadpack')
    await expect(service.fetch(cwd)).resolves.toMatchObject({ behindAfter: 0 })
  }, 60_000)

  it('cancelling a push whose server never answers leaves the remote and the branch as they were', async () => {
    const cwd = repo(), origin = withRemote(cwd)
    const remoteHead = git(origin, 'rev-parse', 'main'), localHead = git(cwd, 'rev-parse', 'HEAD')
    const pidFile = scratch(cwd, 'pids'); stalledTransport(cwd, 'receivepack', pidFile)
    const service = new GitService()
    const { events, onEvent } = collect()
    const pushing = service.push(cwd, { operationId: 'op-push-cancel', onEvent }).then(() => null, (error: unknown) => error as { code?: string })
    await until(() => existsSync(pidFile) && outputText(events).includes('hook started'))
    expect(service.cancelOperation('op-push-cancel')).toBe(true)
    expect(await pushing).toMatchObject({ code: 'git_cancelled' })
    expect(phases(events).at(-1)).toBe('cancelled')
    for (const pid of pidsOf(pidFile)) expect(await waitDead(pid)).toBe(true)
    expect(git(origin, 'rev-parse', 'main')).toBe(remoteHead)
    expect(git(cwd, 'rev-parse', 'HEAD')).toBe(localHead)
    // The repository lease is free again: another action runs at once.
    git(cwd, 'config', '--unset', 'remote.origin.receivepack')
    await service.push(cwd)
    expect(git(origin, 'rev-parse', 'main')).toBe(localHead)
  }, 60_000)

  it('cancels a pre-push hook with the process tree it started', async () => {
    const cwd = repo(), origin = withRemote(cwd), pidFile = scratch(cwd, 'pids')
    const remoteHead = git(origin, 'rev-parse', 'main')
    withHook(cwd, hangs(pidFile), 'pre-push')
    const service = new GitService()
    const { events, onEvent } = collect()
    const pushing = service.push(cwd, { operationId: 'op-pre-push', onEvent }).then(() => null, (error: unknown) => error as { code?: string })
    await until(() => events.some((event) => event.phase === 'hook' && event.hook?.name === 'pre-push'))
    service.cancelOperation('op-pre-push')
    expect(await pushing).toMatchObject({ code: 'git_cancelled' })
    for (const pid of pidsOf(pidFile)) expect(await waitDead(pid)).toBe(true)
    expect(git(origin, 'rev-parse', 'main')).toBe(remoteHead)
  }, 60_000)

  it('cancelling an action that still waits for its turn stops it before Git runs', async () => {
    const cwd = repo(), origin = withRemote(cwd), sentinel = scratch(cwd, 'go')
    const remoteHead = git(origin, 'rev-parse', 'main')
    const service = new GitService()
    // The first action holds the folder while its hook waits.
    withHook(cwd, blocksUntil(sentinel))
    write(cwd, 'b.txt')
    const first = collect()
    const committing = service.commit(cwd, 'first', { operationId: 'first', onEvent: first.onEvent })
    await until(() => first.events.some((event) => event.phase === 'hook'))
    const queued = collect()
    const pushing = service.push(cwd, { operationId: 'queued', onEvent: queued.onEvent }).then(() => null, (error: unknown) => error as { code?: string })
    await until(() => phases(queued.events).includes('started'))
    expect(service.cancelOperation('queued')).toBe(true)
    // It answers at once, while the action ahead of it still runs.
    expect(await pushing).toMatchObject({ code: 'git_cancelled' })
    expect(phases(queued.events)).toEqual(['started', 'cancelled'])
    expect(phases(first.events)).not.toContain('done')
    writeFileSync(sentinel, '')
    await committing
    expect(git(origin, 'rev-parse', 'main')).toBe(remoteHead)
  }, 60_000)

  it('follows a branch switch but never offers to cancel it', async () => {
    const cwd = repo(), sentinel = scratch(cwd, 'go'); git(cwd, 'branch', 'feature')
    withHook(cwd, blocksUntil(sentinel), 'post-checkout')
    const service = new GitService()
    const { events, onEvent } = collect()
    const switching = service.checkout(cwd, 'feature', { operationId: 'op-switch', onEvent })
    await until(() => phases(events).includes('started'))
    expect(events[0]).toMatchObject({ kind: 'checkout', cancellable: false })
    expect(service.cancelOperation('op-switch')).toBe(false)
    writeFileSync(sentinel, '')
    await switching
    expect(git(cwd, 'symbolic-ref', '--short', 'HEAD')).toBe('feature')
    expect(phases(events).at(-1)).toBe('done')
  }, 30_000)

  /** The remote has one commit the branch lacks, and the branch has one the remote lacks. */
  function diverge(cwd: string): void {
    const origin = withRemote(cwd, false)
    const other = join(dirname(cwd), `${basename(cwd)}-other`); roots.push(other)
    git(dirname(cwd), 'clone', '-q', '-b', 'main', origin, other)
    git(other, 'config', 'user.name', 'Other'); git(other, 'config', 'user.email', 'other@example.invalid'); git(other, 'config', 'commit.gpgsign', 'false')
    write(other, 'remote.txt'); git(other, 'add', '.'); git(other, 'commit', '-qm', 'remote change'); git(other, 'push', '-q')
    write(cwd, 'local.txt'); git(cwd, 'add', '.'); git(cwd, 'commit', '-qm', 'local change')
  }

  it('cancels a pull while it downloads, and leaves the folder as it was', async () => {
    const cwd = repo(); withRemote(cwd, false)
    const pidFile = scratch(cwd, 'pids'); stalledTransport(cwd, 'uploadpack', pidFile)
    const head = git(cwd, 'rev-parse', 'HEAD'), service = new GitService()
    const { events, onEvent } = collect()
    const pulling = service.pull(cwd, { operationId: 'op-pull', onEvent }).then(() => null, (error: unknown) => error as { code?: string })
    await until(() => existsSync(pidFile) && outputText(events).includes('hook started'))
    expect(events[0]).toMatchObject({ phase: 'started', kind: 'pull', cancellable: true })
    expect(service.cancelOperation('op-pull')).toBe(true)
    expect(await pulling).toMatchObject({ code: 'git_cancelled' })
    expect(phases(events)).not.toContain('integrating')
    for (const pid of pidsOf(pidFile)) expect(await waitDead(pid)).toBe(true)
    expect(git(cwd, 'rev-parse', 'HEAD')).toBe(head)
    expect(porcelain(cwd)).toEqual([])
    expect((await service.getStatus(cwd)).inProgress).toBeNull()
  }, 60_000)

  it('does not offer Cancel once a pull starts to merge, not even when its client goes away, and finishes the merge', async () => {
    const cwd = repo(), sentinel = scratch(cwd, 'go')
    diverge(cwd)
    withHook(cwd, blocksUntil(sentinel), 'pre-merge-commit')
    const service = new GitService()
    const { events, onEvent } = collect()
    const connection = new AbortController()
    const pulling = service.pull(cwd, { strategy: 'merge', operationId: 'op-merge', owner: 'window-1', onEvent, lifetime: connection.signal })
    await until(() => phases(events).includes('integrating'))
    expect(events.find((event) => event.phase === 'integrating')).toMatchObject({ cancellable: false })
    // The merge is running (its hook waits): Cancel is refused, and so is the owner going away. Nothing is killed.
    expect(service.cancelOperation('op-merge', 'window-1')).toBe(false)
    connection.abort()
    await new Promise((resolve) => setTimeout(resolve, 500))
    writeFileSync(sentinel, '')
    await expect(pulling).resolves.toEqual({ result: 'merged' })
    expect(phases(events).at(-1)).toBe('done')
    expect(git(cwd, 'rev-list', '--parents', '-n', '1', 'HEAD').split(' ')).toHaveLength(3)
    expect(porcelain(cwd)).toEqual([])
  }, 60_000)

  it('a pull with conflicts keeps a merge that can be aborted', async () => {
    const cwd = repo(); withRemote(cwd, false)
    const other = join(dirname(cwd), `${basename(cwd)}-other`); roots.push(other)
    git(dirname(cwd), 'clone', '-q', '-b', 'main', join(dirname(cwd), `${basename(cwd)}-origin.git`), other)
    git(other, 'config', 'user.name', 'Other'); git(other, 'config', 'user.email', 'other@example.invalid'); git(other, 'config', 'commit.gpgsign', 'false')
    write(other, 'base.txt', 'remote edit\n'); git(other, 'commit', '-qam', 'remote edit'); git(other, 'push', '-q')
    write(cwd, 'base.txt', 'local edit\n'); git(cwd, 'commit', '-qam', 'local edit')
    const service = new GitService()
    await expect(service.pull(cwd, { strategy: 'merge' })).resolves.toEqual({ result: 'conflicted' })
    expect((await service.getStatus(cwd)).inProgress).toBe('merge')
    await service.abortInProgress(cwd, 'merge')
    expect((await service.getStatus(cwd)).inProgress).toBeNull()
  }, 60_000)

  it('cancelling an action whose starting client is gone stops it while it still can be stopped', async () => {
    const cwd = repo(); withRemote(cwd, false)
    const pidFile = scratch(cwd, 'pids'); stalledTransport(cwd, 'uploadpack', pidFile)
    const service = new GitService()
    const { events, onEvent } = collect()
    const connection = new AbortController()
    const fetching = service.fetch(cwd, { operationId: 'op-gone', owner: 'window-1', onEvent, lifetime: connection.signal }).then(() => null, (error: unknown) => error as { code?: string })
    await until(() => existsSync(pidFile) && outputText(events).includes('hook started'))
    connection.abort()
    expect(await fetching).toMatchObject({ code: 'git_cancelled' })
    for (const pid of pidsOf(pidFile)) expect(await waitDead(pid)).toBe(true)
    // Nothing stays registered: the id is free again and the folder's queue is clear.
    expect(service.cancelOperation('op-gone', 'window-1')).toBe(false)
    git(cwd, 'config', '--unset', 'remote.origin.uploadpack')
    await expect(service.fetch(cwd, { operationId: 'op-gone' })).resolves.toMatchObject({ behindAfter: 0 })
  }, 60_000)

  it.each([
    ['a lock left by a Git the hook started and that was stopped', 'hook'],
    ['a lock another program took while the hook ran', 'outside']
  ] as const)('never deletes index.lock after a cancelled commit: %s', async (_name, who) => {
    const cwd = repo(), pidFile = scratch(cwd, 'pids'), lock = join(cwd, '.git', 'index.lock')
    // The hook hangs; for the first case it also leaves a lock behind, as a killed `git add` does.
    withHook(cwd, `${who === 'hook' ? `require('node:fs').writeFileSync(${JSON.stringify(lock)}, 'from the hook');` : ''}${hangs(pidFile)}`)
    write(cwd, 'a.txt'); write(cwd, 'b.txt'); git(cwd, 'add', 'a.txt')
    const head = git(cwd, 'rev-parse', 'HEAD')
    const service = new GitService()
    const { events, onEvent } = collect()
    const committing = service.commit(cwd, 'never lands', { all: true, operationId: 'op-lock', onEvent }).then(() => null, (error: unknown) => error as { code?: string; details?: unknown })
    await until(() => events.some((event) => event.phase === 'hook'))
    if (who === 'outside') writeFileSync(lock, 'from another program', { flag: 'wx' })
    service.cancelOperation('op-lock')
    const error = await committing
    expect(error).toMatchObject({ code: 'git_index_locked', details: { path: expect.stringContaining('index.lock') } })
    expect(phases(events).at(-1)).toBe('failed')
    expect(readFileSync(lock, 'utf8')).toBe(who === 'hook' ? 'from the hook' : 'from another program')
    expect(git(cwd, 'rev-parse', 'HEAD')).toBe(head)
    for (const pid of pidsOf(pidFile)) expect(await waitDead(pid)).toBe(true)
  }, 60_000)

  it('does not publish the rest of a very long line, so a credential across the cut stays hidden', async () => {
    const cwd = repo()
    withHook(cwd, "process.stderr.write('x'.repeat(4083) + 'https://user:B'); setTimeout(() => process.stderr.write('OUNDARY_SECRET@example.invalid/repo\\n'), 300)")
    write(cwd, 'a.txt')
    const { events, onEvent } = collect()
    await new GitService().commit(cwd, 'long line', { operationId: 'op-long', onEvent })
    const everything = JSON.stringify(events)
    expect(everything).not.toContain('OUNDARY_SECRET')
    expect(everything).not.toContain('BOUNDARY')
  }, 30_000)
})
