import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const roots: string[] = []
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** A clone whose origin has a pull request head, mapped onto a tracking ref the way people configure GitHub remotes. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'mousse-refmap-'))
  roots.push(root)
  const origin = join(root, 'origin')
  const cwd = join(root, 'work')
  git(root, 'init', '-q', '-b', 'main', origin)
  for (const [key, value] of [['user.name', 'x'], ['user.email', 'x@example.invalid'], ['commit.gpgsign', 'false']]) git(origin, 'config', key!, value!)
  writeFileSync(join(origin, 'a.txt'), 'a\n')
  git(origin, 'add', 'a.txt')
  git(origin, 'commit', '-qm', 'base')
  git(origin, 'update-ref', 'refs/pull/7/head', 'HEAD')
  git(root, 'clone', '-q', origin, cwd)
  git(cwd, 'config', '--add', 'remote.origin.fetch', '+refs/pull/*/head:refs/remotes/origin/pr/*')
  return cwd
}

describe('a fetch of a ref into Mousse’s own ref (what the Git policy assumes)', () => {
  it('moves a configured tracking ref too, unless it passes an empty --refmap=', () => {
    const cwd = fixture()
    git(cwd, 'fetch', '--no-tags', '--no-write-fetch-head', '--refmap=', '--', 'origin', '+refs/pull/7/head:refs/mousse/pull/7/head')
    expect(git(cwd, 'for-each-ref', '--format=%(refname)', 'refs/remotes/origin/pr/')).toBe('')
    expect(git(cwd, 'rev-parse', 'refs/mousse/pull/7/head')).toMatch(/^[0-9a-f]{40}$/)

    // Git's opportunistic update: the same fetch without it also writes the mapped tracking ref.
    git(cwd, 'fetch', '--no-tags', '--no-write-fetch-head', '--', 'origin', '+refs/pull/7/head:refs/mousse/pull/7/other')
    expect(git(cwd, 'for-each-ref', '--format=%(refname)', 'refs/remotes/origin/pr/')).toBe('refs/remotes/origin/pr/7')
  })

  it('moves a tracking ref mapped from a commit by name too, unless it passes an empty --refmap=', () => {
    const cwd = fixture()
    const commit = git(cwd, 'rev-parse', 'origin/main')
    git(cwd, 'config', '--add', 'remote.origin.fetch', `${commit}:refs/remotes/origin/unexpected`)
    git(cwd, 'fetch', '--no-tags', '--no-recurse-submodules', '--no-write-fetch-head', '--refmap=', 'origin', commit)
    expect(git(cwd, 'for-each-ref', '--format=%(refname)', 'refs/remotes/origin/unexpected')).toBe('')

    git(cwd, 'fetch', '--no-tags', '--no-recurse-submodules', '--no-write-fetch-head', 'origin', commit)
    expect(git(cwd, 'for-each-ref', '--format=%(refname)', 'refs/remotes/origin/unexpected')).toBe('refs/remotes/origin/unexpected')
  })
})
