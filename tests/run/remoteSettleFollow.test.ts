/**
 * Which answers of another computer end a settle watch on a thread there, and which are waited out (issue #1160,
 * docs/plans/agent-threads-architecture.md §4.2). `SettleNotices` over a real run database, with the routed reads stood
 * in for: every read fails with the row's code. The end-to-end cases run over two real daemons in
 * `tests/net/bridge/routed/settleNoticeRemote.test.ts`.
 *
 * Rows: not reached (offline, Bridge off here, slow), refused for good (blocked, sharing off, too old, agents here turned
 * off for that computer), and the thread deleted there.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RemoteThreadRefusal } from '../../src/mms/orchestrator/RemoteLaunchedThreads'
import { SettleNotices, type PlannedSettleNotice } from '../../src/mms/orchestrator/settleNotices'
import type { RemoteWatchReads } from '../../src/mms/orchestrator/remoteSettleFollow'
import { ProfileDatabase } from '../../src/mms/run/db/ProfileDatabase'
import { RunEngine } from '../../src/mms/run/RunEngine'
import { RunStore } from '../../src/mms/run/RunStore'

const NODE = 'nod_11111111111111111111111111'

describe('a settle watch on another computer: what ends it', () => {
  const homes: string[] = []
  const closers: Array<() => void> = []
  afterEach(() => {
    for (const close of closers.splice(0)) close()
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
  })

  const world = (fail: { code: string; details?: Record<string, unknown> } | 'no_reads' | 'denied') => {
    const home = mkdtempSync(join(tmpdir(), 'mousse-remote-settle-'))
    homes.push(home)
    const engine = new RunEngine({ store: new RunStore(new ProfileDatabase({ profileHome: home })), pid: 1 })
    const delivered: Array<{ notice: PlannedSettleNotice; held: boolean }> = []
    const refusal = typeof fail === 'object' ? new RemoteThreadRefusal(fail.code, `refused (${fail.code})`, 'Linux box', fail.details) : undefined
    const reads: RemoteWatchReads = {
      follow: vi.fn(async () => { throw refusal }),
      readThread: vi.fn(async () => { throw refusal })
    }
    const notices = new SettleNotices({
      engine,
      target: { getRun: () => null, continuationOf: () => undefined, queueRun: () => undefined, queueItemForRun: () => undefined, queueItem: () => undefined, activeRun: () => null },
      titleOf: () => undefined,
      threadLive: () => true,
      waitingForPerson: () => false,
      resultText: () => undefined,
      stopGeneration: () => 0,
      isSubagent: () => false,
      inPlan: () => false,
      deliver: (_threadId, notice, held) => { delivered.push({ notice, held }) },
      delivered: () => false,
      remote: {
        reads: () => (fail === 'no_reads' ? undefined : reads),
        launched: () => ({ computer: 'Linux box', title: 'Tests on Linux' }),
        denial: () => (fail === 'denied' ? { code: 'computer_not_allowed', message: 'turned off' } : undefined),
        sentHops: () => 1,
        retryMs: 20,
        maxRetryMs: 40
      }
    })
    closers.push(() => { notices.stop(); engine.store.db.close() })
    notices.start()
    const watch = notices.watch({ messageKey: 'thread_send:sender:1', watcherThreadId: 'sender', watcherRunId: 'run-s', targetThreadId: 'far', targetNode: NODE, runId: 'run:far:1' })
    return { notices, watch, delivered, reads }
  }

  it.each([
    ['offline', { code: 'computer_offline' }],
    ['slow', { code: 'computer_slow' }],
    ['Bridge off here', 'no_reads' as const]
  ])('%s: never an end; it keeps asking', async (_name, fail) => {
    const { notices, watch, delivered, reads } = world(fail)
    await new Promise((resolve) => setTimeout(resolve, 1_500))
    expect(delivered).toEqual([])
    expect(notices.watches.get(watch.watchId)).toMatchObject({ state: 'active', endNotice: null })
    expect(notices.remote!.following()).toContain(watch.watchId)
    if (fail !== 'no_reads') expect(vi.mocked(reads.readThread).mock.calls.length).toBeGreaterThan(1)
  })

  it.each([
    ['refused this device', { code: 'computer_not_shared', details: { reason: 'blocked' } }, 'unreachable:computer_not_shared:blocked', 'Linux box refused this device'],
    ['stopped sharing its threads', { code: 'computer_not_shared', details: { reason: 'setting_off' } }, 'unreachable:computer_not_shared:setting_off', 'works on threads is off on Linux box'],
    ['too old', { code: 'computer_outdated' }, 'unreachable:computer_outdated', 'Mousse on Linux box is too old'],
    ['agents here turned off for it', 'denied' as const, 'unreachable:computer_not_allowed', 'working on Linux box'],
    ['the thread deleted there', { code: 'remote_thread_gone' }, 'deleted', 'that thread was deleted']
  ])('%s: the watch ends with one notice that says so', async (_name, fail, status, words) => {
    const { notices, watch, delivered } = world(fail)
    await vi.waitFor(() => expect(delivered).toHaveLength(1))
    expect(delivered[0]!.held).toBe(false)
    expect(delivered[0]!.notice.item).toMatchObject({ event: 'ended', threadId: `${NODE}:far` })
    expect(delivered[0]!.notice.text).toContain(words)
    expect(delivered[0]!.notice.text).toContain(`mousse://thread/${NODE}:far`)
    expect(notices.watches.get(watch.watchId)).toMatchObject({ state: 'ended', endStatus: status, endNotice: 'sent' })
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(delivered).toHaveLength(1)
    expect(notices.remote!.following()).not.toContain(watch.watchId)
  })
})
