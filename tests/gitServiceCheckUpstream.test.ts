import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { GitService } from '../src/mms/git/GitService'

const roots: string[] = []
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function configure(cwd: string, root: string): void {
  git(cwd, 'config', 'user.name', 'Git upstream check fixture')
  git(cwd, 'config', 'user.email', 'git-fixture@example.invalid')
  git(cwd, 'config', 'commit.gpgsign', 'false')
  git(cwd, 'config', 'core.hooksPath', join(root, 'no-hooks'))
}

function commit(cwd: string, file: string): string {
  writeFileSync(join(cwd, file), `${file}\n`)
  git(cwd, 'add', file)
  git(cwd, 'commit', '-m', file)
  return git(cwd, 'rev-parse', 'HEAD')
}

/** A clone tracking origin/main, and a second clone that pushes new commits to origin behind its back. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'mousse-upstream-check-'))
  roots.push(root)
  const origin = join(root, 'origin.git')
  const cwd = join(root, 'work')
  const other = join(root, 'other')
  git(root, 'init', '--bare', '-b', 'main', origin)
  git(root, 'init', '-b', 'main', cwd)
  configure(cwd, root)
  git(cwd, 'remote', 'add', 'origin', origin)
  commit(cwd, 'base.txt')
  git(cwd, 'push', '-u', 'origin', 'main')
  git(root, 'clone', origin, other)
  configure(other, root)
  return { root, origin, cwd, other }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('GitService.checkUpstream', () => {
  it('counts commits on the remote without moving the tracking ref or writing FETCH_HEAD', async () => {
    const { cwd, other } = fixture()
    commit(other, 'one.txt')
    commit(other, 'two.txt')
    git(other, 'push', 'origin', 'main')
    const trackingBefore = git(cwd, 'rev-parse', 'origin/main')

    const check = await new GitService().checkUpstream(cwd)

    expect(check).toMatchObject({ state: 'checked', branch: 'main', head: git(cwd, 'rev-parse', 'HEAD'), ahead: 0, behind: 2 })
    // What a person sees stays as it was: the tracking ref, FETCH_HEAD and the refs Mousse used to count.
    expect(git(cwd, 'rev-parse', 'origin/main')).toBe(trackingBefore)
    expect(() => git(cwd, 'rev-parse', '--verify', '--quiet', 'FETCH_HEAD')).toThrow()
    expect(git(cwd, 'for-each-ref', 'refs/mousse/')).toBe('')
    // The status still reads the tracking ref, which a pull then brings up to date.
    expect(await new GitService().getStatus(cwd)).toMatchObject({ behind: 0 })
  })

  it('sees both sides of a diverged branch', async () => {
    const { cwd, other } = fixture()
    commit(other, 'theirs.txt')
    git(other, 'push', 'origin', 'main')
    commit(cwd, 'mine.txt')

    expect(await new GitService().checkUpstream(cwd)).toMatchObject({ state: 'checked', ahead: 1, behind: 1 })
  })

  it('says the remote is unreachable when it cannot be read', async () => {
    const { root, cwd } = fixture()
    git(cwd, 'remote', 'set-url', 'origin', join(root, 'missing.git'))

    expect(await new GitService().checkUpstream(cwd)).toMatchObject({ state: 'unreachable', branch: 'main' })
    expect(git(cwd, 'for-each-ref', 'refs/mousse/')).toBe('')
  })

  it('says the branch is gone when the remote no longer has it', async () => {
    const { cwd, origin } = fixture()
    git(cwd, 'checkout', '-b', 'topic')
    git(cwd, 'push', '-u', 'origin', 'topic')
    git(origin, 'branch', '-D', 'topic')

    expect(await new GitService().checkUpstream(cwd)).toMatchObject({ state: 'unreachable', branch: 'topic', reason: 'gone' })
  })

  it('has nothing to check without an upstream', async () => {
    const { cwd } = fixture()
    git(cwd, 'checkout', '-b', 'local-only')

    expect(await new GitService().checkUpstream(cwd)).toEqual({ state: 'none' })
  })
})
