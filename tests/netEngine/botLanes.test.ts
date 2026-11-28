/**
 * Bot traffic in places of its own (`docs/plans/remote-bots.md`, mousse-net `BOT_LABELS`): bot calls ride on
 * `mousse.botrpc` and bot streams on `mousse.botsub`, and nothing else does, so a bot never waits for a thread's place
 * and a thread can't take a bot's. The serving side refuses any mix-up before it runs or reads anything.
 */
import { describe, expect, it, vi } from 'vitest'
import { newId, type NodeId, type StreamId } from '../../src/shared/net'
import { EngineClient } from '../../src/mms/netEngine/session/client'
import { EngineHost } from '../../src/mms/netEngine/session/host'
import { Channel, type EngineLabel } from '../../src/mms/netEngine/session/transport'
import type { EngineMessage } from '../../src/mms/netEngine/session/frame'
import { fakeLink } from './fakeLink'

const BOT_STREAM = 'stm_bot_feed' as StreamId
const THREAD_STREAM = 'stm_thread' as StreamId

function pair() {
  const caller = newId('node') as NodeId
  const link = fakeLink({ ownerOnCaller: newId('node') as NodeId, callerOnOwner: caller, grant: '1', endpoint: 'e' })
  const dispatched: string[] = []
  const read: StreamId[] = []
  const head = { epoch: 1, seq: 0 }
  const store = {
    head: () => head,
    cursor: () => head,
    snapshotReason: () => undefined,
    read: () => ({ records: [] }),
    openSnapshot: () => ({ target: head, next: () => ({ records: [], done: true }), close: () => undefined })
  }
  new EngineHost(link.inbound, {
    caller: () => ({ node: caller, grant: '1' }),
    revoked: () => new AbortController().signal,
    now: () => Date.now(),
    name: () => 'Owner',
    assertReadable: (stream: StreamId) => void read.push(stream),
    store,
    rpc: {
      dispatch: async (method: string) => {
        dispatched.push(method)
        return { ok: method }
      },
      result: async () => null,
      cancel: async () => undefined
    },
    botStream: (stream: StreamId) => stream === BOT_STREAM,
    callMethod: () => 'bots.get'
  } as never)
  const client = new EngineClient(link.outbound, { store: store as never, verify: () => undefined })
  return { link, client, dispatched, read }
}

/** Opens a raw stream with one message and answers what comes back first: a message, or the reset's reason. */
async function raw(link: ReturnType<typeof fakeLink>, label: EngineLabel, header: EngineMessage['header']): Promise<{ header?: EngineMessage['header']; reset?: string }> {
  const channel = new Channel(link.outbound.open(label))
  const answer = new Promise<{ header?: EngineMessage['header']; reset?: string }>((resolve) => {
    channel.onMessage((message) => resolve({ header: message.header }))
    channel.onEnd((reason) => resolve({ reset: reason ?? 'fin' }))
  })
  channel.send(header)
  return answer
}

describe('bot lanes on an engine connection', () => {
  it('sends bot calls on mousse.botrpc and every other call on mousse.rpc', async () => {
    const { link, client, dispatched } = pair()
    await expect(client.rpc('bots.get', { botId: 'b1' }, { id: newId('rpc'), deadlineMs: 5_000 })).resolves.toEqual({ ok: 'bots.get' })
    await expect(client.rpc('bridge.bot.open', { botId: 'b1' }, { id: newId('rpc'), deadlineMs: 5_000 })).resolves.toEqual({ ok: 'bridge.bot.open' })
    await expect(client.rpc('threads.list', {}, { id: newId('rpc'), deadlineMs: 5_000 })).resolves.toEqual({ ok: 'threads.list' })
    const calls = link.crossed.filter((row) => row.header.t === 'call').map((row) => `${row.label} ${String(row.header.method)}`)
    expect(calls).toEqual(['mousse.botrpc bots.get', 'mousse.botrpc bridge.bot.open', 'mousse.rpc threads.list'])
    expect(dispatched).toEqual(['bots.get', 'bridge.bot.open', 'threads.list'])
  })

  it('refuses a bot call on the thread label and a thread call on the bot label, before it runs', async () => {
    const { link, dispatched } = pair()
    const call = (method: string) => ({ t: 'call', id: newId('rpc'), method, params: {}, deadline: 5_000 })
    expect(await raw(link, 'mousse.rpc', call('bots.chat.send'))).toMatchObject({ header: { t: 'error', error: { code: 'forbidden' } } })
    expect(await raw(link, 'mousse.botrpc', call('threads.list'))).toMatchObject({ header: { t: 'error', error: { code: 'forbidden' } } })
    // A saved result or a cancel of a bot call is asked for on its own label too.
    expect(await raw(link, 'mousse.rpc', { t: 'result.get', id: newId('rpc'), deadline: 5_000 })).toMatchObject({ header: { t: 'error', error: { code: 'forbidden' } } })
    expect(dispatched).toEqual([])
  })

  it('serves a bot stream on mousse.botsub alone, and a thread stream never there', async () => {
    const { link, client, read } = pair()
    const subscribe = (stream: StreamId) => ({ t: 'subscribe', stream, from: { epoch: 1, seq: 0 } })
    expect(await raw(link, 'mousse.sub', subscribe(BOT_STREAM))).toMatchObject({ header: { t: 'error', error: { code: 'forbidden' } } })
    expect(await raw(link, 'mousse.botsub', subscribe(THREAD_STREAM))).toMatchObject({ header: { t: 'error', error: { code: 'forbidden' } } })
    expect(read).toEqual([])
    // The client opens a bot stream on the bot label when it is attached as one (`lane: 'bot'`).
    const errors: string[] = []
    client.subscribe(BOT_STREAM, { lane: 'bot', onRecord: () => undefined, onError: (code) => void errors.push(code) } as never)
    await vi.waitFor(() => expect(link.crossed.some((row) => row.label === 'mousse.botsub' && row.header.t === 'subscribe')).toBe(true))
    expect(errors).toEqual([])
  })
})
