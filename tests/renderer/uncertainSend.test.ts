import { describe, expect, it, vi } from 'vitest'
import { isOutcomeUncertain, settleUncertainSend } from '../../src/renderer/lib/uncertainSend'

describe('a send that the other computer did not confirm', () => {
  it('is told apart from a refusal by its code', () => {
    expect(isOutcomeUncertain({ code: 'outcome_uncertain', message: 'x' })).toBe(true)
    expect(isOutcomeUncertain({ code: 'computer_offline' })).toBe(false)
    expect(isOutcomeUncertain(new Error('x'))).toBe(false)
    expect(isOutcomeUncertain(undefined)).toBe(false)
  })

  it('reads the thread again before it says anything, and then drops the painted message of one that arrived', async () => {
    const order: string[] = []
    const outcome = await settleUncertainSend({
      refresh: async () => { order.push('refresh') },
      arrived: async () => { order.push('arrived'); return true },
      dropOptimistic: () => { order.push('drop') }
    })
    expect(outcome).toBe('arrived')
    expect(order).toEqual(['refresh', 'arrived', 'drop'])
  })

  it('says a message is missing when the thread read again does not have it, so the text can come back', async () => {
    const drop = vi.fn()
    expect(await settleUncertainSend({ refresh: async () => undefined, arrived: () => false, dropOptimistic: drop })).toBe('missing')
    expect(drop).toHaveBeenCalledTimes(1)
  })

  it('leaves everything as it is when the computer cannot be read again, because nothing is known', async () => {
    const drop = vi.fn()
    expect(await settleUncertainSend({ refresh: async () => { throw new Error('offline') }, arrived: () => false, dropOptimistic: drop })).toBe('unknown')
    expect(await settleUncertainSend({ refresh: async () => undefined, arrived: async () => { throw new Error('offline') }, dropOptimistic: drop })).toBe('unknown')
    expect(drop).not.toHaveBeenCalled()
  })
})
