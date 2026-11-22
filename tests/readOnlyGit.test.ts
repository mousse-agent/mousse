import { execFileSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readOnlyGitAsync, runReadOnlyGitAsync } from '../src/mms/git/readOnlyGit'
import { fixtureGit } from './support/fixtureGit'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function repo(): string {
  const root = mkdtempSync(join(tmpdir(), 'mousse-readonly-git-')); roots.push(root); mkdirSync(join(root, 'r'))
  const cwd = join(root, 'r'); fixtureGit(cwd, ['init', '-q']); writeFileSync(join(cwd, 'a.txt'), 'a')
  return cwd
}

describe('read-only Git for background checks', () => {
  it('asks Git not to take optional locks, so a commit from another terminal is never refused by a background status', async () => {
    const cwd = repo()
    fixtureGit(cwd, ['add', 'a.txt'])
    const index = join(cwd, '.git', 'index')
    const original = readFileSync(index)
    const old = new Date('2020-01-01')
    utimesSync(join(cwd, 'a.txt'), old, old)
    expect(await readOnlyGitAsync(cwd, ['status', '--porcelain', '--untracked-files=all'])).toBe('A  a.txt')
    expect(readFileSync(index)).toEqual(original)

    // Control: Git can refresh the index for the very same status read when optional locks are allowed.
    execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd, env: { ...process.env, GIT_OPTIONAL_LOCKS: '1' } })
    expect(readFileSync(index)).not.toEqual(original)

    // A different Git writer already holding the index lock can run alongside the background read.
    const lock = index + '.lock'
    writeFileSync(lock, 'another writer')
    expect(await readOnlyGitAsync(cwd, ['status', '--porcelain'])).toBe('A  a.txt')
    expect(readFileSync(lock, 'utf8')).toBe('another writer')
  })

  it('returns a non-zero exit instead of throwing, and readOnlyGit throws with Git\'s message', async () => {
    const cwd = repo()
    expect((await runReadOnlyGitAsync(cwd, ['rev-parse', '--verify', '--quiet', 'refs/heads/absent'])).status).toBe(1)
    await expect(readOnlyGitAsync(cwd, ['rev-parse', '--verify', 'refs/heads/absent'])).rejects.toThrow(/fatal|Needed a single revision/i)
  })
})
