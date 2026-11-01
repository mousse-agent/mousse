import { describe, expect, it } from 'vitest'
import { SendRetryIds } from '../../src/renderer/lib/sendRetryIds'

function ids(): SendRetryIds {
  let next = 0
  return new SendRetryIds(() => `id-${++next}`)
}

describe('the request ids of composer sends', () => {
  it('reuses the id of a send whose outcome is unknown, so sending it again replays it', () => {
    const sends = ids()
    const first = sends.begin('hello')
    sends.replied(first)
    // No settle: the reply never said whether it arrived.
    expect(sends.begin('hello')).toBe(first)
  })

  it('gives the same text sent while the first is still waiting a new id', () => {
    const sends = ids()
    const first = sends.begin('continue')
    const second = sends.begin('continue')
    expect(second).not.toBe(first)
    // The first answers later: the second keeps its own id for a retry.
    sends.replied(first)
    sends.settle('continue', first)
    sends.replied(second)
    expect(sends.begin('continue')).toBe(second)
  })

  it('gives up the id of a send that arrived or was refused', () => {
    const sends = ids()
    const arrived = sends.begin('one')
    sends.replied(arrived)
    sends.settle('one', arrived)
    expect(sends.begin('one')).not.toBe(arrived)

    const refused = sends.begin('two')
    sends.replied(refused)
    sends.settle('two', refused)
    expect(sends.begin('two')).not.toBe(refused)
  })

  it('keeps only the most recent ids', () => {
    const sends = new SendRetryIds(() => crypto.randomUUID(), 2)
    const a = sends.begin('a')
    sends.replied(a)
    for (const signature of ['b', 'c']) sends.replied(sends.begin(signature))
    expect(sends.begin('a')).not.toBe(a)
  })
})
