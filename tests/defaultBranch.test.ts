import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isIntegrated, primaryRemote, resolveDefaultBranch } from '../src/mms/git/defaultBranch'
import { lifecycleGit as git } from '../src/mms/lifecycle/WorktreeRetirementService'

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
  it('reads the branch the remote HEAD names, with the local and remote-tracking refs that exist', () => {
    const r = repo(); r.publish('origin')
    expect(resolveDefaultBranch(r.cwd)).toEqual({ name: r.name, refs: [`refs/heads/${r.name}`, `refs/remotes/origin/${r.name}`] })
    expect(primaryRemote(r.cwd)).toBe('origin')
  })

  it('uses the only remote when it is not called origin, and none when several are', () => {
    const one = repo(); one.publish('upstream')
    expect(primaryRemote(one.cwd)).toBe('upstream'); expect(resolveDefaultBranch(one.cwd)?.refs).toContain(`refs/remotes/upstream/${one.name}`)
    const two = repo(); two.publish('upstream'); git(two.cwd, ['remote', 'add', 'fork', two.cwd])
    expect(primaryRemote(two.cwd)).toBeUndefined(); expect(resolveDefaultBranch(two.cwd)).toBeNull()
  })

  it('falls back to the name the code host cached, and to nothing without it', () => {
    const r = repo()
    expect(resolveDefaultBranch(r.cwd)).toBeNull()
    expect(resolveDefaultBranch(r.cwd, { cachedDefaultBranch: (cwd) => cwd === r.cwd ? r.name : undefined })).toEqual({ name: r.name, refs: [`refs/heads/${r.name}`] })
  })

  it('never takes the checked-out branch for the default branch', () => {
    const r = repo(); git(r.cwd, ['checkout', '-q', '-b', 'feature'])
    expect(resolveDefaultBranch(r.cwd)).toBeNull()
  })

  it('is null for a name with no ref, and refuses a name that could read as a flag', () => {
    const r = repo()
    expect(resolveDefaultBranch(r.cwd, { cachedDefaultBranch: () => 'gone' })).toBeNull()
    expect(resolveDefaultBranch(r.cwd, { cachedDefaultBranch: () => '--upload-pack=x' })).toBeNull()
    expect(resolveDefaultBranch(r.cwd, { cachedDefaultBranch: () => 'a..b' })).toBeNull()
  })

  it('throws when Git cannot answer', () => {
    const r = repo(); rmSync(join(r.cwd, '.git'), { recursive: true, force: true })
    expect(() => resolveDefaultBranch(r.cwd)).toThrow()
  })
})

describe('isIntegrated', () => {
  it('is ancestry only: contained commits count, a commit that is merely not contained does not', () => {
    const r = repo(); const base = git(r.cwd, ['rev-parse', 'HEAD'])
    git(r.cwd, ['checkout', '-q', '-b', 'topic']); writeFileSync(join(r.cwd, 'b.txt'), 'b'); git(r.cwd, ['add', '.']); git(r.cwd, ['commit', '-qm', 'two'])
    const topic = git(r.cwd, ['rev-parse', 'HEAD'])
    expect(isIntegrated(r.cwd, base, [`refs/heads/${r.name}`])).toBe(true)
    expect(isIntegrated(r.cwd, topic, [`refs/heads/${r.name}`])).toBe(false)
    expect(isIntegrated(r.cwd, topic, [`refs/heads/${r.name}`, 'refs/heads/topic'])).toBe(true)
    expect(isIntegrated(r.cwd, topic, [])).toBe(false)
  })

  it('throws on any Git failure other than "not an ancestor"', () => {
    const r = repo()
    expect(() => isIntegrated(r.cwd, 'f'.repeat(40), [`refs/heads/${r.name}`])).toThrow()
    expect(() => isIntegrated(r.cwd, git(r.cwd, ['rev-parse', 'HEAD']), ['refs/heads/absent'])).toThrow()
  })
})
