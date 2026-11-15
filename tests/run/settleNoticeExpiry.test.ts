/**
 * A settle watch lasts 24 hours (SPEC §15.1): then the sender is told once, without being woken, that the work is still
 * going, and nothing more is told about that message. `SettleNotices` over a real run database, with the clock and
 * the sender's queue stood in for.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SettleNotices, type PlannedSettleNotice } from '../../src/mms/orchestrator/settleNotices'
import { ProfileDatabase } from '../../src/mms/run/db/ProfileDatabase'
import { RunEngine } from '../../src/mms/run/RunEngine'
import { RunStore } from '../../src/mms/run/RunStore'
import { writeTerminalRun } from '../../src/mms/run/terminal'

describe('a settle watch\'s 24 hours', () => {
  const homes: string[] = []
  const closers: Array<() => void> = []
  afterEach(() => {
    for (const close of closers.splice(0)) close()
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
  })

  it('tells the sender once, held, that the work is still going; the work\'s later end tells it nothing more', async () => {
    const home = mkdtempSync(join(tmpdir(), 'mousse-settle-expiry-'))
    homes.push(home)
    const engine = new RunEngine({ store: new RunStore(new ProfileDatabase({ profileHome: home })), pid: 1 })
    let now = new Date('2026-11-15T10:00:00Z')
    const delivered: Array<{ notice: PlannedSettleNotice; held: boolean }> = []
    const notices = new SettleNotices({
      engine,
      target: {
        getRun: (runId) => engine.getRun(runId),
        continuationOf: () => undefined,
        queueRun: () => undefined,
        queueItemForRun: () => undefined,
        queueItem: () => undefined,
        activeRun: (threadId) => engine.getActiveRun(threadId)
      },
      titleOf: () => 'Long work',
      threadLive: () => true,
      waitingForPerson: () => false,
      resultText: () => 'done',
      stopGeneration: () => 0,
      isSubagent: () => false,
      inPlan: () => false,
      deliver: (_threadId, notice, held) => { delivered.push({ notice, held }) },
      delivered: () => false,
      now: () => now
    })
    closers.push(() => { notices.stop(); engine.store.db.close() })
    notices.start()
    const run = engine.store.createRun({ threadId: 'target', source: 'mcp' })
    const watch = notices.watch({ messageKey: 'thread_send:sender:1', watcherThreadId: 'sender', watcherRunId: 'run-s', targetThreadId: 'target', runId: run.runId })

    now = new Date(now.getTime() + 23 * 60 * 60 * 1000)
    notices.expireDue()
    expect(delivered).toEqual([])

    now = new Date(now.getTime() + 2 * 60 * 60 * 1000)
    notices.expireDue()
    notices.expireDue()
    expect(delivered).toHaveLength(1)
    expect(delivered[0]).toMatchObject({ held: true, notice: { item: { event: 'expired', threadId: 'target', watchId: watch.watchId } } })
    expect(delivered[0]!.notice.text).toContain('still going')

    // The work ends later: the watch is over, so the sender hears nothing more.
    engine.store.db.transaction(() => writeTerminalRun(engine.store, engine.getRun(run.runId)!, engine.getRun(run.runId)!.epoch, 'completed', undefined, now.toISOString()))
    notices.touch('target')
    await new Promise((resolve) => setImmediate(resolve))
    expect(delivered).toHaveLength(1)
    expect(notices.watches.get(watch.watchId)).toMatchObject({ state: 'expired', endNotice: 'sent' })
  })
})
