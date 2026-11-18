import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  applyClaim, applyRelease, applyRenew, emptyState, formatClaims, isLive, liveClaims, listClaims, mutateClaims
} from '../scripts/work-claim.mjs'

const HOUR = 3_600_000
const T0 = Date.parse('2026-11-17T10:00:00Z')
const a = { task: 'task-a', session: 's1', machine: 'pc', branch: 'a', paths: ['src/mms/net/'], ttlMs: 2 * HOUR }

describe('claim rules', () => {
  it('claims a free task, then refuses a different session while the claim is live', () => {
    const first = applyClaim(emptyState(), a, T0)
    expect(first).toMatchObject({ ok: true, changed: true, action: 'claimed' })
    expect(first.claim.expiresAt).toBe('2026-11-17T12:00:00.000Z')
    const refused = applyClaim(first.state, { ...a, session: 's2', machine: 'mac' }, T0 + HOUR)
    expect(refused).toMatchObject({ ok: false, reason: 'held', changed: false })
    expect(refused.holder).toMatchObject({ session: 's1', machine: 'pc', expiresIn: '1h' })
  })

  it('ignores an expired claim and takes it over', () => {
    const first = applyClaim(emptyState(), a, T0).state
    expect(isLive(first.claims[0], T0 + 2 * HOUR)).toBe(false)
    expect(liveClaims(first, T0 + 2 * HOUR)).toEqual([])
    const taken = applyClaim(first, { ...a, session: 's2' }, T0 + 3 * HOUR)
    expect(taken).toMatchObject({ ok: true, action: 'took over an expired claim' })
    expect(taken.state.claims).toHaveLength(1)
    expect(taken.state.claims[0].session).toBe('s2')
  })

  it('re-claiming as the same session renews and keeps the first claim time', () => {
    const first = applyClaim(emptyState(), a, T0)
    const again = applyClaim(first.state, a, T0 + HOUR)
    expect(again).toMatchObject({ ok: true, action: 'renewed' })
    expect(again.claim.claimedAt).toBe(first.claim.claimedAt)
    expect(again.claim.expiresAt).toBe('2026-11-17T13:00:00.000Z')
  })

  it('warns, without refusing, when paths overlap a live claim on another task', () => {
    const first = applyClaim(emptyState(), a, T0).state
    const second = applyClaim(first, { ...a, task: 'task-b', session: 's2', paths: ['src/mms/net/NetService.ts', 'docs/'] }, T0 + 60_000)
    expect(second.ok).toBe(true)
    expect(second.warnings).toHaveLength(1)
    expect(second.warnings[0].paths).toEqual(['src/mms/net/NetService.ts'])
    expect(second.warnings[0].holder.task).toBe('task-a')
    const expiredHolder = applyClaim(first, { ...a, task: 'task-b', session: 's2' }, T0 + 5 * HOUR)
    expect(expiredHolder.warnings).toEqual([])
  })

  it('renews only your own claim and releases with force for another session', () => {
    const state = applyClaim(emptyState(), a, T0).state
    expect(applyRenew(state, { task: 'task-a', session: 's1', ttlMs: HOUR }, T0 + HOUR).claim.expiresAt).toBe('2026-11-17T12:00:00.000Z')
    expect(applyRenew(state, { task: 'task-a', session: 's2', ttlMs: HOUR }, T0)).toMatchObject({ ok: false, reason: 'held' })
    expect(applyRenew(state, { task: 'nope', session: 's1', ttlMs: HOUR }, T0)).toMatchObject({ ok: false, reason: 'missing' })
    expect(applyRelease(state, { task: 'task-a', session: 's2' }, T0)).toMatchObject({ ok: false, reason: 'held' })
    expect(applyRelease(state, { task: 'task-a', session: 's2', force: true }, T0).state.claims).toEqual([])
    expect(applyRelease(state, { task: 'task-a', session: 's1' }, T0)).toMatchObject({ ok: true, action: 'released' })
    expect(applyRelease(state, { task: 'gone', session: 's1' }, T0)).toMatchObject({ ok: true, changed: false })
  })

  it('drops claims a day after they expired and lists live ones', () => {
    const old = applyClaim(emptyState(), a, T0).state
    const later = applyClaim(old, { ...a, task: 'task-b', session: 's2', paths: [] }, T0 + 30 * HOUR)
    expect(later.state.claims.map((claim: { task: string }) => claim.task)).toEqual(['task-b'])
    expect(formatClaims(old, T0 + HOUR)).toContain('task-a  pc/s1  a  1h left  src/mms/net/')
    expect(formatClaims(old, T0 + 3 * HOUR)).toBe('no live claims')
    expect(formatClaims(old, T0 + 3 * HOUR, { all: true })).toContain('expired 1h ago')
  })
})

describe('claims branch on a remote', () => {
  let root: string
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

  function clone(name: string) {
    const dir = join(root, name)
    git(root, 'clone', '-q', join(root, 'remote.git'), dir)
    git(dir, 'config', 'user.name', 'Claim test')
    git(dir, 'config', 'user.email', 'claim-test@example.invalid')
    git(dir, 'config', 'commit.gpgsign', 'false')
    return dir
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'work-claim-test-'))
    git(root, 'init', '-q', '--bare', '--initial-branch=master', join(root, 'remote.git'))
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('creates the branch, refuses a second holder, and a dry run pushes nothing', async () => {
    const one = clone('one')
    const two = clone('two')
    const claim = (cwd: string, session: string, dryRun = false) => mutateClaims({
      remote: 'origin', cwd, dryRun, message: 'claim',
      change: (state: ReturnType<typeof emptyState>, now: number) => applyClaim(state, { ...a, session, paths: [] }, now)
    })
    const dry = await claim(one, 's1', true)
    expect(dry).toMatchObject({ ok: true, pushed: false })
    expect(git(one, 'ls-remote', 'origin', 'refs/heads/agent-claims')).toBe('')
    expect(await claim(one, 's1')).toMatchObject({ ok: true, pushed: true })
    expect(await claim(two, 's2')).toMatchObject({ ok: false, reason: 'held', pushed: false })
    expect((await listClaims({ remote: 'origin', cwd: two })).claims).toHaveLength(1)
    expect(git(join(root, 'remote.git'), 'log', '--format=%s', 'agent-claims')).toBe('claim')
  })

  it('retries from the fresh state when another writer pushes first', async () => {
    const one = clone('one')
    const two = clone('two')
    let raced = false
    const result = await mutateClaims({
      remote: 'origin', cwd: one, message: 'claim b',
      change: (state: ReturnType<typeof emptyState>, now: number) => {
        const next = applyClaim(state, { ...a, task: 'task-b', session: 's1', paths: [] }, now)
        if (!raced) {
          raced = true
          // Another session lands its claim between our read and our push.
          const module = new URL('../scripts/work-claim.mjs', import.meta.url).href
          execFileSync(process.execPath, ['--input-type=module', '-e', `
            import { mutateClaims, applyClaim } from ${JSON.stringify(module)}
            await mutateClaims({ remote: 'origin', cwd: ${JSON.stringify(two)}, message: 'claim c',
              change: (s, n) => applyClaim(s, { task: 'task-c', session: 's2', machine: 'mac', paths: [], ttlMs: 3600000 }, n) })
          `], { stdio: 'ignore' })
        }
        return next
      }
    })
    expect(result).toMatchObject({ ok: true, pushed: true, attempts: 2 })
    const tasks = (await listClaims({ remote: 'origin', cwd: two })).claims.map((claim: { task: string }) => claim.task)
    expect(tasks).toEqual(['task-b', 'task-c'])
  })

  it('reports an unreachable remote as an error, not as an empty claim list', async () => {
    const one = clone('one')
    writeFileSync(join(one, 'x'), 'x')
    await expect(listClaims({ remote: join(root, 'missing.git'), cwd: one })).rejects.toThrow()
  })
})
