import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isIntegratedAsync, primaryRemoteAsync, resolveDefaultBranchAsync } from '../src/mms/git/defaultBranch'
import { fixtureGit as git } from './support/fixtureGit'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) })
function repo() {
  const root = mkdtempSync(join(tmpdir(), 'mousse-default-branch-')); roots.push(root); const cwd = join(root, 'r'); mkdirSync(cwd)
  git(cwd, ['init', '-q']); git(cwd, ['config', 'user.email', 't@example.com']); git(cwd, ['config', 'user.name', 'T'])
  writeFileSync(join(cwd, 'a.txt'), 'a'); git(cwd, ['add', '.']); git(cwd, ['commit', '-qm', 'one'])
  const name = git(cwd, ['symbolic-ref', '--short', 'HEAD'])
  const publish = (remote: string, branch = name) => {
    git(cwd, ['remote', 'add', remote, cwd]); git(cwd, ['update-ref', `refs/remotes/${remote}/${branch}`, 'HEAD']); git(cwd, ['symbolic-ref', `refs/remotes/${remote}/HEAD`, `refs/remotes/${remote}/${branch}`])
  }
  return { cwd, name, publish }
}

describe('resolveDefaultBranch', () => {
  it('reads the branch the remote HEAD names, with the local and remote-tracking refs that exist', async () => {
    const r = repo(); r.publish('origin')
    expect((await resolveDefaultBranchAsync(r.cwd))).toEqual({ name: r.name, refs: [`refs/heads/${r.name}`, `refs/remotes/origin/${r.name}`] })
    expect((await primaryRemoteAsync(r.cwd))).toBe('origin')
  })

  it('uses the only remote when it is not called origin, and none when several are', async () => {
    const one = repo(); one.publish('upstream')
    expect((await primaryRemoteAsync(one.cwd))).toBe('upstream'); expect((await resolveDefaultBranchAsync(one.cwd))?.refs).toContain(`refs/remotes/upstream/${one.name}`)
    const two = repo(); two.publish('upstream'); git(two.cwd, ['remote', 'add', 'fork', two.cwd])
    expect((await primaryRemoteAsync(two.cwd))).toBeUndefined(); expect((await resolveDefaultBranchAsync(two.cwd))).toBeNull()
  })

  it('falls back to the name the code host cached, and to nothing without it', async () => {
    const r = repo()
    expect((await resolveDefaultBranchAsync(r.cwd))).toBeNull()
    expect((await resolveDefaultBranchAsync(r.cwd, { cachedDefaultBranch: (cwd) => cwd === r.cwd ? r.name : undefined }))).toEqual({ name: r.name, refs: [`refs/heads/${r.name}`] })
  })

  it('never takes the checked-out branch for the default branch', async () => {
    const r = repo(); git(r.cwd, ['checkout', '-q', '-b', 'feature'])
    expect((await resolveDefaultBranchAsync(r.cwd))).toBeNull()
  })

  it('is null for a name with no ref, and refuses a name that could read as a flag', async () => {
    const r = repo()
    expect((await resolveDefaultBranchAsync(r.cwd, { cachedDefaultBranch: () => 'gone' }))).toBeNull()
    expect((await resolveDefaultBranchAsync(r.cwd, { cachedDefaultBranch: () => '--upload-pack=x' }))).toBeNull()
    expect((await resolveDefaultBranchAsync(r.cwd, { cachedDefaultBranch: () => 'a..b' }))).toBeNull()
  })

  it('throws when Git cannot answer', async () => {
    const r = repo(); rmSync(join(r.cwd, '.git'), { recursive: true, force: true })
    await expect(resolveDefaultBranchAsync(r.cwd)).rejects.toThrow()
  })
})

describe('isIntegrated', () => {
  it('is ancestry only: contained commits count, a commit that is merely not contained does not', async () => {
    const r = repo(); const base = git(r.cwd, ['rev-parse', 'HEAD'])
    git(r.cwd, ['checkout', '-q', '-b', 'topic']); writeFileSync(join(r.cwd, 'b.txt'), 'b'); git(r.cwd, ['add', '.']); git(r.cwd, ['commit', '-qm', 'two'])
    const topic = git(r.cwd, ['rev-parse', 'HEAD'])
    expect((await isIntegratedAsync(r.cwd, base, [`refs/heads/${r.name}`]))).toBe(true)
    expect((await isIntegratedAsync(r.cwd, topic, [`refs/heads/${r.name}`]))).toBe(false)
    expect((await isIntegratedAsync(r.cwd, topic, [`refs/heads/${r.name}`, 'refs/heads/topic']))).toBe(true)
    expect((await isIntegratedAsync(r.cwd, topic, []))).toBe(false)
  })

  it('throws on any Git failure other than "not an ancestor"', async () => {
    const r = repo()
    await expect(isIntegratedAsync(r.cwd, 'f'.repeat(40), [`refs/heads/${r.name}`])).rejects.toThrow()
    await expect(isIntegratedAsync(r.cwd, git(r.cwd, ['rev-parse', 'HEAD']), ['refs/heads/absent'])).rejects.toThrow()
  })
})
