import { afterEach, describe, expect, it } from 'vitest'
import { formatInboxNotice, formatWakeNotice } from '../../src/mms/run/delegation/notice'
import type { InboxRecord } from '../../src/mms/run/types'
import { delegationFixture, type DelegationFixture } from './delegationFixture'

describe('Inbox (SPEC §14.1)', () => {
  let f: DelegationFixture | undefined
  afterEach(() => {
    f?.dispose()
    f = undefined
  })

  it('appends pending rows per thread, oldest first, with an event each', () => {
    f = delegationFixture()
    const a = f.engine.inbox.append({ threadId: 't', kind: 'reconcile_notice', payload: { text: 'one' } })
    f.advance(1)
    const b = f.engine.inbox.append({ threadId: 't', runId: 'r', kind: 'child_result', payload: { delegationId: 'd' } })
    f.engine.inbox.append({ threadId: 'other', kind: 'reconcile_notice', payload: { text: 'x' } })
    expect(f.engine.inbox.listPending('t').map((row) => row.inboxId)).toEqual([a.inboxId, b.inboxId])
    expect(f.engine.inbox.listThreadsWithPending()).toEqual(['t', 'other'])
    expect(f.engine.inbox.listForDelegation('d').map((row) => row.inboxId)).toEqual([b.inboxId])
    const events = f.store.listEvents('t').filter((event) => event.type === 'inbox.status')
    expect(events.map((event) => (event.payload as InboxRecord).status)).toEqual(['pending', 'pending'])
  })

  it('moves pending → delivered → acknowledged and never back from acknowledged', () => {
    f = delegationFixture()
    const row = f.engine.inbox.append({ threadId: 't', kind: 'reconcile_notice', payload: { text: 'one' } })
    expect(f.engine.inbox.markDelivered([row.inboxId]).map((next) => next.status)).toEqual(['delivered'])
    expect(f.engine.inbox.listPending('t')).toEqual([])
    expect(f.engine.inbox.markDelivered([row.inboxId])).toEqual([])
    expect(f.engine.inbox.markPendingAgain([row.inboxId]).map((next) => next.status)).toEqual(['pending'])
    expect(f.engine.inbox.markAcknowledged([row.inboxId]).map((next) => next.status)).toEqual(['acknowledged'])
    expect(f.engine.inbox.markPendingAgain([row.inboxId])).toEqual([])
    expect(f.engine.inbox.markDelivered([row.inboxId])).toEqual([])
    expect(f.engine.inbox.get(row.inboxId)!.status).toBe('acknowledged')
    expect(() => f!.engine.inbox.markDelivered(['missing'])).toThrow('Unknown inbox row')
  })

  it('formats server-authored wake notices with a 200-character head', () => {
    const long = 'x'.repeat(250)
    const child: InboxRecord = {
      inboxId: 'i1', threadId: 't', runId: 'r', kind: 'child_result', status: 'pending', createdAt: '',
      payload: { delegationId: 'delegation:1', childThreadId: 'c', childRunId: 'cr', result: { runStatus: 'completed', text: long } }
    }
    expect(formatInboxNotice(child)).toBe(`Delegated task delegation:1 finished: ${'x'.repeat(200)}…. Use task_status for the full result.`)
    const failed: InboxRecord = { ...child, payload: { delegationId: 'delegation:2', childThreadId: 'c', childRunId: 'cr', result: { runStatus: 'interrupted', error: 'daemon restart' } } }
    expect(formatInboxNotice(failed)).toBe('Delegated task delegation:2 finished (interrupted): daemon restart. Use task_status for the full result.')
    const notice: InboxRecord = { ...child, kind: 'reconcile_notice', payload: { text: 'Integration finished.' } }
    expect(formatWakeNotice([failed, notice]).split('\n')).toHaveLength(2)
  })
})
