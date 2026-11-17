/**
 * Main orders the service's answers against its updates (#1042): an answer read at event N replaces a thread's state
 * only when main applied nothing about that thread numbered above N.
 */
import { describe, expect, it } from 'vitest'
import { UpdateOrder } from '../src/main/mms/updateOrder'

describe('the order of answers and updates', () => {
  it('an update sent after the read wins over the answer, for that thread only', () => {
    const order = new UpdateOrder()
    order.noteUpdate('turn', 'svc', 12, 't1')
    order.noteUpdate('turn', 'svc', 9, 't2')
    expect(order.mayApply('turn', { instance: 'svc', revision: 11 }, 't1')).toBe(false)
    expect(order.mayApply('turn', { instance: 'svc', revision: 11 }, 't2')).toBe(true)
    expect(order.mayApply('turn', { instance: 'svc', revision: 12 }, 't1')).toBe(true)
    // Statuses are ordered apart from turns.
    expect(order.mayApply('activity', { instance: 'svc', revision: 11 }, 't1')).toBe(true)
  })

  it('an update about every thread is newer than an answer for each of them', () => {
    const order = new UpdateOrder()
    order.noteUpdate('activity', 'svc', 20)
    expect(order.mayApply('activity', { instance: 'svc', revision: 19 }, 'any')).toBe(false)
    expect(order.mayApply('activity', { instance: 'svc', revision: 20 }, 'any')).toBe(true)
  })

  it('applies an answer without a number, from another service, or about another computer\'s thread', () => {
    const order = new UpdateOrder()
    order.noteUpdate('turn', 'svc', 50, 't1')
    order.noteUpdate('turn', 'svc', 50, 'nod_0123456789abcdefghjkmnpqrs:t9')
    expect(order.mayApply('turn', { instance: 'svc' }, 't1')).toBe(true)
    expect(order.mayApply('turn', { instance: 'restarted', revision: 3 }, 't1')).toBe(true)
    expect(order.mayApply('turn', { instance: 'svc', revision: 3 }, 'nod_0123456789abcdefghjkmnpqrs:t9')).toBe(true)
  })

  it('forgets the numbers held when the counter started again, in a new service or the same one', () => {
    const order = new UpdateOrder()
    order.noteUpdate('turn', 'svc', 40, 't1')
    order.subscribed('svc', 45)
    expect(order.mayApply('turn', { instance: 'svc', revision: 30 }, 't1')).toBe(false)
    // The profile's counter stands below a number already applied: it was started again.
    order.subscribed('svc', 2)
    expect(order.mayApply('turn', { instance: 'svc', revision: 3 }, 't1')).toBe(true)
    order.noteUpdate('turn', 'svc', 5, 't1')
    order.subscribed('restarted', 1)
    expect(order.mayApply('turn', { instance: 'restarted', revision: 1 }, 't1')).toBe(true)
  })
})
