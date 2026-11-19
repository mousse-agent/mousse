/**
 * The client's path switch (§3.6) at the level of its streams: every subscription moves to the renewed
 * connection, including one opened while the others were being prepared there.
 */
import { describe, expect, it } from 'vitest'
import type { NodeId, StreamId } from '../../src/shared/net'
import { EngineClient } from '../../src/mms/netEngine/session/client'
import { encodeMessage, MessageReader } from '../../src/mms/netEngine/session/frame'
import type {
  EngineConnection,
  EngineLabel,
  EngineStream
} from '../../src/mms/netEngine/session/transport'

/** A connection whose streams the test answers: what this side wrote on each, and a way to reply. */
function connection(id: string) {
  const streams: Array<{
    headers: Array<Record<string, unknown>>
    reply(header: Record<string, unknown>): void
  }> = []
  const closers: Array<(reason: string) => void> = []
  let open = true
  const conn: EngineConnection = {
    id,
    peer: 'node' as NodeId,
    direction: 'outbound',
    open(label: EngineLabel): EngineStream {
      const reader = new MessageReader()
      const headers: Array<Record<string, unknown>> = []
      let data: (bytes: Uint8Array) => void = () => undefined
      const ends: Array<(reason?: string) => void> = []
      streams.push({ headers, reply: (header) => data(encodeMessage(header as never)) })
      return {
        label,
        write: (bytes) => void headers.push(...reader.push(bytes).map((message) => message.header)),
        end: () => undefined,
        reset: () => undefined,
        onData: (listener) => void (data = listener),
        onEnd: (listener) => void ends.push(listener)
      }
    },
    onStream: () => undefined,
    onClose: (listener) => void closers.push(listener),
    close: (reason) => {
      open = false
      for (const close of closers.splice(0)) close(reason)
    },
    isOpen: () => open
  }
  const subscribedTo = (stream: string) =>
    streams.find((s) => s.headers.some((h) => h.t === 'subscribe' && h.stream === stream))
  return { conn, streams, subscribedTo }
}

describe('path switch', () => {
  it('moves a subscription opened while the others were being prepared on the new path', async () => {
    const old = connection('1'),
      next = connection('2')
    const client = new EngineClient(old.conn, {
      store: { cursor: () => ({ epoch: 1, seq: 0 }) },
      verify: () => undefined
    } as never)
    const errors: string[] = []
    const handlers = (name: string) => ({
      onRecord: () => undefined,
      onCaughtUp: () => undefined,
      onSnapshotInstalled: () => undefined,
      onError: (code: string) => void errors.push(`${name} ${code}`)
    })
    const subscribed = { t: 'subscribed', head: { epoch: 1, seq: 0 }, replayThrough: 0 }
    client.subscribe('a' as StreamId, handlers('a'))
    const switching = client.switchTo(next.conn, 5_000)
    expect(next.subscribedTo('a')).toBeDefined()
    // Opened during the handoff: it starts on the old path.
    client.subscribe('b' as StreamId, handlers('b'))
    next.subscribedTo('a')!.reply(subscribed)
    await new Promise((resolve) => setImmediate(resolve))
    next.subscribedTo('b')?.reply(subscribed)
    await switching
    expect(client.connection).toBe(next.conn)
    expect(next.subscribedTo('b')).toBeDefined()
    // The old path closing ends neither subscription.
    old.conn.close('path_replaced')
    expect(errors).toEqual([])
  })
})
