/**
 * A delayed kill of a process Mousse started (`reapProcessTree` with `root`) never reaches another program given its pid:
 * a process its handle shows exited is not killed, a pid whose creation time is not the anchored one is left alone, and
 * on Windows only the descendants found by identity (parent with the same creation time, created after it) are killed.
 * Everything here is a stand-in: no real process is listed or killed.
 */
import { describe, expect, it, vi } from 'vitest'
import { reapProcessTree, type SpawnedRoot } from '../../src/mms/harness/stopProcesses'
import type { ProcessEntry } from '../../src/mms/git/stoppedGitTree'

const ROOT = 4100
const SPAWNED_AT = Date.parse('2026-11-10T10:00:00.000Z')
const entry = (pid: number, ppid: number, startedMs: number): ProcessEntry => ({ pid, ppid, started: String(startedMs), startedMs })

describe('reapProcessTree of a process Mousse started', () => {
  it('kills nothing when the process exits during the grace, even with its pid given to another program', async () => {
    let exited = false
    setTimeout(() => { exited = true }, 30)
    const kill = vi.fn()
    const killPid = vi.fn()
    const table = vi.fn(async () => [entry(ROOT, 1, SPAWNED_AT + 600_000)])
    const root: SpawnedRoot = { spawnedAt: SPAWNED_AT, exited: () => exited, kill }
    // The pid answers (another program has it now); the handle says the process Mousse started is gone.
    const outcome = await reapProcessTree(ROOT, { platform: 'win32', graceMs: 2_000, root, alive: () => true, table, killPid })
    expect(outcome).toBe('ended')
    expect(kill).not.toHaveBeenCalled()
    expect(killPid).not.toHaveBeenCalled()
    expect(table).not.toHaveBeenCalled()
  })

  it('kills nothing off Windows either once the handle shows the process exited', async () => {
    let exited = false
    setTimeout(() => { exited = true }, 30)
    const killTree = vi.fn()
    const outcome = await reapProcessTree(ROOT, { platform: 'linux', graceMs: 2_000, root: { spawnedAt: SPAWNED_AT, exited: () => exited }, alive: () => true, killTree })
    expect(outcome).toBe('ended')
    expect(killTree).not.toHaveBeenCalled()
  })

  it('leaves a reused pid alone: its creation time is not the anchored one', async () => {
    const kill = vi.fn()
    const killPid = vi.fn()
    const killTree = vi.fn()
    // The handle cannot tell (an SDK without exit status); the pid answers, with a process created a minute later.
    const root: SpawnedRoot = { spawnedAt: SPAWNED_AT, exited: () => undefined, kill }
    const table = async () => [entry(ROOT, 1, SPAWNED_AT + 60_000), entry(ROOT + 1, ROOT, SPAWNED_AT + 61_000)]
    for (const platform of ['win32', 'linux'] as const) {
      expect(await reapProcessTree(ROOT, { platform, graceMs: 20, root, alive: () => true, table, killPid, killTree })).toBe('ended')
    }
    expect(kill).not.toHaveBeenCalled()
    expect(killPid).not.toHaveBeenCalled()
    expect(killTree).not.toHaveBeenCalled()
  })

  it('kills the process and only the descendants that are its own, by parent identity and creation order', async () => {
    let exited = false
    const killed = new Set<number>()
    const kill = vi.fn(() => { exited = true })
    const killPid = vi.fn((pid: number) => { killed.add(pid) })
    const root: SpawnedRoot = { spawnedAt: SPAWNED_AT, exited: () => exited, kill }
    const table = async () => [
      entry(ROOT, 1, SPAWNED_AT + 50),
      // A shell the process started, and a command below it.
      entry(5001, ROOT, SPAWNED_AT + 1_000),
      entry(5002, 5001, SPAWNED_AT + 1_500),
      // A program whose old parent had the pid before: Windows keeps its parent pid, but it was created first.
      entry(5003, ROOT, SPAWNED_AT - 90_000),
      // Below a parent that is not in the tree.
      entry(5004, 5003, SPAWNED_AT + 2_000)
    ]
    const outcome = await reapProcessTree(ROOT, { platform: 'win32', graceMs: 20, settleMs: 200, root, alive: (pid) => pid === ROOT ? !exited : !killed.has(pid), table, killPid })
    expect(outcome).toBe('killed')
    expect(killPid.mock.calls.map(([pid]) => pid)).toEqual([5001, 5002])
    // The process itself is killed through its handle, never by its pid.
    expect(kill).toHaveBeenCalledTimes(1)
  })

  it('skips a descendant whose pid was given to another program between the list and its kill, and starts every kill at once', async () => {
    let exited = false
    const kill = vi.fn(() => { exited = true })
    const snapshot = [entry(ROOT, 1, SPAWNED_AT + 50), entry(5001, ROOT, SPAWNED_AT + 1_000), entry(5002, ROOT, SPAWNED_AT + 1_200), entry(5003, ROOT, SPAWNED_AT + 1_400)]
    // Read again right before the kills: 5002 is now another program, created since; 5003 is gone.
    const fresh = [entry(ROOT, 1, SPAWNED_AT + 50), entry(5001, ROOT, SPAWNED_AT + 1_000), entry(5002, 77, SPAWNED_AT + 30_000)]
    const table = vi.fn().mockResolvedValueOnce(snapshot).mockResolvedValueOnce(fresh)
    // Each kill takes as long as it likes: none waits for another before it starts.
    const pending: Array<() => void> = []
    const killPid = vi.fn((_pid: number) => new Promise<void>((resolve) => { pending.push(resolve) }))
    const reaped = reapProcessTree(ROOT, { platform: 'win32', graceMs: 20, settleMs: 200, root: { spawnedAt: SPAWNED_AT, exited: () => exited, kill }, alive: (target) => target === ROOT ? !exited : false, table, killPid })
    await vi.waitFor(() => expect(kill).toHaveBeenCalledTimes(1))
    expect(killPid.mock.calls.map(([target]) => target)).toEqual([5001])
    expect(table).toHaveBeenCalledTimes(2)
    for (const resolve of pending) resolve()
    expect(await reaped).toBe('killed')
  })

  it('kills every confirmed descendant without waiting for one kill to end before the next starts', async () => {
    let exited = false
    const snapshot = [entry(ROOT, 1, SPAWNED_AT + 50), entry(5001, ROOT, SPAWNED_AT + 1_000), entry(5002, 5001, SPAWNED_AT + 1_100), entry(5003, ROOT, SPAWNED_AT + 1_200)]
    const pending: Array<() => void> = []
    const killPid = vi.fn((_pid: number) => new Promise<void>((resolve) => { pending.push(resolve) }))
    const reaped = reapProcessTree(ROOT, { platform: 'win32', graceMs: 20, settleMs: 200, root: { spawnedAt: SPAWNED_AT, exited: () => exited, kill: () => { exited = true } }, alive: (target) => target === ROOT ? !exited : false, table: async () => snapshot, killPid })
    // All three are under way while none has ended.
    await vi.waitFor(() => expect(killPid).toHaveBeenCalledTimes(3))
    expect(killPid.mock.calls.map(([target]) => target).sort()).toEqual([5001, 5002, 5003])
    for (const resolve of pending) resolve()
    expect(await reaped).toBe('killed')
  })

  it('kills only the process, through its handle, when the list cannot be read', async () => {
    let exited = false
    const kill = vi.fn(() => { exited = true })
    const killPid = vi.fn()
    const killTree = vi.fn()
    const outcome = await reapProcessTree(ROOT, { platform: 'win32', graceMs: 20, root: { spawnedAt: SPAWNED_AT, exited: () => exited, kill }, alive: () => !exited, table: async () => undefined, killPid, killTree })
    expect(outcome).toBe('killed')
    // Without a list no descendant is known for certain: nothing is killed by pid, and no kill follows parent links.
    expect(kill).toHaveBeenCalledTimes(1)
    expect(killPid).not.toHaveBeenCalled()
    expect(killTree).not.toHaveBeenCalled()
  })
})
