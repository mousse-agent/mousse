import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
