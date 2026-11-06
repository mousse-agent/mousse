/**
 * `ThreadExpiryService` (issue #672) with its daemon ports faked: when a thread is deleted, when it waits
 * for a run, when it stops one, and what it does after a refusal.
 */
import { describe, expect, it, vi } from 'vitest'
import { ThreadExpiryService, type ThreadExpiryDeps } from '../src/mms/lifecycle/ThreadExpiryService'
import type { Thread } from '../src/shared/types'

const NOW = Date.parse('2026-11-06T12:00:00.000Z')
const at = (offsetMs: number) => new Date(NOW + offsetMs).toISOString()
const thread = (id: string, patch: Partial<Thread> = {}): Thread => ({ id, name: id, createdAt: at(-1000), updatedAt: at(-1000), order: 0, ...patch })

function harness(threads: Thread[], options: { running?: Set<string>; failDelete?: (id: string) => Error | undefined; unfinished?: string[] } = {}) {
  let list = [...threads]
  const running = options.running ?? new Set<string>()
  const runEnd: Array<(threadId: string) => void> = []
  const timers: Array<{ run: () => void; ms: number }> = []
  const deleted: string[] = []
  const deps: ThreadExpiryDeps = {
    listThreads: () => list,
    // What a crash left half deleted, until this service deletes it.
    unfinished: () => (options.unfinished ?? []).filter((id) => !deleted.includes(id)),
    runInProgress: (id) => running.has(id),
    stop: vi.fn(async (id: string) => { running.delete(id) }),
    quiesce: vi.fn(),
    deleteForGood: vi.fn(async (id: string) => {
      const failure = options.failDelete?.(id)
      if (failure) throw failure
      deleted.push(id)
      list = list.filter((entry) => entry.id !== id)
    }),
    onRunEnd: (listener) => {
      runEnd.push(listener)
      return () => runEnd.splice(runEnd.indexOf(listener), 1)
    },
    now: () => NOW,
    timers: { setTimeout: (run, ms) => { timers.push({ run, ms }); return timers.length }, clearTimeout: () => undefined }
  }
  const service = new ThreadExpiryService(deps)
  return { service, deps, deleted, running, timers, endRun: (id: string) => { running.delete(id); runEnd.forEach((listener) => listener(id)) }, setList: (next: Thread[]) => { list = next } }
}

describe('thread expiry', () => {
  it('deletes a thread whose expiry passed, and only that one, on the first pass', async () => {
    const h = harness([thread('due', { expiresAt: at(-1) }), thread('later', { expiresAt: at(3_600_000) }), thread('never')])
    h.service.start()
    await h.service.pass()
    expect(h.deleted).toEqual(['due'])
    expect(h.deps.quiesce).toHaveBeenCalledWith('due')
    // The timer waits for the next expiry.
    expect(h.timers.at(-1)!.ms).toBe(3_600_000)
    await h.service.stop()
  })

  it('sleeps at most an hour, so a changed clock is noticed', async () => {
    const h = harness([thread('later', { expiresAt: at(3 * 24 * 3_600_000) })])
    h.service.start()
    await h.service.pass()
    expect(h.timers.at(-1)!.ms).toBe(3_600_000)
    await h.service.stop()
  })

  it('leaves a subagent to its root thread', async () => {
    const h = harness([thread('child', { expiresAt: at(-1), lineage: { parentThreadId: 'root', rootThreadId: 'root', relationship: 'subagent' } })])
    h.service.start()
    await h.service.pass()
    expect(h.deleted).toEqual([])
    await h.service.stop()
  })

  it('waits for a run in progress to end, then deletes', async () => {
    const h = harness([thread('busy', { expiresAt: at(-1) })], { running: new Set(['busy']) })
    h.service.start()
    await h.service.pass()
    expect(h.deleted).toEqual([])
    expect(h.deps.stop).not.toHaveBeenCalled()
    // A question or approval the run waits on ends at once, so the run can end.
    expect(h.deps.quiesce).toHaveBeenCalledWith('busy')
    // It is tried again within a minute, and at once when the run ends.
    expect(h.timers.at(-1)!.ms).toBe(60_000)
    h.endRun('busy')
    await h.service.pass()
    expect(h.deleted).toEqual(['busy'])
    await h.service.stop()
  })

  it('stops a run in progress when the thread was set to', async () => {
    const h = harness([thread('busy', { expiresAt: at(-1), expiryStopsRun: true })], { running: new Set(['busy']) })
    h.service.start()
    await h.service.pass()
    expect(h.deps.stop).toHaveBeenCalledWith('busy')
    expect(h.deleted).toEqual(['busy'])
    await h.service.stop()
  })

  it('tries a refused delete again, and finishes a delete a crash left in the trash', async () => {
    let refuse = true
    const h = harness([thread('refused', { expiresAt: at(-1) })], { failDelete: (id) => (refuse && id === 'refused' ? new Error('busy') : undefined), unfinished: ['in-trash'] })
    h.service.start()
    await h.service.pass()
    expect(h.deleted).toEqual(['in-trash'])
    expect(h.timers.at(-1)!.ms).toBe(60_000)
    refuse = false
    await h.service.pass()
    expect(h.deleted).toEqual(['in-trash', 'refused'])
    await h.service.stop()
  })

  it('stops waiting for a thread whose expiry was removed', async () => {
    const h = harness([thread('busy', { expiresAt: at(-1) })], { running: new Set(['busy']) })
    h.service.start()
    await h.service.pass()
    h.setList([thread('busy')])
    h.service.reschedule()
    await h.service.pass()
    h.endRun('busy')
    await h.service.pass()
    expect(h.deleted).toEqual([])
    await h.service.stop()
  })
})
