import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveRepositoryIdentity } from '../src/mms/git/RepositoryIdentity'
import { acquireRepositoryLease, getRepositoryLeasePath, RepositoryLeaseAbortedError } from '../src/mms/git/RepositoryLease'

const dirs: string[] = []
function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mousse-repo-')); dirs.push(dir)
  execFileSync('git', ['init', '-q'], { cwd: dir }); execFileSync('git', ['config', 'user.email', 'test@example.test'], { cwd: dir }); execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir })
  writeFileSync(join(dir, 'README'), 'x'); execFileSync('git', ['add', '.'], { cwd: dir }); execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir })
  return dir
}
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }) })

describe('RepositoryIdentity', () => {
  it('uses git common-dir so linked worktrees share one identity', () => {
    const root = repo(); const linked = `${root}-linked`; dirs.push(linked)
    execFileSync('git', ['worktree', 'add', '-q', '-b', 'linked', linked], { cwd: root })
    expect(resolveRepositoryIdentity(root).commonDir).toBe(resolveRepositoryIdentity(linked).commonDir)
    expect(resolveRepositoryIdentity(root).key).toBe(resolveRepositoryIdentity(linked).key)
  })
  it('refuses mutation capability for bare and unborn repositories', () => {
    const bare = mkdtempSync(join(tmpdir(), 'mousse-bare-')); dirs.push(bare); execFileSync('git', ['init', '--bare', '-q'], { cwd: bare })
    expect(resolveRepositoryIdentity(bare).capability).toEqual({ allowed: false, reason: 'bare-repository' })
    const unborn = mkdtempSync(join(tmpdir(), 'mousse-unborn-')); dirs.push(unborn); execFileSync('git', ['init', '-q'], { cwd: unborn })
    expect(resolveRepositoryIdentity(unborn).capability).toEqual({ allowed: false, reason: 'unborn-head' })
  })
})

describe('RepositoryLease', () => {
  it('serializes contenders fairly and keeps independent repositories independent', async () => {
    const a = resolveRepositoryIdentity(repo()); const b = resolveRepositoryIdentity(repo())
    const first = await acquireRepositoryLease(a); const second = acquireRepositoryLease(a, { retryDelayMs: 2 }); const other = await acquireRepositoryLease(b)
    let acquired = false; void second.then(() => { acquired = true })
    await new Promise(resolve => setTimeout(resolve, 15)); expect(acquired).toBe(false)
    expect(other.release()).toBe(true); expect(first.release()).toBe(true)
    expect((await second).release()).toBe(true)
  })
  it('aborts a queued contender and safely recovers dead stale ownership', async () => {
    const identity = resolveRepositoryIdentity(repo()); const first = await acquireRepositoryLease(identity)
    const controller = new AbortController(); const waiting = acquireRepositoryLease(identity, { signal: controller.signal, retryDelayMs: 2 }); controller.abort()
    await expect(waiting).rejects.toBeInstanceOf(RepositoryLeaseAbortedError); expect(first.release()).toBe(true)
    writeFileSync(getRepositoryLeasePath(identity), JSON.stringify({ pid: 2147000000, processInstanceId: 'dead', token: 'dead', acquiredAt: new Date(0).toISOString(), heartbeatAt: new Date(0).toISOString() }))
    const recovered = await acquireRepositoryLease(identity); expect(existsSync(getRepositoryLeasePath(identity))).toBe(true); recovered.release()
  })
})
