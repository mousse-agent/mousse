/**
 * How a due wake-up reaches its thread: through the inbox, as agents' notes and monitor events do. An idle thread starts
 * a turn no person started; it waits while the thread waits on a person's answer; a quiet one (a Stop's word) never
 * starts a turn; the same wake posted twice is taken once. The notice row shows the brief.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { planWakeNotice } from '../../src/mms/run/delegation/notice'
import { postNote } from '../../src/mms/run/mcp/appTools/threadNotes'
import type { ThreadEvent } from '../../src/mms/run/types'
import { ThreadWakes } from '../../src/mms/wakes/ThreadWakes'
import { delegationFixture, type DelegationFixture } from '../run/delegationFixture'

describe('thread wake-up delivery', () => {
  let fx: DelegationFixture | undefined
  let dir: string | undefined
  afterEach(() => {
    fx?.dispose()
    fx = undefined
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = undefined
  })

  /** An idle thread (a finished subagent's) with a wake service that posts as the daemon's does. */
  const setup = async () => {
    fx = delegationFixture()
    const f = fx
    const parentRun = await f.runningRun('parent')
    const child = await f.delegate(parentRun.runId, 'c1', { title: 'Worker' })
    f.finish(child.childRunId, 'done')
    f.engine.inbox.markAcknowledged(f.engine.inbox.listPending('parent').map((row) => row.inboxId))
    const threadId = child.childThreadId
    dir = mkdtempSync(join(tmpdir(), 'mousse-thread-wake-delivery-'))
    let now = Date.parse('2026-11-20T10:00:00.000Z')
    let fire: (() => void) | undefined
    const wakes = new ThreadWakes({
      file: join(dir, 'thread-wakes.json'),
      post: (thread, payload, key) => { postNote(f.engine, key, payload, thread) },
      threadState: () => ({ state: 'deleted' }),
      pullRequestState: async () => ({ none: true }),
      personLastWroteAt: () => undefined,
      threadExists: () => true,
      now: () => now,
      setTimer: (callback) => {
        fire = callback
        return 0 as unknown as ReturnType<typeof setTimeout>
      },
      clearTimer: () => { fire = undefined }
    })
    wakes.start()
    const rows = () => f.engine.inbox.listForThread(threadId).filter((row) => (row.payload as { kind?: string }).kind === 'thread_wake')
    const wakeRuns = () => f.engine.listRuns(threadId).filter((run) => run.source === 'wake')
    const settle = async () => {
      for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve))
    }
    /** The clock reaches the wake's time and the timer runs. */
    const due = async (ms: number) => {
      await settle()
      now += ms
      fire?.()
      await settle()
    }
    return { f, threadId, wakes, rows, wakeRuns, due, settle }
  }

  it('a due wake starts a turn on its idle thread, and its notice shows the brief', async () => {
    const { f, threadId, wakes, rows, wakeRuns, due } = await setup()
    await wakes.add(threadId, { brief: 'See whether the nightly passed', dueAt: '2026-11-20T10:02:00.000Z' })
    await due(2 * 60_000)
    expect(rows().map((row) => row.status)).toEqual(['pending'])
    // The same wake posted again (a crash between posting and saving) is taken once.
    const [row] = rows()
    expect(postNote(f.engine, `thread-wake:${(row!.payload as { wakeId: string }).wakeId}`, row!.payload as never, threadId).replayed).toBe(true)
    f.reconciler.runOnce()
    expect(wakeRuns()).toHaveLength(1)
    expect(rows().map((r) => r.status)).toEqual(['delivered'])
    const planned = planWakeNotice(rows())
    expect(planned.text).toContain('<mousse_notice kind="thread_wake"')
    expect(planned.text).toContain('What you wrote for yourself: See whether the nightly passed')
    expect(planned.items).toEqual([expect.objectContaining({ event: 'wake', childThreadId: threadId, wake: { brief: 'See whether the nightly passed' } })])
  })

  it('waits while the thread waits on a person\'s answer, then starts its turn', async () => {
    const { f, threadId, wakes, rows, wakeRuns, due, settle } = await setup()
    f.awaiting.add(threadId)
    await wakes.add(threadId, { brief: 'Carry on with the migration', dueAt: '2026-11-20T10:01:00.000Z' })
    await due(60_000)
    f.reconciler.runOnce()
    expect(rows().map((row) => row.status)).toEqual(['pending'])
    expect(wakeRuns()).toEqual([])
    f.awaiting.delete(threadId)
    let live = true
    const kick = (change: ThreadEvent): void => {
      if (change.type === 'inbox.status') setImmediate(() => live && f.reconciler.runOnce())
    }
    f.engine.on('event', kick)
    try {
      f.reconciler.runOnce()
      await settle()
      expect(wakeRuns()).toHaveLength(1)
    } finally {
      live = false
      f.engine.off('event', kick)
    }
  })

  it('a Stop\'s word that wake-ups were cancelled never starts a turn; it rides with the next one', async () => {
    const { f, threadId, wakes, rows, wakeRuns } = await setup()
    await wakes.add(threadId, { brief: 'Later', dueAt: '2026-11-20T11:00:00.000Z' })
    wakes.stopThread(threadId, true, 'the thread was stopped')
    f.reconciler.runOnce()
    expect(rows().map((row) => row.status)).toEqual(['pending'])
    expect(wakeRuns()).toEqual([])
  })
})
