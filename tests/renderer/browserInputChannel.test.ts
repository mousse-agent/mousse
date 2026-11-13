/**
 * A view's end of its hold's input channel: inputs are numbered once and sent in order; only an unsent
 * move or wheel turn merges into the one just before it (wheel turns add up, never dropped), so text
 * typed before Enter stays before it; every input settles with the host's answer; what has no answer
 * goes again, and the view says "Sending…" after half a second and "Not reaching" after three.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrowserInputChannel, DROPPED_TEXT, MAX_UNANSWERED, RESEND_FOR_MS, SENDING_AFTER_MS, UNREACHABLE_AFTER_MS, type ChannelHealth } from '../../src/renderer/stores/browserInputChannel'
import type { WatchedBrowserAck, WatchedBrowserInput, WatchedBrowserSent } from '../../src/shared/browser/watched'

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

/** A host that answers each call when the test says (or at once), applying each number once. */
function hostSide(options: { answer?: 'now' | 'hold' } = {}) {
  const calls: WatchedBrowserSent[][] = []
  const taken = new Set<number>()
  const waiting: Array<() => void> = []
  const fail: { next?: boolean } = {}
  const answer = (inputs: WatchedBrowserSent[]) => ({
    acks: inputs.map((sent): WatchedBrowserAck => {
      if (taken.has(sent.seq)) return { seq: sent.seq, status: 'duplicate' }
      taken.add(sent.seq)
      return { seq: sent.seq, status: 'applied' }
    }),
    lastSeq: Math.max(0, ...taken)
  })
  const send = (inputs: WatchedBrowserSent[]) => {
    calls.push(inputs)
    if (fail.next) {
      fail.next = false
      return Promise.reject(new Error('connection lost'))
    }
    if (options.answer === 'hold') return new Promise<ReturnType<typeof answer>>((resolve) => waiting.push(() => resolve(answer(inputs))))
    return Promise.resolve(answer(inputs))
  }
  return { calls, send, waiting, fail, sent: () => calls.flat() }
}

const move = (x: number, buttons = 0): WatchedBrowserInput => ({ kind: 'pointer', type: 'move', x, y: 10, button: 'none', buttons })
const wheel = (deltaY: number): WatchedBrowserInput => ({ kind: 'scroll', x: 5, y: 5, deltaX: 0, deltaY })
const keyDown = (key: string): WatchedBrowserInput => ({ kind: 'keys', type: 'down', key, code: `Key${key.toUpperCase()}`, keyCode: key.toUpperCase().charCodeAt(0), modifiers: 0, text: key })

describe('the view\'s input channel', () => {
  it('numbers each input once and sends them in order; text typed before Enter stays before it', async () => {
    const host = hostSide()
    const channel = new BrowserInputChannel({ send: host.send })
    for (const key of 'hi') channel.push(keyDown(key))
    const enter = channel.push({ kind: 'keys', type: 'down', key: 'Enter', code: 'Enter', keyCode: 13, modifiers: 0 })
    await vi.advanceTimersByTimeAsync(0)
    expect(host.sent().map((sent) => [sent.seq, (sent.input as { key: string }).key])).toEqual([[1, 'h'], [2, 'i'], [3, 'Enter']])
    expect(await enter.done).toEqual({ seq: 3, status: 'applied' })
  })

  it('adds wheel turns up and merges moves while they wait, never across another kind', async () => {
    const host = hostSide()
    const channel = new BrowserInputChannel({ send: host.send })
    channel.push(wheel(40))
    channel.push(wheel(40))
    channel.push(wheel(-10))
    channel.push(keyDown('a'))
    channel.push(move(1))
    channel.push(move(2))
    channel.push(move(3, 1))
    await vi.advanceTimersByTimeAsync(30)
    expect(host.sent().map((sent) => sent.input)).toEqual([
      { kind: 'scroll', x: 5, y: 5, deltaX: 0, deltaY: 70 },
      keyDown('a'),
      move(2),
      move(3, 1)
    ])
    expect(host.sent().map((sent) => sent.seq)).toEqual([1, 2, 3, 4])
  })

  it('sends again what did not reach the host; the host answers what it already took as a duplicate', async () => {
    const host = hostSide()
    const answered: WatchedBrowserAck[] = []
    const channel = new BrowserInputChannel({ send: host.send, answered: (ack) => answered.push(ack) })
    host.fail.next = true
    const first = channel.push(keyDown('a'))
    await vi.advanceTimersByTimeAsync(0)
    expect(host.calls).toHaveLength(1)
    // It goes again by itself, a little later.
    await vi.advanceTimersByTimeAsync(500)
    expect(await first.done).toEqual({ seq: 1, status: 'applied' })
    // Retry of something already taken (its answer was lost) is a duplicate: applied once.
    const second = channel.push(keyDown('b'))
    channel.retry()
    channel.retry()
    await vi.advanceTimersByTimeAsync(0)
    expect(await second.done).toMatchObject({ seq: 2 })
    expect(answered.filter((ack) => ack.status === 'applied').map((ack) => ack.seq)).toEqual([1, 2])
  })

  it('says "Sending…" after half a second without an answer and "Not reaching" after three, and is quiet again once answered', async () => {
    const host = hostSide({ answer: 'hold' })
    const health: ChannelHealth[] = []
    const channel = new BrowserInputChannel({ send: host.send, health: (state) => health.push(state) })
    channel.push(keyDown('a'))
    await vi.advanceTimersByTimeAsync(SENDING_AFTER_MS - 10)
    expect(channel.health).toBe('ok')
    await vi.advanceTimersByTimeAsync(20)
    expect(channel.health).toBe('sending')
    await vi.advanceTimersByTimeAsync(UNREACHABLE_AFTER_MS - SENDING_AFTER_MS)
    expect(channel.health).toBe('unreachable')
    // Retry sends it again; the host, back, answers both calls; it is applied once.
    channel.retry()
    for (const answer of host.waiting.splice(0)) answer()
    await vi.advanceTimersByTimeAsync(0)
    expect(channel.health).toBe('ok')
    expect(health).toEqual(['sending', 'unreachable', 'ok'])
    expect(host.calls).toHaveLength(2)
  })

  it('a gap the host reports sends that input again after the earlier ones', async () => {
    const calls: WatchedBrowserSent[][] = []
    let first = true
    const channel = new BrowserInputChannel({
      send: async (inputs) => {
        calls.push(inputs)
        // The first time, the host had not seen number 1 yet (it came another way, late).
        if (first) {
          first = false
          return { acks: inputs.map((sent) => sent.seq === 1 ? { seq: 1, status: 'applied' as const } : { seq: sent.seq, status: 'refused' as const, reason: 'gap' as const }), lastSeq: 1 }
        }
        return { acks: inputs.map((sent) => ({ seq: sent.seq, status: 'applied' as const })), lastSeq: inputs.at(-1)!.seq }
      }
    })
    channel.push(keyDown('a'))
    const later = channel.push(keyDown('b'))
    await vi.advanceTimersByTimeAsync(10)
    expect(await later.done).toEqual({ seq: 2, status: 'applied' })
    expect(calls.map((batch) => batch.map((sent) => sent.seq))).toEqual([[1, 2], [2]])
  })

  it('a hold that ends refuses what has no answer, here', async () => {
    const host = hostSide({ answer: 'hold' })
    const channel = new BrowserInputChannel({ send: host.send })
    const pending = channel.push(keyDown('a'))
    await vi.advanceTimersByTimeAsync(0)
    channel.close('Taken over in another window')
    expect(await pending.done).toEqual({ seq: 1, status: 'refused', reason: 'not-held', text: 'Taken over in another window' })
    expect(channel.health).toBe('ok')
  })
})

/**
 * A host as `InputSequencer` answers: each number once, in order (what waits behind a missing one is
 * refused as `gap` without using its number), `busy` while the test says it is full, and a skip uses
 * its number and applies nothing. The service refuses a whole call holding an input it never takes.
 */
function sequencedHost(options: { busy?: (seq: number) => boolean; neverTakes?: (sent: WatchedBrowserSent) => boolean } = {}) {
  let last = 0
  const applied: WatchedBrowserSent[] = []
  const calls: WatchedBrowserSent[][] = []
  const send = async (inputs: WatchedBrowserSent[]) => {
    calls.push(inputs)
    if (inputs.some((sent) => options.neverTakes?.(sent))) throw { code: 'invalid_params', message: 'invalid_action: invalid string' }
    const acks: WatchedBrowserAck[] = []
    for (const sent of [...inputs].sort((a, b) => a.seq - b.seq)) {
      if (sent.seq <= last) acks.push({ seq: sent.seq, status: 'duplicate' })
      else if (!('skip' in sent) && options.busy?.(sent.seq)) acks.push({ seq: sent.seq, status: 'refused', reason: 'busy', text: 'Too much at once' })
      else if (sent.seq !== last + 1) acks.push({ seq: sent.seq, status: 'refused', reason: 'gap', text: 'An earlier input did not arrive' })
      else {
        last = sent.seq
        if ('skip' in sent) acks.push({ seq: sent.seq, status: 'refused', reason: 'skipped', text: 'Skipped' })
        else {
          applied.push(sent)
          acks.push({ seq: sent.seq, status: 'applied' })
        }
      }
    }
    return { acks, lastSeq: last }
  }
  return { send, applied, calls, last: () => last }
}
const keyUp = (key: string): WatchedBrowserInput => ({ kind: 'keys', type: 'up', key, code: `Key${key.toUpperCase()}`, keyCode: key.toUpperCase().charCodeAt(0), modifiers: 0 })
const keyOf = (sent: WatchedBrowserSent) => 'input' in sent ? (sent.input as { key?: string }).key : 'skip'

describe('no refusal leaves a hole in the count', () => {
  it('a busy refusal (its number unused) goes again, backing off, and nothing behind it jams', async () => {
    let full = true
    const host = sequencedHost({ busy: (seq) => full && seq === 1 })
    const answered: WatchedBrowserAck[] = []
    const channel = new BrowserInputChannel({ send: host.send, answered: (ack) => answered.push(ack) })
    const first = channel.push(keyDown('a'))
    for (const key of 'bcd') channel.push(keyDown(key))
    await vi.advanceTimersByTimeAsync(0)
    // The host had too much to take number 1; the ones behind it wait for it.
    expect(host.last()).toBe(0)
    full = false
    await vi.advanceTimersByTimeAsync(2_000)
    expect(await first.done).toEqual({ seq: 1, status: 'applied' })
    expect(host.applied.map(keyOf)).toEqual(['a', 'b', 'c', 'd'])
    expect(channel.unanswered).toBe(0)
    expect(channel.health).toBe('ok')
    // Nothing was said to the person: it arrived.
    expect(answered.every((ack) => ack.status === 'applied')).toBe(true)
  })

  it('one the host keeps refusing as busy is dropped once it no longer means anything: said once, its number skipped, the rest goes on', async () => {
    const host = sequencedHost({ busy: (seq) => seq === 1 })
    const answered: WatchedBrowserAck[] = []
    const channel = new BrowserInputChannel({ send: host.send, answered: (ack) => answered.push(ack) })
    const first = channel.push(keyDown('a'))
    await vi.advanceTimersByTimeAsync(RESEND_FOR_MS + 5_000)
    expect(await first.done).toMatchObject({ seq: 1, status: 'refused', reason: 'dropped', text: DROPPED_TEXT })
    // Quiet again: what the person types next is numbered after the skipped one and arrives.
    expect(channel.health).toBe('ok')
    const second = channel.push(keyDown('b'))
    await vi.advanceTimersByTimeAsync(0)
    // Number 1 was never taken as an input: it went as a skip, so the host's count goes on.
    expect(host.calls.flat().some((sent) => sent.seq === 1 && 'skip' in sent)).toBe(true)
    expect(await second.done).toEqual({ seq: 2, status: 'applied' })
    expect(host.applied.map(keyOf)).toEqual(['b'])
    expect(answered.filter((ack) => ack.reason === 'dropped')).toHaveLength(1)
    expect(channel.unanswered).toBe(0)
  }, 20_000)

  it('an input the service never takes is refused here before it gets a number, and the next one is numbered as if it never came', async () => {
    const host = sequencedHost()
    const answered: WatchedBrowserAck[] = []
    const channel = new BrowserInputChannel({ send: host.send, answered: (ack) => answered.push(ack) })
    const tooLong = channel.push({ kind: 'dialog', accept: true, text: 'x'.repeat(5_000) })
    expect(await tooLong.done).toMatchObject({ status: 'refused', reason: 'invalid', text: 'Too long: the page takes at most 4,096 characters here' })
    expect(tooLong.seq).toBeLessThan(0)
    const next = channel.push(keyDown('a'))
    await vi.advanceTimersByTimeAsync(0)
    expect(await next.done).toEqual({ seq: 1, status: 'applied' })
    expect(answered.map((ack) => ack.reason)).toEqual(['invalid', undefined])
  })

  it('a call the service refuses as a whole is sent again one by one: the input it never takes is dropped, said once, and skipped', async () => {
    const host = sequencedHost({ neverTakes: (sent) => 'input' in sent && sent.input.kind === 'keys' && sent.input.key === 'b' })
    const answered: WatchedBrowserAck[] = []
    const channel = new BrowserInputChannel({ send: host.send, answered: (ack) => answered.push(ack) })
    const acks = [...'abc'].map((key) => channel.push(keyDown(key)).done)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(await Promise.all(acks)).toEqual([
      { seq: 1, status: 'applied' },
      { seq: 2, status: 'refused', reason: 'invalid', text: 'That can\'t be sent to the page' },
      { seq: 3, status: 'applied' }
    ])
    // Number 2 reached the host as a skip: nothing waits on it.
    expect(host.last()).toBe(3)
    expect(host.applied.map(keyOf)).toEqual(['a', 'c'])
    expect(channel.unanswered).toBe(0)
  })

  it('a hole the host reports below everything the view still has is filled with skips', async () => {
    // A host that last took 2, while the view's oldest unanswered is 5 (3 and 4 were dropped somewhere).
    let last = 2
    const calls: WatchedBrowserSent[][] = []
    const channel = new BrowserInputChannel({
      lastSeq: 4,
      send: async (inputs) => {
        calls.push(inputs)
        const acks: WatchedBrowserAck[] = []
        for (const sent of inputs) {
          if (sent.seq !== last + 1) acks.push({ seq: sent.seq, status: 'refused', reason: 'gap' })
          else {
            last = sent.seq
            acks.push('skip' in sent ? { seq: sent.seq, status: 'refused', reason: 'skipped' } : { seq: sent.seq, status: 'applied' })
          }
        }
        return { acks, lastSeq: last }
      }
    })
    const typed = channel.push(keyDown('a'))
    await vi.advanceTimersByTimeAsync(1_000)
    expect(await typed.done).toEqual({ seq: 5, status: 'applied' })
    expect(calls.flat().filter((sent) => 'skip' in sent).map((sent) => sent.seq)).toEqual([3, 4])
    expect(channel.unanswered).toBe(0)
  })
})

describe('back-pressure', () => {
  it('while the page does not answer, new presses and keys are refused here and the view says "Not reaching"; letting go still goes; it recovers by itself', async () => {
    const host = hostSide({ answer: 'hold' })
    const health: ChannelHealth[] = []
    const channel = new BrowserInputChannel({ send: host.send, health: (state) => health.push(state) })
    const taken: Array<Promise<WatchedBrowserAck>> = []
    for (let index = 0; index < MAX_UNANSWERED; index += 1) taken.push(channel.push(keyDown('a')).done)
    await vi.advanceTimersByTimeAsync(0)
    // Full: the next key is refused at once, here, and the view says it is not reaching the page.
    const refused = channel.push(keyDown('b'))
    expect(await refused.done).toMatchObject({ status: 'refused', reason: 'busy' })
    expect(refused.seq).toBeLessThan(0)
    expect(channel.health).toBe('unreachable')
    // Its key going up is not sent either; a key that went down before goes up.
    expect((await channel.push(keyUp('b')).done)).toMatchObject({ status: 'refused' })
    const up = channel.push(keyUp('a'))
    expect(up.seq).toBe(MAX_UNANSWERED + 1)
    // The page answers again: everything taken arrives once, and the view is quiet by itself.
    for (let round = 0; round < 5; round += 1) {
      for (const answer of host.waiting.splice(0)) answer()
      await vi.advanceTimersByTimeAsync(300)
    }
    expect((await Promise.all(taken)).every((ack) => ack.status === 'applied' || ack.status === 'duplicate')).toBe(true)
    expect(await up.done).toMatchObject({ status: 'applied' })
    expect(channel.health).toBe('ok')
    expect(health.at(-1)).toBe('ok')
    // And it takes input again.
    const later = channel.push(keyDown('c'))
    await vi.advanceTimersByTimeAsync(0)
    for (const answer of host.waiting.splice(0)) answer()
    await vi.advanceTimersByTimeAsync(0)
    expect(await later.done).toMatchObject({ status: 'applied' })
  })
})
