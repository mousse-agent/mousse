import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  readLeaseOwner,
  getExecutionLeasePath,
  releaseExecutionLeaseHandle,
  resetHeldLeaseTokensForTests,
  tryAcquireExecutionLease,
  type ThreadLeaseHandle
} from '../src/mms/queue/ThreadExecutionLease'
import { assertHeldThreadLease } from '../src/mms/actions/GitOperationCoordinator'
import { ThreadTerminalWriters, type TerminalTurnEnd, type TerminalWriterStart } from '../src/mms/terminals/threadTerminalWriter'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'terminal-writer-'))
})

afterEach(() => {
  resetHeldLeaseTokensForTests()
  rmSync(dir, { recursive: true, force: true })
})

/** A start over the real lease file of `dir`, recording the turns it begins and ends. */
function realStart(opts: { begin?: () => Promise<void>; checkpoint?: (end: TerminalTurnEnd) => Promise<void>; admit?: () => void } = {}) {
  const ends: TerminalTurnEnd[] = []
  let begun = 0
  const start: TerminalWriterStart = {
    acquire: () => tryAcquireExecutionLease(dir, { source: 'task-terminal' }),
    busy: () => Object.assign(new Error('Task writer is busy'), { code: 'workspace_busy' }),
    begin: async () => {
      begun += 1
      await opts.begin?.()
      return async (end) => { ends.push(end); await opts.checkpoint?.(end) }
    },
    release: (lease: ThreadLeaseHandle) => { releaseExecutionLeaseHandle(lease) },
    admit: (lease) => { opts.admit?.(); assertHeldThreadLease(dir, lease) }
  }
  return { start, ends, begun: () => begun }
}

const held = () => readLeaseOwner(getExecutionLeasePath(dir)) !== null

describe('one writer hold for a thread’s terminals', () => {
  it('lets a second terminal join the first one’s lease and turn', async () => {
    const writers = new ThreadTerminalWriters()
    const s = realStart()
    const first = await writers.join(dir, s.start)
    const second = await writers.join(dir, s.start)
    expect(second.lease).toBe(first.lease)
    expect(s.begun()).toBe(1)
    expect(writers.members(dir)).toBe(2)
  })

  it('keeps the lease and the first terminal’s ownership when the second ends', async () => {
    const writers = new ThreadTerminalWriters()
    const s = realStart()
    const first = await writers.join(dir, s.start)
    first.started()
    const second = await writers.join(dir, s.start)
    second.started()
    await second.leave()
    // The first terminal's heartbeat check still passes: the lease is its own and nothing was checkpointed.
    expect(() => assertHeldThreadLease(dir, first.lease)).not.toThrow()
    expect(s.ends).toEqual([])
    expect(held()).toBe(true)
    await first.leave()
    expect(s.ends).toEqual(['completed'])
    expect(held()).toBe(false)
  })

  it('ends the turn once, when the last terminal ends, whichever order they end in', async () => {
    const writers = new ThreadTerminalWriters()
    const s = realStart()
    const first = await writers.join(dir, s.start)
    const second = await writers.join(dir, s.start)
    first.started()
    await first.leave()
    await first.leave()
    expect(held()).toBe(true)
    await second.leave()
    expect(s.ends).toEqual(['completed'])
    expect(held()).toBe(false)
  })

  it('refuses every terminal while another writer holds the lease', async () => {
    const turn = tryAcquireExecutionLease(dir, { source: 'turn' })
    expect(turn).not.toBeNull()
    const writers = new ThreadTerminalWriters()
    const s = realStart()
    await expect(writers.join(dir, s.start)).rejects.toMatchObject({ code: 'workspace_busy' })
    await expect(writers.join(dir, s.start)).rejects.toMatchObject({ code: 'workspace_busy' })
    expect(s.begun()).toBe(0)
  })

  it('keeps other writers out while any terminal of the thread runs', async () => {
    const writers = new ThreadTerminalWriters()
    const s = realStart()
    const first = await writers.join(dir, s.start)
    const second = await writers.join(dir, s.start)
    await first.leave()
    expect(tryAcquireExecutionLease(dir, { source: 'turn' })).toBeNull()
    await second.leave()
    expect(tryAcquireExecutionLease(dir, { source: 'turn' })).not.toBeNull()
  })

  it('lets a terminal opened at the same moment join, instead of finding the lease busy', async () => {
    const writers = new ThreadTerminalWriters()
    let open!: () => void
    const s = realStart({ begin: () => new Promise<void>((resolve) => { open = resolve }) })
    const firstJoin = writers.join(dir, s.start)
    const secondJoin = writers.join(dir, s.start)
    open()
    const [first, second] = await Promise.all([firstJoin, secondJoin])
    expect(second.lease).toBe(first.lease)
    expect(s.begun()).toBe(1)
  })

  it('does not end the hold under a terminal still joining when the first one exits', async () => {
    const writers = new ThreadTerminalWriters()
    let open!: () => void
    const s = realStart({ begin: () => new Promise<void>((resolve) => { open = resolve }) })
    const firstJoin = writers.join(dir, s.start)
    const secondJoin = writers.join(dir, s.start)
    open()
    const first = await firstJoin
    await first.leave()
    const second = await secondJoin
    expect(held()).toBe(true)
    expect(() => assertHeldThreadLease(dir, second.lease)).not.toThrow()
    await second.leave()
    expect(held()).toBe(false)
  })

  it('gives the lease back when the turn cannot begin, and refuses the terminals waiting on it', async () => {
    const writers = new ThreadTerminalWriters()
    let fail!: (error: Error) => void
    const s = realStart({ begin: () => new Promise<void>((_resolve, reject) => { fail = reject }) })
    const firstJoin = writers.join(dir, s.start)
    const secondJoin = writers.join(dir, s.start)
    fail(new Error('git failed'))
    await expect(firstJoin).rejects.toThrow('git failed')
    await expect(secondJoin).rejects.toThrow('git failed')
    expect(held()).toBe(false)
    expect(s.ends).toEqual([])
    expect(writers.members(dir)).toBe(0)
  })

  it('checkpoints the turn as failed when no shell ever started, and releases the lease', async () => {
    const writers = new ThreadTerminalWriters()
    const s = realStart()
    const first = await writers.join(dir, s.start)
    await first.leave()
    expect(s.ends).toEqual(['failed'])
    expect(held()).toBe(false)
  })

  it('ends the hold when a joining terminal that fails to start is the last one left', async () => {
    const writers = new ThreadTerminalWriters()
    const s = realStart()
    const first = await writers.join(dir, s.start)
    first.started()
    const second = await writers.join(dir, s.start)
    await first.leave()
    await second.leave()
    expect(s.ends).toEqual(['completed'])
    expect(held()).toBe(false)
  })

  it('refuses a joining terminal the thread no longer admits, and keeps the others', async () => {
    const writers = new ThreadTerminalWriters()
    let admits = true
    const s = realStart({ admit: () => { if (!admits) throw new Error('Thread is being deleted') } })
    const first = await writers.join(dir, s.start)
    admits = false
    await expect(writers.join(dir, s.start)).rejects.toThrow('Thread is being deleted')
    expect(writers.members(dir)).toBe(1)
    expect(held()).toBe(true)
    await first.leave()
    expect(held()).toBe(false)
  })

  it('starts a fresh hold for a terminal opened while the last one’s turn is being checkpointed', async () => {
    const writers = new ThreadTerminalWriters()
    let finish!: () => void
    let checkpoints = 0
    const s = realStart({ checkpoint: () => (checkpoints++ === 0 ? new Promise<void>((resolve) => { finish = resolve }) : Promise.resolve()) })
    const first = await writers.join(dir, s.start)
    first.started()
    const leaving = first.leave()
    const next = writers.join(dir, s.start)
    finish()
    await leaving
    const fresh = await next
    expect(fresh.lease).not.toBe(first.lease)
    expect(s.begun()).toBe(2)
    expect(() => assertHeldThreadLease(dir, fresh.lease)).not.toThrow()
    await fresh.leave()
  })

  it('refuses a terminal when the last one’s checkpoint does not finish in time', async () => {
    vi.useFakeTimers()
    try {
      const writers = new ThreadTerminalWriters(1_000)
      const s = realStart({ checkpoint: () => new Promise<void>(() => undefined) })
      const first = await writers.join(dir, s.start)
      void first.leave()
      const next = writers.join(dir, s.start)
      const refused = expect(next).rejects.toMatchObject({ code: 'workspace_busy' })
      await vi.advanceTimersByTimeAsync(1_000)
      await refused
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps holds of different callers apart: the lease lets only one of them write', async () => {
    const writers = new ThreadTerminalWriters()
    const s = realStart()
    const local = await writers.join(`${dir}|local`, s.start)
    await expect(writers.join(`${dir}|node:laptop`, s.start)).rejects.toMatchObject({ code: 'workspace_busy' })
    await local.leave()
    const remote = await writers.join(`${dir}|node:laptop`, s.start)
    await remote.leave()
  })
})
