import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MousseConfigStore } from '../src/mms/config/MousseConfigStore'
import { ScheduledJobStore } from '../src/mms/scheduled/ScheduledJobStore'
import { buildAutomationIndex } from '../src/mms/automations/AutomationIndex'
import { eventKindsOf, OWN_RUN_GRACE_MS, ownRunWindows, splitOwnEvents, ThreadEventTriggers } from '../src/mms/automations/threadEventTriggers'
import { asCreateScheduledJobInput, asScheduledJobPatch } from '../src/mms/protocol/validators'
import { THREAD_EVENT_MIN_GAP_MS, threadEventChoice, threadEventOccurrenceKey, threadEventsOfOccurrence, threadEventText } from '../src/shared/threadEvents'
import type { ScheduledJob, Thread } from '../src/shared/types'

const MINUTE = 60_000
const T0 = Date.parse('2026-11-09T10:00:00.000Z')
const iso = (ms: number) => new Date(T0 + ms).toISOString()

function job(patch: Partial<ScheduledJob> = {}): ScheduledJob {
  return {
    id: 'j1',
    name: 'Address reviews',
    prompt: 'Address the review comments',
    schedule: { kind: 'manual' },
    enabled: true,
    state: 'scheduled',
    nextRunAt: null,
    threadId: 't-pr',
    trigger: { threadEvent: { threadId: 't-pr', number: 712, events: ['review', 'comment'] } },
    createdAt: iso(-86_400_000),
    updatedAt: iso(-86_400_000),
    ...patch
  }
}

describe('thread events in words', () => {
  it('names what wakes it, and carries the events in the run\'s occurrence key', () => {
    expect(threadEventText(712, ['review'])).toBe('#712 gets a review')
    expect(threadEventText(712, ['checks_failed'])).toBe('#712 checks fail')
    expect(threadEventText(712, ['comment', 'review'])).toBe('#712: review, comment')
    expect(threadEventText(712, ['checks_failed', 'checks_passed', 'review', 'comment'])).toBe('#712 gets activity')
    expect(threadEventChoice(['comment', 'review', 'checks_passed', 'checks_failed'])).toBe('any')
    const key = threadEventOccurrenceKey(iso(0), ['review', 'checks_failed'])
    expect(threadEventsOfOccurrence(key)).toEqual(['checks_failed', 'review'])
    expect(threadEventsOfOccurrence('webhook:x')).toBeUndefined()
    expect(threadEventsOfOccurrence(iso(0))).toBeUndefined()
  })
})

describe('the event mapping', () => {
  it('takes the watch\'s change kinds as events and drops the rest', () => {
    expect(eventKindsOf(['checks_failed', 'review'])).toEqual(['checks_failed', 'review'])
    expect(eventKindsOf(['checks_passed', 'comment'])).toEqual(['checks_passed', 'comment'])
    expect(eventKindsOf(['ended:merged'])).toEqual([])
  })

  it('wakes only the automations on that thread whose events match', () => {
    const queue = vi.fn()
    const jobs = [
      job(),
      job({ id: 'j2', trigger: { threadEvent: { threadId: 't-pr', number: 712, events: ['checks_failed'] } } }),
      job({ id: 'j3', trigger: { threadEvent: { threadId: 't-other', number: 9, events: ['review'] } } }),
      job({ id: 'j4', trigger: undefined })
    ]
    const triggers = new ThreadEventTriggers({ jobs: () => jobs, queue, now: () => T0 })
    triggers.onUpdated({ threadId: 't-pr', number: 712, changes: ['review'], viewer: 'me', remarks: [{ kind: 'review', author: 'maria', at: T0 }] })
    expect(queue.mock.calls).toEqual([['j1', ['review']]])
    queue.mockClear()
    triggers.onUpdated({ threadId: 't-pr', number: 712, changes: ['ended:merged'] })
    expect(queue).not.toHaveBeenCalled()
  })
})

describe('self-event filtering', () => {
  const during = [{ start: T0, end: T0 + 5 * MINUTE }]

  it('ignores its own comment or review made during its run or just after, never a teammate\'s', () => {
    expect(splitOwnEvents({ kinds: ['comment'], remarks: [{ kind: 'comment', author: 'Me', at: T0 + MINUTE }], viewer: 'me', headFirstSeenAt: undefined, windows: during }))
      .toEqual({ wake: [], own: [{ kind: 'comment', reason: 'its own comment' }] })
    expect(splitOwnEvents({ kinds: ['review'], remarks: [{ kind: 'review', author: 'me', at: T0 + 5 * MINUTE + OWN_RUN_GRACE_MS - 1 }], viewer: 'me', headFirstSeenAt: undefined, windows: during }).own).toHaveLength(1)
    // A teammate's comment during the run, or the person's own long after it, wakes it.
    expect(splitOwnEvents({ kinds: ['comment'], remarks: [{ kind: 'comment', author: 'me', at: T0 + MINUTE }, { kind: 'comment', author: 'maria', at: T0 + 2 * MINUTE }], viewer: 'me', headFirstSeenAt: undefined, windows: during }).wake).toEqual(['comment'])
    expect(splitOwnEvents({ kinds: ['comment'], remarks: [{ kind: 'comment', author: 'me', at: T0 + 30 * MINUTE }], viewer: 'me', headFirstSeenAt: undefined, windows: during }).wake).toEqual(['comment'])
  })

  it('ignores checks on a head first seen during its run (its push), and wakes on checks of any other head', () => {
    expect(splitOwnEvents({ kinds: ['checks_failed'], remarks: [], viewer: 'me', headFirstSeenAt: T0 + 3 * MINUTE, windows: during }))
      .toEqual({ wake: [], own: [{ kind: 'checks_failed', reason: 'its own push' }] })
    expect(splitOwnEvents({ kinds: ['checks_passed'], remarks: [], viewer: 'me', headFirstSeenAt: T0 - MINUTE, windows: during }).wake).toEqual(['checks_passed'])
    expect(splitOwnEvents({ kinds: ['checks_passed'], remarks: [], viewer: 'me', headFirstSeenAt: undefined, windows: during }).wake).toEqual(['checks_passed'])
  })

  it('reads its runs\' times from their records and the run under way', () => {
    const windows = ownRunWindows(job({
      runHistory: [{ runAt: iso(0), status: 'ok', startedAt: iso(-2 * MINUTE), endedAt: iso(0) }, { runAt: iso(MINUTE), status: 'queued', startedAt: iso(MINUTE) }],
      runClaim: { pid: 1, processInstanceId: 'p', token: 't', claimedAt: iso(10 * MINUTE), heartbeatAt: iso(10 * MINUTE), occurrenceKey: 'k' }
    }), T0 + 12 * MINUTE)
    expect(windows).toEqual([
      { start: T0 - 2 * MINUTE, end: T0 },
      { start: T0 + MINUTE, end: T0 + 12 * MINUTE },
      { start: T0 + 10 * MINUTE, end: T0 + 12 * MINUTE }
    ])
  })

  it('end to end: a push its run made and the checks on it do not wake it again; a later push does', () => {
    const queue = vi.fn()
    let now = T0 + 2 * MINUTE
    const ran = job({ trigger: { threadEvent: { threadId: 't-pr', number: 712, events: ['checks_failed'] } }, runHistory: [{ runAt: iso(4 * MINUTE), status: 'ok', startedAt: iso(0), endedAt: iso(4 * MINUTE) }] })
    const triggers = new ThreadEventTriggers({ jobs: () => [ran], queue, now: () => now })
    triggers.onRead({ threadId: 't-pr', headSha: 'b', previousHead: 'a', at: T0 + 3 * MINUTE })
    now = T0 + 20 * MINUTE
    triggers.onUpdated({ threadId: 't-pr', number: 712, changes: ['checks_failed'], headSha: 'b', viewer: 'me', remarks: [] })
    expect(queue).toHaveBeenLastCalledWith('j1', ['checks_failed'], { own: 'its own push' })
    triggers.onRead({ threadId: 't-pr', headSha: 'c', previousHead: 'b', at: T0 + 60 * MINUTE })
    now = T0 + 70 * MINUTE
    triggers.onUpdated({ threadId: 't-pr', number: 712, changes: ['checks_failed'], headSha: 'c', viewer: 'me', remarks: [] })
    expect(queue).toHaveBeenLastCalledWith('j1', ['checks_failed'])
  })
})

describe('the rate limit and the event slot', () => {
  let home: string
  let previousHome: string | undefined
  let store: ScheduledJobStore
  beforeEach(() => {
    previousHome = process.env.MOUSSE_HOME
    home = mkdtempSync(join(tmpdir(), 'mousse-thread-events-'))
    process.env.MOUSSE_HOME = home
    store = new ScheduledJobStore(MousseConfigStore.load(home))
  })
  afterEach(() => {
    if (previousHome === undefined) delete process.env.MOUSSE_HOME
    else process.env.MOUSSE_HOME = previousHome
    rmSync(home, { recursive: true, force: true })
  })

  const create = () => store.createJob({ name: 'Address reviews', prompt: 'Address the review comments', schedule: { kind: 'manual' }, threadId: 't-pr', threadEvent: { threadId: 't-pr', number: 712, events: ['review', 'comment'] } })
  const finish = (id: string) => {
    const claim = store.getJob(id)!.runClaim!
    store.markJobRun(id, true, 'done', undefined, false, claim.token)
  }

  it('runs at once, then holds the next event until ten minutes after that run, and merges what comes meanwhile', () => {
    const { id } = create()
    expect(store.queueThreadEvent(id, ['review'], { now: new Date(T0) })).toBe('started')
    const [claimed] = store.claimDueJobs(new Date(T0))
    expect(threadEventsOfOccurrence(claimed!.runClaim!.occurrenceKey)).toEqual(['review'])
    finish(id)
    expect(store.queueThreadEvent(id, ['comment'], { now: new Date(T0 + 2 * MINUTE) })).toBe('held')
    expect(store.queueThreadEvent(id, ['review'], { now: new Date(T0 + 3 * MINUTE) })).toBe('held')
    expect(store.getJob(id)!.pendingEvent).toEqual({ kinds: ['review', 'comment'], firstAt: iso(2 * MINUTE), dueAt: iso(THREAD_EVENT_MIN_GAP_MS) })
    expect(store.claimDueJobs(new Date(T0 + 9 * MINUTE))).toHaveLength(0)
    const [next] = store.claimDueJobs(new Date(T0 + THREAD_EVENT_MIN_GAP_MS))
    expect(threadEventsOfOccurrence(next!.runClaim!.occurrenceKey)).toEqual(['review', 'comment'])
    finish(id)
    const after = store.getJob(id)!
    expect(after.pendingEvent).toBeUndefined()
    expect(after.runHistory!.map((record) => threadEventsOfOccurrence(record.occurrenceKey))).toEqual([['review'], ['review', 'comment']])
    expect(after.runHistory![0]).toMatchObject({ startedAt: expect.any(String), endedAt: expect.any(String) })
    expect(after.eventLog!.map((entry) => entry.outcome)).toEqual(['started', 'held', 'held'])
    expect(after.eventLog![1]!.until).toBe(iso(THREAD_EVENT_MIN_GAP_MS))
  })

  it('logs and ignores an event its own run caused, and one that comes while paused; a paused job drops a waiting one', () => {
    const { id } = create()
    expect(store.queueThreadEvent(id, ['comment'], { now: new Date(T0), own: 'its own comment' })).toBe('own')
    expect(store.getJob(id)!.pendingEvent).toBeUndefined()
    store.queueThreadEvent(id, ['review'], { now: new Date(T0) })
    store.pauseJob(id)
    expect(store.queueThreadEvent(id, ['review'], { now: new Date(T0 + MINUTE) })).toBe('paused')
    expect(store.claimDueJobs(new Date(T0 + MINUTE))).toHaveLength(0)
    expect(store.getJob(id)!.pendingEvent).toBeUndefined()
    expect(store.getJob(id)!.eventLog!.map((entry) => [entry.outcome, entry.reason])).toEqual([['own', 'its own comment'], ['started', undefined], ['paused', undefined]])
  })

  it('shows on the list: Watching, what wakes it, the watch, what waits and the log, and runs say which events started them', () => {
    const { id } = create()
    store.queueThreadEvent(id, ['review'], { now: new Date(T0) })
    store.claimDueJobs(new Date(T0))
    finish(id)
    store.queueThreadEvent(id, ['comment'], { now: new Date(T0 + MINUTE) })
    const index = buildAutomationIndex({
      jobs: () => store.listJobs(),
      thread: (threadId) => (threadId === 't-pr' ? { id: 't-pr', name: 'Fix flaky checkout test' } as Thread : undefined),
      threads: () => [],
      projectName: () => undefined,
      threadMode: () => 'ask',
      watchStatus: () => ({ state: 'watching', nextCheckAt: null }),
      computerName: 'Desk',
      timeZone: 'UTC',
      now: () => new Date(T0 + MINUTE)
    })
    const [row] = index.items
    expect(row).toMatchObject({ trigger: 'thread_event', whenText: '#712: review, comment', threadEvent: { threadId: 't-pr', threadName: 'Fix flaky checkout test', number: 712, watching: true, heldUntil: iso(THREAD_EVENT_MIN_GAP_MS) } })
    expect(row!.threadEvent!.log.map((entry) => entry.outcome)).toEqual(['held', 'started'])
    expect(row!.runs[0]!.events).toEqual(['review'])
  })
})

describe('the protocol', () => {
  it('takes a thread and one to four events on create, and only events on an edit', () => {
    expect(asCreateScheduledJobInput({ name: 'n', prompt: 'p', schedule: { kind: 'manual' }, threadEvent: { threadId: 't', events: ['review', 'review'], number: 712 } }).threadEvent).toEqual({ threadId: 't', events: ['review'], number: 712 })
    expect(() => asCreateScheduledJobInput({ name: 'n', prompt: 'p', schedule: { kind: 'manual' }, threadEvent: { threadId: 't', events: [] } })).toThrow(/1 to 4/)
    expect(() => asCreateScheduledJobInput({ name: 'n', prompt: 'p', schedule: { kind: 'manual' }, threadEvent: { threadId: 't', events: ['push'] } })).toThrow(/checks_failed/)
    expect(asScheduledJobPatch({ threadEvent: { events: ['checks_passed'] } }).threadEvent).toEqual({ events: ['checks_passed'] })
    expect(() => asScheduledJobPatch({ threadEvent: { threadId: 'x', events: ['review'] } })).toThrow(/not allowed/)
  })
})
