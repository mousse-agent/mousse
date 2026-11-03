import { describe, expect, it } from 'vitest'
import { guiChatRequestError } from '../../src/main/mms/requestErrors'
import { SendRetryIds } from '../../src/renderer/lib/sendRetryIds'
import { isOutcomeUncertain } from '../../src/renderer/lib/uncertainSend'

function ids(): SendRetryIds {
  let next = 0
  return new SendRetryIds(() => `id-${++next}`)
}

describe('the request ids of composer sends', () => {
  it('reuses the id of a send whose outcome is unknown, so sending it again replays it', () => {
    const sends = ids()
    const first = sends.begin('hello')
    sends.replied(first)
    sends.settle('hello', first, 'unknown')
    expect(sends.begin('hello')).toBe(first)
  })

  it('keeps the id of a send whose reply timed out', () => {
    // The window's error for a send the client gave up waiting on is an unknown outcome, not a refusal.
    const error = guiChatRequestError(new Error('Request timeout: orchestrator.send'))
    expect(error.code).toBe('outcome_uncertain')
    expect(isOutcomeUncertain(error)).toBe(true)
    const sends = ids()
    const first = sends.begin('long task')
    sends.replied(first)
    sends.settle('long task', first, isOutcomeUncertain(error) ? 'unknown' : 'refused')
    expect(sends.begin('long task')).toBe(first)
  })

  it('gives up the id once reading the thread again finds the message', () => {
    const sends = ids()
    const first = sends.begin('hello')
    sends.replied(first)
    sends.settle('hello', first, 'unknown')
    sends.settle('hello', first, 'arrived')
    expect(sends.begin('hello')).not.toBe(first)
  })

  it('gives the same text sent while the first is still waiting a new id', () => {
    const sends = ids()
    const first = sends.begin('continue')
    const second = sends.begin('continue')
    expect(second).not.toBe(first)
    // The first answers later: the second keeps its own id for a retry.
    sends.replied(first)
    sends.settle('continue', first, 'answered')
    sends.replied(second)
    expect(sends.begin('continue')).toBe(second)
  })

  it('gives up the id of a send that was answered or refused', () => {
    const sends = ids()
    const answered = sends.begin('one')
    sends.replied(answered)
    sends.settle('one', answered, 'answered')
    expect(sends.begin('one')).not.toBe(answered)

    const refused = sends.begin('two')
    sends.replied(refused)
    sends.settle('two', refused, 'refused')
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
