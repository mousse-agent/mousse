import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  assertGitAllowed, clearGitPolicyLog, decideGitCommand, GitPolicyError, gitPolicyLog, isOwnedPath, isOwnedRef,
  registerOwnedGitRoot, stripInheritedGitEnv, userAction, withGitAccess, type GitCommandRequest
} from '../src/mms/git/gitPolicy'
import { repoProgramEnv, withoutRepoPrograms } from '../src/mms/git/repoPrograms'

const USER = userAction('button', 'Push')
const roots: string[] = []
const undo: Array<() => void> = []
let outside: string
let owned: string

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}
function scratch(prefix: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  roots.push(root)
  return root
}
const decide = (request: Partial<GitCommandRequest> & { args: string[] }) => decideGitCommand({ cwd: outside, ...request })

beforeEach(() => {
  outside = scratch('mousse-policy-user-')
  // A user's repository: owned ref writes are resolved in it.
  git(outside, 'init', '-q', '-b', 'main')
  owned = scratch('mousse-policy-home-')
  undo.push(registerOwnedGitRoot(owned))
  clearGitPolicyLog()
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})

afterEach(() => {
  for (const done of undo.splice(0)) done()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('reads come from an allowlist', () => {
  it.each([
    [['--no-optional-locks', 'status', '--porcelain']], [['rev-parse', '--show-toplevel']], [['diff', '--cached']], [['-c', 'diff.autoRefreshIndex=false', 'diff']], [['log', '-1']], [['for-each-ref', 'refs/heads']],
    [['config', '--get', 'user.name']], [['config', 'user.name']], [['config', '--null', '--show-scope', '--show-origin', '--list']],
    [['branch', '--show-current']], [['branch']], [['remote']], [['remote', 'get-url', 'origin']], [['worktree', 'list', '--porcelain']],
    [['symbolic-ref', '--quiet', '--short', 'HEAD']], [['hash-object', '--', 'a.txt']], [['tag', '--list']], [['stash', 'list']],
    [['-c', 'core.fsmonitor=false', 'cat-file', '--batch']], [['commit-tree', 'abc', '-m', 'x']]
  ])('%j only reads', (args) => {
    expect(decide({ args })).toMatchObject({ access: 'read', allowed: true })
  })

  it('denies a command it does not know', () => {
    expect(decide({ args: ['filter-branch', '--all'] })).toMatchObject({ access: 'userRequested', allowed: false })
  })
})

describe('Mousse may change what it owns', () => {
  it('owns refs/mousse/* and mousse/* branches, in any case', () => {
    expect(isOwnedRef('refs/mousse/threads/1/main')).toBe(true)
    expect(isOwnedRef('refs/heads/mousse/thread/1/main')).toBe(true)
    expect(isOwnedRef('refs/heads/Mousse/thread/1')).toBe(true)
    expect(isOwnedRef('refs/heads/main')).toBe(false)
    expect(isOwnedRef('refs/remotes/origin/mousse/x')).toBe(false)
  })

  it('allows owned ref writes anywhere, and other refs only for the user', () => {
    expect(decide({ args: ['update-ref', 'refs/mousse/changes/1/after', 'abc'] })).toMatchObject({ access: 'owned', allowed: true })
    expect(decide({ args: ['update-ref', 'refs/heads/main', 'abc'] })).toMatchObject({ access: 'userRequested', allowed: false })
    expect(decide({ args: ['update-ref', 'refs/heads/main', 'abc'], userRequested: USER })).toMatchObject({ access: 'userRequested', allowed: true })
    expect(decide({ args: ['branch', '-D', '--', 'mousse/thread/1/main'] })).toMatchObject({ access: 'owned', allowed: true })
    expect(decide({ args: ['branch', '-D', '--', 'feature'] })).toMatchObject({ allowed: false })
  })

  it('reads update-ref --stdin input, and refuses when it cannot see it', () => {
    const args = ['update-ref', '--no-deref', '--stdin']
    expect(decide({ args, stdin: 'start\ndelete refs/mousse/a 1\nprepare\ncommit\n' })).toMatchObject({ access: 'owned', allowed: true })
    expect(decide({ args, stdin: 'start\ndelete refs/mousse/a 1\ndelete refs/heads/main 2\ncommit\n' })).toMatchObject({ allowed: false })
    expect(decide({ args, stdin: 'update refs/mousse/a\0new\0old\0' })).toMatchObject({ allowed: true })
    expect(decide({ args })).toMatchObject({ allowed: false })
  })

  it('allows a fetch only into owned refs, without tags and with every refspec named', () => {
    const into = ['fetch', '--no-tags', '--no-write-fetch-head', '--', 'origin', '+refs/pull/7/head:refs/mousse/pull/7/head']
    expect(decide({ args: into })).toMatchObject({ access: 'owned', allowed: true })
    // A commit by name only downloads objects: no ref changes.
    expect(decide({ args: ['fetch', '--no-tags', '--no-write-fetch-head', 'origin', 'a'.repeat(40)] })).toMatchObject({ access: 'read', allowed: true })
    expect(decide({ args: ['fetch', 'origin', '+refs/pull/7/head:refs/mousse/pull/7/head'] })).toMatchObject({ allowed: false })
    expect(decide({ args: ['fetch', '--no-tags', 'origin', 'refs/heads/main:refs/heads/main'] })).toMatchObject({ allowed: false })
    expect(decide({ args: ['fetch', '--no-tags', '--prune', 'origin', 'x:refs/mousse/x'] })).toMatchObject({ allowed: false })
    expect(decide({ args: ['fetch', '--progress'] })).toMatchObject({ allowed: false })
    expect(decide({ args: ['fetch', '--progress'], userRequested: USER })).toMatchObject({ access: 'userRequested', allowed: true })
  })

  it('allows a push only of owned refs, without -u', () => {
    expect(decide({ args: ['push', '--no-verify', 'origin', 'refs/mousse/r/1:refs/heads/mousse/dispatch/1'] })).toMatchObject({ access: 'owned', allowed: true })
    expect(decide({ args: ['push', 'origin', 'HEAD:refs/heads/main'] })).toMatchObject({ allowed: false })
    expect(decide({ args: ['push', '-u', 'origin', 'HEAD:refs/heads/mousse/x'] })).toMatchObject({ allowed: false })
    expect(decide({ args: ['push', '--mirror', 'origin'] })).toMatchObject({ allowed: false })
  })

  it('allows worktree content changes inside the Mousse home only', () => {
    expect(decide({ cwd: owned, args: ['add', '-A'] })).toMatchObject({ access: 'owned', allowed: true })
    expect(decide({ cwd: outside, args: ['add', '-A'] })).toMatchObject({ allowed: false })
    // A private index under the Mousse home stands in for the checkout's own.
    expect(decide({ cwd: outside, args: ['add', '-A'], env: { GIT_INDEX_FILE: join(owned, 'index') } })).toMatchObject({ access: 'owned', allowed: true })
    expect(decide({ cwd: outside, args: ['worktree', 'add', '-b', 'mousse/thread/1/main', join(owned, 'wt'), 'HEAD'] })).toMatchObject({ access: 'owned', allowed: true })
    expect(decide({ cwd: outside, args: ['worktree', 'add', join(outside, 'wt')] })).toMatchObject({ allowed: false })
    expect(decide({ cwd: outside, args: ['worktree', 'remove', join(owned, 'wt')] })).toMatchObject({ access: 'owned', allowed: true })
  })

  it('never lets an owned folder cover a ref, remote or config write', () => {
    expect(decide({ cwd: owned, args: ['config', 'extensions.worktreeConfig', 'true'] })).toMatchObject({ allowed: false })
    expect(decide({ cwd: owned, args: ['remote', 'add', 'x', 'url'] })).toMatchObject({ allowed: false })
    expect(decide({ cwd: owned, args: ['stash', 'push'] })).toMatchObject({ allowed: false })
    expect(decide({ cwd: owned, args: ['tag', 'v1'] })).toMatchObject({ allowed: false })
  })

  it('allows a commit in an owned worktree only while HEAD is on an owned branch', () => {
    const worktree = join(owned, 'worktree')
    git(owned, 'init', '-q', '-b', 'mousse/thread/1/main', worktree)
    expect(decide({ cwd: worktree, args: ['commit', '-m', 'checkpoint'] })).toMatchObject({ access: 'owned', allowed: true })
    git(worktree, 'symbolic-ref', 'HEAD', 'refs/heads/feature')
    expect(decide({ cwd: worktree, args: ['commit', '-m', 'checkpoint'] })).toMatchObject({ allowed: false, reason: expect.stringContaining('refs/heads/feature') })
  })

  it('compares real paths: a link into the Mousse home is the home, a link out of it is not', () => {
    const link = join(outside, 'link-to-home')
    symlinkSync(owned, link)
    expect(isOwnedPath(join(link, 'worktree'))).toBe(true)
    mkdirSync(join(owned, 'escape-parent'))
    const escape = join(owned, 'escape-parent', 'out')
    symlinkSync(outside, escape)
    expect(isOwnedPath(join(escape, 'x'))).toBe(false)
  })
})

describe('symbolic refs are judged by their target', () => {
  /** A repository outside the Mousse home whose `refs/mousse/x` points at `refs/heads/main`. */
  function symbolic() {
    const cwd = join(scratch('mousse-policy-symbolic-'), 'repo')
    git(tmpdir(), 'init', '-q', '-b', 'main', cwd)
    git(cwd, '-c', 'user.name=x', '-c', 'user.email=x@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'one')
    git(cwd, '-c', 'user.name=x', '-c', 'user.email=x@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'two')
    git(cwd, 'symbolic-ref', 'refs/mousse/x', 'refs/heads/main')
    return { cwd, main: git(cwd, 'rev-parse', 'main'), older: git(cwd, 'rev-parse', 'main~1') }
  }

  it('refuses a write through an owned symbolic ref, and allows it with --no-deref', () => {
    const { cwd, older } = symbolic()
    expect(decideGitCommand({ cwd, args: ['update-ref', 'refs/mousse/x', older] })).toMatchObject({ allowed: false, reason: expect.stringContaining('refs/heads/main') })
    expect(decideGitCommand({ cwd, args: ['update-ref', '-d', 'refs/mousse/x'] })).toMatchObject({ allowed: false })
    expect(decideGitCommand({ cwd, args: ['update-ref', '--stdin'], stdin: `update refs/mousse/x ${older}\n` })).toMatchObject({ allowed: false })
    expect(decideGitCommand({ cwd, args: ['fetch', '--no-tags', '.', '+refs/heads/main:refs/mousse/x'] })).toMatchObject({ allowed: false })
    expect(decideGitCommand({ cwd, args: ['update-ref', '--no-deref', 'refs/mousse/x', older] })).toMatchObject({ access: 'owned', allowed: true })
    expect(decideGitCommand({ cwd, args: ['update-ref', 'refs/mousse/plain', older] })).toMatchObject({ access: 'owned', allowed: true })
  })

  it('never lets Mousse\'s own update-ref move main through refs/mousse, with refusal on or off', () => {
    const { cwd, main, older } = symbolic()
    for (const mode of ['log', 'refuse']) {
      vi.stubEnv('MOUSSE_GIT_POLICY', mode)
      // The runner every Mousse ref write goes through adds --no-deref, so the symbolic ref itself is replaced.
      execFileSync('git', withoutRepoPrograms(cwd, ['update-ref', 'refs/mousse/x', older]), { cwd, env: repoProgramEnv(), stdio: 'ignore' })
      expect(git(cwd, 'rev-parse', 'main')).toBe(main)
      git(cwd, 'symbolic-ref', 'refs/mousse/x', 'refs/heads/main')
    }
    expect(gitPolicyLog()).toEqual([])
    vi.stubEnv('MOUSSE_GIT_POLICY', 'refuse')
    expect(() => assertGitAllowed({ cwd, args: ['update-ref', 'refs/mousse/x', older] })).toThrow(GitPolicyError)
    expect(git(cwd, 'rev-parse', 'main')).toBe(main)
  })

  it('refuses a commit in an owned worktree whose owned branch points at a user branch', () => {
    const worktree = join(owned, 'linked')
    git(owned, 'init', '-q', '-b', 'main', worktree)
    git(worktree, 'symbolic-ref', 'refs/heads/mousse/thread/1/main', 'refs/heads/main')
    git(worktree, 'symbolic-ref', 'HEAD', 'refs/heads/mousse/thread/1/main')
    expect(decideGitCommand({ cwd: worktree, args: ['commit', '-m', 'checkpoint'] })).toMatchObject({ allowed: false, reason: expect.stringContaining('refs/heads/main') })
  })
})

describe('status and diff write the index unless told not to', () => {
  it('reads only with optional locks or the refresh off, or on the index alone', () => {
    expect(decide({ args: ['status', '--porcelain'] })).toMatchObject({ allowed: false, reason: expect.stringContaining('index') })
    expect(decide({ args: ['status', '--porcelain'], env: { GIT_OPTIONAL_LOCKS: '0' } })).toMatchObject({ access: 'read', allowed: true })
    expect(decide({ args: ['status'], lockFree: true })).toMatchObject({ access: 'read' })
    expect(decide({ args: ['diff', '--', 'a.txt'] })).toMatchObject({ allowed: false })
    expect(decide({ args: ['diff', '--', 'a.txt'], lockFree: true })).toMatchObject({ access: 'read' })
    expect(decide({ args: ['diff', '--no-index', 'a', 'b'] })).toMatchObject({ access: 'read' })
    // In an owned worktree, a refresh of its own index is Mousse's own business.
    expect(decide({ cwd: owned, args: ['status'] })).toMatchObject({ access: 'owned', allowed: true })
  })
})

describe('worktree config', () => {
  it('owns the config of its own worktrees, never the repository\'s', () => {
    expect(decide({ cwd: owned, args: ['config', '--worktree', 'core.hooksPath', '/dev/null'] })).toMatchObject({ access: 'owned', allowed: true })
    expect(decide({ cwd: outside, args: ['config', '--worktree', 'core.hooksPath', '/dev/null'] })).toMatchObject({ allowed: false })
    expect(decide({ cwd: owned, args: ['config', 'extensions.worktreeConfig', 'true'] })).toMatchObject({ allowed: false })
    expect(decide({ cwd: outside, args: ['config', 'extensions.worktreeConfig', 'true'], userRequested: userAction('button', 'Start thread from pull request') })).toMatchObject({ access: 'userRequested', allowed: true })
  })
})

describe('redirects and housekeeping are refused', () => {
  it.each([
    [['-C', '/elsewhere', 'status']], [['--git-dir=/x/.git', 'log']], [['--work-tree', '/x', 'status']],
    [['-c', 'push.default=matching', 'push']], [['-c', 'core.hooksPath=/tmp/hooks', 'status']], [['-c', 'core.fsmonitor=true', 'status']]
  ])('%j', (args) => {
    expect(decide({ args, userRequested: USER })).toMatchObject({ allowed: false })
  })

  it.each([[['gc', '--auto']], [['prune']], [['worktree', 'prune']], [['reflog', 'expire', '--all']]])('%j even for the user', (args) => {
    expect(decide({ args, userRequested: USER })).toMatchObject({ allowed: false })
  })
})

describe('gh', () => {
  it('reads from an allowlist; everything else needs the user', () => {
    for (const args of [['--version'], ['auth', 'status'], ['pr', 'view', '7', '--json', 'title'], ['api', 'user', '--jq', '.login'], ['repo', 'view']]) {
      expect(decideGitCommand({ executable: 'gh', cwd: outside, args })).toMatchObject({ access: 'read', allowed: true })
    }
    expect(decideGitCommand({ executable: 'gh', cwd: outside, args: ['api', '-X', 'POST', 'repos/a/b/pulls'] })).toMatchObject({ allowed: false })
    expect(decideGitCommand({ executable: 'gh', cwd: outside, args: ['api', 'repos/a/b/issues', '-f', 'title=x'] })).toMatchObject({ allowed: false })
    expect(decideGitCommand({ executable: 'gh', cwd: outside, args: ['pr', 'merge', '7', '--squash'] })).toMatchObject({ allowed: false })
    expect(decideGitCommand({ executable: 'gh', cwd: outside, args: ['pr', 'merge', '7', '--squash'], userRequested: userAction('button', 'Merge pull request') })).toMatchObject({ allowed: true })
  })
})

describe('log by default, refuse when asked', () => {
  it('logs a violation and lets it through by default', () => {
    expect(() => assertGitAllowed({ cwd: outside, args: ['update-ref', 'refs/heads/main', 'abc'] })).not.toThrow()
    expect(gitPolicyLog().at(-1)).toMatchObject({ kind: 'violation', command: 'git update-ref refs/heads/main abc' })
    expect(console.warn).toHaveBeenCalledTimes(1)
    // The same problem again is counted, not logged again.
    assertGitAllowed({ cwd: outside, args: ['update-ref', 'refs/heads/main', 'abc'] })
    expect(console.warn).toHaveBeenCalledTimes(1)
  })

  it('throws with MOUSSE_GIT_POLICY=refuse', () => {
    vi.stubEnv('MOUSSE_GIT_POLICY', 'refuse')
    expect(() => assertGitAllowed({ cwd: outside, args: ['update-ref', 'refs/heads/main', 'abc'] })).toThrow(GitPolicyError)
    expect(() => assertGitAllowed({ cwd: outside, args: ['status'], env: { GIT_OPTIONAL_LOCKS: '0' } })).not.toThrow()
  })

  it('logs a command that needs more than its protocol method declared, never refusing it', () => {
    vi.stubEnv('MOUSSE_GIT_POLICY', 'refuse')
    withGitAccess('git.status', 'read', () => {
      expect(() => assertGitAllowed({ cwd: owned, args: ['add', '-A'] })).not.toThrow()
    })
    expect(gitPolicyLog().at(-1)).toMatchObject({ kind: 'undeclared', method: 'git.status' })
  })
})

describe('inherited environment', () => {
  it('drops inherited GIT_* that could redirect a command, and keeps the user\'s config, identity and transport', () => {
    const inherited = { GIT_DIR: '/other/.git', GIT_INDEX_FILE: '/other/index', GIT_CONFIG_PARAMETERS: "'core.x'='y'", GIT_SSH_COMMAND: 'ssh -i k', GIT_CONFIG_GLOBAL: '/me/.gitconfig', GIT_AUTHOR_NAME: 'Me', PATH: '/bin' }
    const env = stripInheritedGitEnv({ ...inherited, GIT_OPTIONAL_LOCKS: '0' }, inherited)
    expect(env).toEqual({ GIT_SSH_COMMAND: 'ssh -i k', GIT_CONFIG_GLOBAL: '/me/.gitconfig', GIT_AUTHOR_NAME: 'Me', PATH: '/bin', GIT_OPTIONAL_LOCKS: '0' })
    // A value the caller set itself stays.
    expect(stripInheritedGitEnv({ ...inherited, GIT_DIR: '/mine/.git' }, inherited).GIT_DIR).toBe('/mine/.git')
  })
})
