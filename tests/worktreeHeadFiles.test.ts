/**
 * A thread's worktree is checked from Git's files (`readWorktreeHead`), so its turn starts with no Git process. Each row
 * builds a real repository layout and compares the answer with Git's own (`rev-parse HEAD`, `symbolic-ref -q HEAD`);
 * a layout only Git can read answers undefined, so the caller asks Git.
 *
 * Rows: main checkout, linked worktree, a branch only in `packed-refs`, a loose ref newer than its packed line,
 * detached HEAD, a branch with no commit yet, the reftable format, a `.git` file pointing nowhere; and, for a linked
 * worktree only, the main checkout, a copied `.git` file, and a new repository made in an emptied worktree. Configuration
 * that can move the checkout (`core.worktree` in `config.worktree` or the shared `config`, an `include`) is left to Git;
 * a worktree removed and added again at the same path is another checkout (`readLinkedCheckout`'s identity).
 */
import { execFileSync } from 'node:child_process'
import { appendFileSync, chmodSync, cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readLinkedCheckout, readWorktreeHead } from '../src/mms/git/worktreeHeadFiles'
import { hasLocalWorktreeCommits } from '../src/mms/git/worktreeObjectFiles'
import { recordCheckoutIdentity, sameCheckout } from '../src/mms/workspace/checkoutIdentity'

const roots: string[] = []
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }) })

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const tryGit = (cwd: string, ...args: string[]): string | undefined => { try { return git(cwd, ...args) || undefined } catch { return undefined } }

function repository(...initArgs: string[]): string {
  const base = mkdtempSync(join(tmpdir(), 'mousse-head-files-')); roots.push(base)
  const repo = join(base, 'repo'); mkdirSync(repo)
  git(repo, 'init', '-q', ...initArgs); git(repo, 'config', 'user.name', 'T'); git(repo, 'config', 'user.email', 't@example.test')
  writeFileSync(join(repo, 'a.txt'), 'a\n'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'one')
  return repo
}

/** What Git says of HEAD in `top`. */
const gitHead = (top: string) => {
  const head = tryGit(top, 'rev-parse', '--verify', '-q', 'HEAD^{commit}')
  const headRef = tryGit(top, 'symbolic-ref', '-q', 'HEAD')
  return { ...(head ? { head } : {}), ...(headRef ? { headRef } : {}) }
}

const gitVersion = (): [number, number] => { const [, major, minor] = git(tmpdir(), 'version').match(/(\d+)\.(\d+)/)!; return [Number(major), Number(minor)] }

describe('HEAD read from Git\'s files', () => {
  const rows: Array<[string, () => string]> = [
    ['the main checkout', () => repository()],
    ['a linked worktree on its own branch', () => {
      const repo = repository()
      const worktree = join(repo, '..', 'wt'); git(repo, 'worktree', 'add', '-q', '-b', 'thread/one', worktree)
      writeFileSync(join(worktree, 'b.txt'), 'b\n'); git(worktree, 'add', '.'); git(worktree, 'commit', '-qm', 'two')
      return worktree
    }],
    ['a worktree whose branch is only in packed-refs', () => {
      const repo = repository()
      const worktree = join(repo, '..', 'wt'); git(repo, 'worktree', 'add', '-q', '-b', 'thread/packed', worktree)
      git(repo, 'pack-refs', '--all')
      return worktree
    }],
    ['a loose ref newer than its packed line', () => {
      const repo = repository()
      git(repo, 'pack-refs', '--all')
      writeFileSync(join(repo, 'c.txt'), 'c\n'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'three')
      return repo
    }],
    ['a detached worktree', () => {
      const repo = repository()
      const worktree = join(repo, '..', 'wt'); git(repo, 'worktree', 'add', '-q', '--detach', worktree)
      return worktree
    }],
    ['a branch with no commit yet', () => {
      const repo = repository()
      git(repo, 'switch', '-q', '--orphan', 'empty')
      return repo
    }]
  ]
  it.each(rows)('%s: the same as Git', (_name, make) => {
    const top = make()
    return expect(readWorktreeHead(top)).resolves.toEqual(gitHead(top))
  })

  it('reads a relative gitdir and defers a symbolic ref chain to Git', async () => {
    const repo = repository()
    const worktree = join(repo, '..', 'wt')
    git(repo, 'worktree', 'add', '-q', '-b', 'thread/relative', worktree)
    const gitDir = git(worktree, 'rev-parse', '--absolute-git-dir')
    const pointer = join(worktree, '.git')
    rmSync(pointer)
    writeFileSync(pointer, 'gitdir: ' + relative(worktree, gitDir).replace(/\\/g, '/') + '\n')
    writeFileSync(join(gitDir, 'gitdir'), relative(gitDir, pointer).replace(/\\/g, '/') + '\n')
    expect((await readLinkedCheckout(worktree))?.head).toEqual(gitHead(worktree))
    git(repo, 'symbolic-ref', 'refs/heads/thread/alias', 'refs/heads/thread/relative')
    git(worktree, 'symbolic-ref', 'HEAD', 'refs/heads/thread/alias')
    expect(gitHead(worktree).head).toBeDefined()
    expect(await readLinkedCheckout(worktree)).toBeUndefined()
  })

  it('asks Git when a merge is in progress at the same HEAD and branch', async () => {
    const repo = repository()
    const worktree = join(repo, '..', 'wt')
    git(repo, 'worktree', 'add', '-q', '-b', 'thread/merge', worktree)
    const before = await readLinkedCheckout(worktree)
    writeFileSync(join(repo, 'a.txt'), 'changed\n')
    git(repo, 'commit', '-qam', 'change to merge')
    git(worktree, 'merge', '--no-commit', '--no-ff', git(repo, 'rev-parse', 'HEAD'))
    expect(gitHead(worktree)).toEqual(before?.head)
    expect(await readLinkedCheckout(worktree)).toBeUndefined()
  })

  it('leaves a reftable repository to Git', async () => {
    const [major, minor] = gitVersion()
    if (major < 2 || (major === 2 && minor < 45)) return
    const repo = repository('--ref-format=reftable')
    expect(gitHead(repo).head).toBeDefined()
    expect(await readWorktreeHead(repo)).toBeUndefined()
  })

  it('reads a linked worktree only while its Git folder links back to it', async () => {
    const repo = repository()
    const worktree = join(repo, '..', 'wt'); git(repo, 'worktree', 'add', '-q', '-b', 'thread/linked', worktree)
    expect(await readWorktreeHead(worktree, { linkedOnly: true })).toEqual(gitHead(worktree))
    // The main checkout is no linked worktree.
    expect(await readWorktreeHead(repo, { linkedOnly: true })).toBeUndefined()
    // A copy of the worktree's `.git` file elsewhere names a Git folder that links back to the worktree, not to it.
    const copy = join(repo, '..', 'copy'); mkdirSync(copy)
    writeFileSync(join(copy, '.git'), readFileSync(join(worktree, '.git')))
    expect(await readWorktreeHead(copy, { linkedOnly: true })).toBeUndefined()
  })

  it('leaves an emptied worktree that someone made a new repository in to Git', async () => {
    const repo = repository()
    const worktree = join(repo, '..', 'wt'); git(repo, 'worktree', 'add', '-q', '-b', 'thread/reinit', worktree)
    rmSync(join(worktree, '.git'), { force: true }); rmSync(join(worktree, 'a.txt'), { force: true })
    git(worktree, 'init', '-q')
    expect(await readWorktreeHead(worktree, { linkedOnly: true })).toBeUndefined()
  })

  it('leaves a worktree whose Git folder is gone to Git', async () => {
    const repo = repository()
    const worktree = join(repo, '..', 'wt'); git(repo, 'worktree', 'add', '-q', '-b', 'thread/gone', worktree)
    rmSync(join(repo, '.git', 'worktrees'), { recursive: true, force: true })
    expect(await readWorktreeHead(worktree)).toBeUndefined()
  })

  it('leaves a worktree with a re-pointed commondir to Git even when its refs match', async () => {
    const repo = repository()
    const worktree = join(repo, '..', 'wt'); git(repo, 'worktree', 'add', '-q', '-b', 'thread/redirected', worktree)
    const pin = 'refs/mousse/retained'
    const head = git(worktree, 'rev-parse', 'HEAD')
    git(worktree, 'update-ref', pin, head)
    expect((await readLinkedCheckout(worktree, [pin]))?.refs.get(pin)).toBe(head)
    const other = repository()
    // Only the original repository has this worktree's commit, even if the two fixture commits match.
    writeFileSync(join(worktree, 'a.txt'), 'only here\n')
    git(worktree, 'commit', '-qam', 'only here')
    const newHead = git(worktree, 'rev-parse', 'HEAD')
    git(worktree, 'update-ref', pin, newHead)
    for (const ref of ['refs/heads/thread/redirected', pin]) {
      const file = join(other, '.git', ref)
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, newHead + '\n')
    }
    const admin = git(worktree, 'rev-parse', '--absolute-git-dir')
    writeFileSync(join(admin, 'commondir'), join(other, '.git').replace(/\\/g, '/') + '\n')
    expect(tryGit(worktree, 'rev-parse', '--verify', 'HEAD^{commit}')).toBeUndefined()
    expect(await readLinkedCheckout(worktree, [pin])).toBeUndefined()
  })

  it('leaves a repository with an unsupported extension to Git', async () => {
    const repo = repository()
    const worktree = join(repo, '..', 'wt'); git(repo, 'worktree', 'add', '-q', '-b', 'thread/extension', worktree)
    expect((await readLinkedCheckout(worktree))?.head).toEqual(gitHead(worktree))
    git(repo, 'config', 'core.repositoryformatversion', '1')
    git(repo, 'config', 'extensions.mousseUnknown', 'true')
    expect(() => git(worktree, 'rev-parse', '--verify', 'HEAD^{commit}')).toThrow(/unknown repository extension/i)
    expect(await readLinkedCheckout(worktree)).toBeUndefined()
  })

  it('rejects a replaced common directory at the same path, even with the original worktree admin directory', async () => {
    const repo = repository()
    const worktree = join(repo, '..', 'wt'); git(repo, 'worktree', 'add', '-q', '-b', 'thread/replaced-common', worktree)
    const thread = join(repo, '..', 'thread')
    const before = (await readLinkedCheckout(worktree))!
    await recordCheckoutIdentity(thread, worktree)
    expect(await sameCheckout(thread, worktree, before.identity)).toBe(true)

    const common = before.identity.commonDir
    const moved = join(dirname(common), 'original-git-dir')
    renameSync(common, moved)
    cpSync(moved, common, { recursive: true, filter: (from) => from !== join(moved, 'worktrees') })
    renameSync(join(moved, 'worktrees'), join(common, 'worktrees'))

    const after = (await readLinkedCheckout(worktree))!
    expect(after.head).toEqual(before.head)
    expect(after.identity.commonDir).toBe(common)
    expect(after.identity.gitDirId).toBe(before.identity.gitDirId)
    expect(await sameCheckout(thread, worktree, after.identity)).toBe(false)
  })
  it.each([
    ['core.worktree in the worktree\'s own config.worktree', (repo: string, worktree: string) => {
      git(repo, 'config', 'extensions.worktreeConfig', 'true')
      git(worktree, 'config', '--worktree', 'core.worktree', join(repo, '..', 'elsewhere'))
    }],
    ['core.worktree in the shared config', (repo: string) => { git(repo, 'config', 'core.worktree', join(repo, '..', 'elsewhere')) }],
    ['an inline core.worktree in the shared config', (repo: string) => {
      const elsewhere = join(repo, '..', 'elsewhere').replace(/\\/g, '/')
      mkdirSync(elsewhere)
      appendFileSync(join(repo, '.git', 'config'), '\n[core] worktree = ' + elsewhere + '\n')
      expect(git(repo, 'config', '--get', 'core.worktree')).toBe(elsewhere)
    }],
    ['an include in the shared config', (repo: string) => { git(repo, 'config', 'include.path', join(repo, '..', 'more.gitconfig')) }]
  ] as const)('leaves a worktree to Git when %s may move its checkout', async (_name, configure) => {
    const repo = repository()
    const worktree = join(repo, '..', 'wt'); git(repo, 'worktree', 'add', '-q', '-b', 'thread/config', worktree)
    expect(await readWorktreeHead(worktree, { linkedOnly: true })).toEqual(gitHead(worktree))
    configure(repo, worktree)
    expect(await readWorktreeHead(worktree, { linkedOnly: true })).toBeUndefined()
  })

  it.each([
    ['a leading space in detached HEAD', (admin: string, sha: string) => writeFileSync(join(admin, 'HEAD'), ` ${sha}\n`)],
    ['trailing junk in detached HEAD', (admin: string, sha: string) => writeFileSync(join(admin, 'HEAD'), `${sha} junk\n`)],
    ['a malformed symbolic HEAD', (admin: string) => writeFileSync(join(admin, 'HEAD'), 'ref: refs/heads/.invalid\n')],
    ['trailing whitespace in a loose ref', (admin: string, sha: string, common: string) => {
      writeFileSync(join(admin, 'HEAD'), 'ref: refs/heads/test-loose\n')
      writeFileSync(join(common, 'refs/heads/test-loose'), `${sha} \n`)
    }]
  ] as const)('leaves %s to Git', async (name, change) => {
    const repo = repository()
    const worktree = join(repo, '..', 'wt'); git(repo, 'worktree', 'add', '-q', '--detach', worktree)
    const head = git(worktree, 'rev-parse', '--verify', 'HEAD^{commit}')
    expect((await readLinkedCheckout(worktree))?.head.head).toBe(head)
    change(git(worktree, 'rev-parse', '--absolute-git-dir'), head, join(repo, '.git'))
    if (name === 'a leading space in detached HEAD') expect(tryGit(worktree, 'rev-parse', '--verify', 'HEAD^{commit}')).toBeUndefined()
    expect(await readLinkedCheckout(worktree)).toBeUndefined()
  })

  it.each([
    ['invalid core.filemode', (repo: string) => git(repo, 'config', 'core.filemode', 'invalid'), false],
    ['a valid shared config edit', (repo: string) => git(repo, 'config', 'core.autocrlf', 'true'), true],
    ['a repack', (repo: string) => git(repo, 'repack', '-ad'), true],
    ['a replaced object directory', (repo: string) => {
      const objects = join(repo, '.git', 'objects')
      renameSync(objects, join(repo, '.git', 'original-objects'))
      mkdirSync(objects)
    }, false]
  ] as const)('requires Git to revalidate after %s', async (_name, change, valid) => {
    const repo = repository()
    const worktree = join(repo, '..', 'wt'); git(repo, 'worktree', 'add', '-q', '--detach', worktree)
    const thread = join(repo, '..', 'thread')
    const sha = git(worktree, 'rev-parse', '--verify', 'HEAD^{commit}')
    const pin = 'refs/mousse/retained'
    git(repo, 'update-ref', pin, sha)
    const hasRecordedCheckout = async () => {
      const read = await readLinkedCheckout(worktree, [pin])
      return !!read && read.head.head === sha && read.refs.get(pin) === sha && await sameCheckout(thread, worktree, read.identity)
    }
    await recordCheckoutIdentity(thread, worktree)
    expect(await hasRecordedCheckout()).toBe(true)
    change(repo)
    expect(tryGit(worktree, 'rev-parse', '--verify', `${pin}^{commit}`)).toBe(valid ? sha : undefined)
    expect(await hasRecordedCheckout()).toBe(false)
    await recordCheckoutIdentity(thread, worktree)
    expect(await hasRecordedCheckout()).toBe(valid)
  })

  it('names the physical checkout: a worktree removed and added again at the same path is another one', async () => {
    const repo = repository()
    const worktree = join(repo, '..', 'wt'); git(repo, 'worktree', 'add', '-q', '-b', 'thread/again', worktree)
    const first = await readLinkedCheckout(worktree, ['refs/heads/thread/again', 'refs/mousse/none'])
    expect(first?.refs.get('refs/heads/thread/again')).toBe(gitHead(worktree).head)
    expect(first?.refs.get('refs/mousse/none')).toBeNull()
    expect(await readLinkedCheckout(worktree)).toMatchObject({ identity: first!.identity })
    git(repo, 'worktree', 'remove', '--force', worktree)
    git(repo, 'worktree', 'add', '-q', worktree, 'thread/again')
    const again = await readLinkedCheckout(worktree)
    expect(again?.head).toEqual(first?.head)
    expect(again?.identity).not.toEqual(first!.identity)
  })
})

describe('commit objects read from Git files', () => {
  const replaceGitFile = (path: string, contents: string | Buffer) => {
    // Git makes object files read-only, including on Windows.
    chmodSync(path, 0o644)
    writeFileSync(path, contents)
  }

  it.each([
    ['an empty loose commit', (path: string) => replaceGitFile(path, '')],
    ['a corrupt loose commit', (path: string) => replaceGitFile(path, 'invalid zlib stream')],
    ['a missing root tree', (_path: string, tree: string) => renameSync(tree, tree + '.moved')],
    ['a corrupt root tree', (_path: string, tree: string) => replaceGitFile(tree, 'invalid zlib stream')]
  ] as const)('leaves %s to Git', async (_name, change) => {
    const repo = repository()
    const common = join(repo, '.git')
    const head = git(repo, 'rev-parse', 'HEAD')
    const tree = git(repo, 'rev-parse', 'HEAD^{tree}')
    const loose = (oid: string) => join(common, 'objects', oid.slice(0, 2), oid.slice(2))
    expect(await hasLocalWorktreeCommits(common, head)).toBe(true)
    change(loose(head), loose(tree))
    expect(await hasLocalWorktreeCommits(common, head)).toBe(false)
  })

  it.each([
    ['a missing pack', (_index: string, pack: string) => renameSync(pack, pack + '.moved')],
    ['an unsupported index version', (index: string) => {
      const bytes = readFileSync(index)
      bytes.writeUInt32BE(3, 4)
      replaceGitFile(index, bytes)
    }],
    ['a truncated pack', (_index: string, pack: string) => replaceGitFile(pack, readFileSync(pack).subarray(0, 12))]
  ] as const)('leaves %s to Git even though the ref still names the commit', async (_name, change) => {
    const repo = repository()
    const common = join(repo, '.git')
    const head = git(repo, 'rev-parse', 'HEAD')
    git(repo, '-c', 'pack.indexVersion=2', 'repack', '-ad')
    const packDir = join(common, 'objects', 'pack')
    const index = join(packDir, readdirSync(packDir).find((name) => name.endsWith('.idx'))!)
    expect(await hasLocalWorktreeCommits(common, head)).toBe(true)
    change(index, index.slice(0, -4) + '.pack')
    expect(await hasLocalWorktreeCommits(common, head)).toBe(false)
  })

  it('leaves an object store with alternates to Git', async () => {
    const repo = repository()
    const worktree = join(repo, '..', 'wt')
    git(repo, 'worktree', 'add', '-q', '--detach', worktree)
    const other = repository()
    writeFileSync(join(repo, '.git', 'objects', 'info', 'alternates'), join(other, '.git', 'objects').replace(/\\/g, '/') + '\n')
    expect(gitHead(worktree).head).toBeDefined()
    expect(await readLinkedCheckout(worktree)).toBeUndefined()
  })
})
