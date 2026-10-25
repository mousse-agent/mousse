import { afterEach, describe, expect, it } from 'vitest'
import {
  formatInboxNotice,
  formatWakeNotice,
  fullyShownDelegations,
  NOTICE_TASK_CHARS,
  NOTICE_WAKE_CHARS,
  planWakeNotice
} from '../../src/mms/run/delegation/notice'
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

  describe('wake notices (issue #142)', () => {
    const row = (delegationId: string, result: { runStatus: string; text?: string; error?: string }, childThreadId = 'c'): InboxRecord => ({
      inboxId: `i:${delegationId}`, threadId: 't', runId: 'r', kind: 'child_result', status: 'pending', createdAt: '',
      payload: { delegationId, childThreadId, childRunId: 'cr', result }
    } as InboxRecord)
    const titles = { titleOf: (id: string) => ({ c: 'API reviewer', d: 'Docs writer' })[id] }

    it('names the subagent by title and thread and inlines a result that fits, once', () => {
      const planned = planWakeNotice([row('delegation:1', { runStatus: 'completed', text: 'All three modules are fine.' })], titles)
      expect(planned.text).toBe('Subagent "API reviewer" (thread c) finished task delegation:1.\nAll three modules are fine.\nFull result above.')
      expect(planned.items).toEqual([{ delegationId: 'delegation:1', childThreadId: 'c', title: 'API reviewer', runStatus: 'completed', fullyShown: true }])
    })

    it('falls back to the thread when the title is gone, and says when a task left no message', () => {
      expect(formatInboxNotice(row('delegation:1', { runStatus: 'completed', text: '' }))).toBe('Subagent thread c finished task delegation:1.\nIt left no message.')
    })

    it('cuts a result at the per-task limit and points at task_status for the rest', () => {
      const long = 'x'.repeat(NOTICE_TASK_CHARS + 500)
      const planned = planWakeNotice([row('delegation:1', { runStatus: 'completed', text: long })], titles)
      expect(planned.text).toContain('x'.repeat(NOTICE_TASK_CHARS))
      expect(planned.text).not.toContain('x'.repeat(NOTICE_TASK_CHARS + 1))
      expect(planned.text).toContain(`[Result cut at ${NOTICE_TASK_CHARS} of ${NOTICE_TASK_CHARS + 500} characters; call task_status with delegation:1 for the rest.]`)
      expect(planned.items[0].fullyShown).toBe(false)
    })

    it('shares the per-notice budget between tasks in order', () => {
      const text = 'y'.repeat(NOTICE_TASK_CHARS)
      const rows = [1, 2, 3, 4, 5].map((n) => row(`delegation:${n}`, { runStatus: 'completed', text }))
      const planned = planWakeNotice(rows, titles)
      expect(planned.items.map((item) => item.fullyShown)).toEqual([true, true, true, true, false])
      expect(planned.text.length).toBeLessThan(NOTICE_WAKE_CHARS + 2_000)
      expect(planned.text).toContain('call task_status with delegation:5 for the rest')
    })

    it('reports a failed task with its error, and joins other rows after a blank line', () => {
      const failed = row('delegation:2', { runStatus: 'interrupted', error: 'daemon restart' }, 'd')
      expect(formatInboxNotice(failed, titles)).toBe('Subagent "Docs writer" (thread d) ended task delegation:2 (interrupted).\ndaemon restart\nFull result above.')
      const notice: InboxRecord = { ...failed, kind: 'reconcile_notice', payload: { text: 'Integration finished.' } }
      expect(formatWakeNotice([failed, notice], titles).split('\n\n')).toHaveLength(2)
      expect(formatWakeNotice([notice])).toBe('Integration finished.')
    })

    it('marks as read only the tasks whose result a notice showed whole', () => {
      const rows = [row('delegation:1', { runStatus: 'completed', text: 'short' }), row('delegation:2', { runStatus: 'completed', text: 'z'.repeat(NOTICE_TASK_CHARS + 1) })]
      expect([...fullyShownDelegations(rows)]).toEqual(['delegation:1'])
    })
  })
})
