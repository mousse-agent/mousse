/**
 * A view's end of its hold's input channel: inputs are numbered once and sent in order; only an unsent
 * move or wheel turn merges into the one just before it (wheel turns add up, never dropped), so text
 * typed before Enter stays before it; every input settles with the host's answer; what has no answer
 * goes again, and the view says "Sending…" after half a second and "Not reaching" after three.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BotBrowserChannel, SENDING_AFTER_MS, UNREACHABLE_AFTER_MS, type ChannelHealth } from '../../src/renderer/stores/botBrowserChannel'
import type { BotBrowserAck, BotBrowserInput, BotBrowserSent } from '../../src/shared/bots/personal/browser'

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

/** A host that answers each call when the test says (or at once), applying each number once. */
function hostSide(options: { answer?: 'now' | 'hold' } = {}) {
  const calls: BotBrowserSent[][] = []
  const taken = new Set<number>()
  const waiting: Array<() => void> = []
  const fail: { next?: boolean } = {}
  const answer = (inputs: BotBrowserSent[]) => ({
    acks: inputs.map((sent): BotBrowserAck => {
      if (taken.has(sent.seq)) return { seq: sent.seq, status: 'duplicate' }
      taken.add(sent.seq)
      return { seq: sent.seq, status: 'applied' }
    }),
    lastSeq: Math.max(0, ...taken)
  })
  const send = (inputs: BotBrowserSent[]) => {
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

const move = (x: number, buttons = 0): BotBrowserInput => ({ kind: 'pointer', type: 'move', x, y: 10, button: 'none', buttons })
const wheel = (deltaY: number): BotBrowserInput => ({ kind: 'scroll', x: 5, y: 5, deltaX: 0, deltaY })
const keyDown = (key: string): BotBrowserInput => ({ kind: 'keys', type: 'down', key, code: `Key${key.toUpperCase()}`, keyCode: key.toUpperCase().charCodeAt(0), modifiers: 0, text: key })

describe('the view\'s input channel', () => {
  it('numbers each input once and sends them in order; text typed before Enter stays before it', async () => {
    const host = hostSide()
    const channel = new BotBrowserChannel({ send: host.send })
    for (const key of 'hi') channel.push(keyDown(key))
    const enter = channel.push({ kind: 'keys', type: 'down', key: 'Enter', code: 'Enter', keyCode: 13, modifiers: 0 })
    await vi.advanceTimersByTimeAsync(0)
    expect(host.sent().map((sent) => [sent.seq, (sent.input as { key: string }).key])).toEqual([[1, 'h'], [2, 'i'], [3, 'Enter']])
    expect(await enter.done).toEqual({ seq: 3, status: 'applied' })
  })

  it('adds wheel turns up and merges moves while they wait, never across another kind', async () => {
    const host = hostSide()
    const channel = new BotBrowserChannel({ send: host.send })
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
    const answered: BotBrowserAck[] = []
    const channel = new BotBrowserChannel({ send: host.send, answered: (ack) => answered.push(ack) })
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
    const channel = new BotBrowserChannel({ send: host.send, health: (state) => health.push(state) })
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
    const calls: BotBrowserSent[][] = []
    let first = true
    const channel = new BotBrowserChannel({
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
    const channel = new BotBrowserChannel({ send: host.send })
    const pending = channel.push(keyDown('a'))
    await vi.advanceTimersByTimeAsync(0)
    channel.close('Taken over in another window')
    expect(await pending.done).toEqual({ seq: 1, status: 'refused', reason: 'not-held', text: 'Taken over in another window' })
    expect(channel.health).toBe('ok')
  })
})
