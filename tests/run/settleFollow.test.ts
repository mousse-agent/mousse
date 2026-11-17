/**
 * `followMessage` (SPEC §15.1, "keyed on the message"): where the message a watch follows is now. One row per way a
 * message moves between runs, and per way it ends.
 */
import { describe, expect, it } from 'vitest'
import { followMessage, type WatchTarget } from '../../src/mms/run/settle/follow'
import type { RunRecord, RunStatus } from '../../src/mms/run/types'
import type { QueuedMessage } from '../../src/shared/types'

const T = 'target'

function run(ordinal: number, status: RunStatus, extra: Partial<RunRecord> = {}): RunRecord {
  return {
    runId: `r${ordinal}`, threadId: T, ordinal, status, epoch: 0, activeAttemptId: null, source: 'mcp', clientRequestId: null,
    userMessageId: null, requestedAt: '', startedAt: null, completedAt: null, outcome: null, heartbeatAt: null, ...extra
  }
}

function item(state: QueuedMessage['state'], extra: Partial<QueuedMessage> = {}): QueuedMessage {
  return { id: 'item', threadId: T, content: 'x', enqueuedAt: '', order: 0, intent: state === 'steering' ? 'steer' : 'normal', state, ...extra }
}

function target(runs: RunRecord[], queue: QueuedMessage[] = [], active?: string): WatchTarget {
  return {
    getRun: (id) => runs.find((entry) => entry.runId === id) ?? null,
    continuationOf: (_t, id) => runs.find((entry) => entry.outcome?.continuationOf === id),
    queueRun: (_t, itemId) => [...runs].reverse().find((entry) => entry.clientRequestId === `queue:${itemId}`),
    queueItemForRun: (_t, id) => queue.find((entry) => entry.runId === id)?.id,
    queueItem: (_t, itemId) => queue.find((entry) => entry.id === itemId),
    activeRun: () => (active ? runs.find((entry) => entry.runId === active) ?? null : null)
  }
}

const resumed = { pause: { reason: 'usage_limit' as const, until: '', estimated: false, count: 1, autoResume: true, endedBy: 'resume' as const } }

describe('followMessage', () => {
  it.each([
    ['a running run is followed as it is', target([run(1, 'running')]), 'r1', null, { kind: 'live', runId: 'r1' }],
    ['a paused run is still live (the pause ends by itself)', target([run(1, 'paused')]), 'r1', null, { kind: 'live', runId: 'r1' }],
    ['a run that ended is the end', target([run(1, 'completed')]), 'r1', null, { kind: 'ended', runId: 'r1', status: 'completed' }],
    ['a failed run ends failed', target([run(1, 'failed')]), 'r1', null, { kind: 'ended', runId: 'r1', status: 'failed' }],
    ['a pause continuation carries it on', target([run(1, 'cancelled', { outcome: resumed }), run(2, 'running', { outcome: { continuationOf: 'r1' } })]), 'r1', null, { kind: 'live', runId: 'r2' }],
    ['and its end is the continuation\'s', target([run(1, 'cancelled', { outcome: resumed }), run(2, 'completed', { outcome: { continuationOf: 'r1' } })]), 'r1', null, { kind: 'ended', runId: 'r2', status: 'completed' }],
    ['a person\'s edit: the run is cancelled and the item waits for its fresh run', target([run(1, 'cancelled')], [item('pending')]), 'r1', 'item', { kind: 'awaiting', runId: 'r1' }],
    ['the drain gave the edited item its run', target([run(1, 'cancelled'), run(2, 'queued', { clientRequestId: 'queue:item' })], [item('claimed', { runId: 'r2' })]), 'r1', 'item', { kind: 'live', runId: 'r2' }],
    ['that run\'s end is the end', target([run(1, 'cancelled'), run(2, 'completed', { clientRequestId: 'queue:item' })]), 'r1', 'item', { kind: 'ended', runId: 'r2', status: 'completed' }],
    ['promoted to a steer: it joins the run it steers', target([run(1, 'cancelled'), run(2, 'running')], [item('steering', { steerRunId: 'r2' })], 'r2'), 'r1', 'item', { kind: 'live', runId: 'r2' }],
    ['a steer the run read ends with that run', target([run(1, 'cancelled'), run(2, 'completed')]), 'r2', 'item', { kind: 'ended', runId: 'r2', status: 'completed' }],
    ['a steer handed back waits for its own turn', target([run(1, 'cancelled'), run(2, 'completed')], [item('pending')]), 'r2', 'item', { kind: 'awaiting', runId: 'r2' }],
    ['and its own turn carries it', target([run(1, 'cancelled'), run(2, 'completed'), run(3, 'completed', { clientRequestId: 'queue:item' })]), 'r2', 'item', { kind: 'ended', runId: 'r3', status: 'completed' }],
    ['a queued message removed before it ran ends as removed', target([run(1, 'cancelled')]), 'r1', 'item', { kind: 'ended', runId: 'r1', status: 'removed' }],
    ['a run that is gone ends as removed', target([]), 'r1', null, { kind: 'ended', runId: 'r1', status: 'removed' }]
  ] as const)('%s', (_name, where, runId, itemId, expected) => {
    expect(followMessage(where, T, runId, itemId)).toEqual(expected)
  })
})
