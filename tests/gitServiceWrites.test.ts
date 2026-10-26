import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { GitService } from '../src/mms/git/GitService'

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
function withHook(cwd: string, script: string): string {
  const dir = join(dirname(cwd), `${basename(cwd)}-hooks`); roots.push(dir); mkdirSync(dir, { recursive: true })
  const body = join(dir, 'pre-commit.cjs'); writeFileSync(body, script)
  writeFileSync(join(dir, 'pre-commit'), `#!/bin/sh\nexec node "${body.replace(/\\/g, '/')}"\n`, { mode: 0o755 })
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
