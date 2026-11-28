/**
 * The app's end of the helper channel (design §2): what it writes under the helper's credit, in what order, and
 * what closes it.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  AppChannel,
  creditFrame,
  dataFrame,
  FRAME_CREDIT,
  FRAME_DATA,
  FRAME_JSON,
  FrameReader,
  jsonFrame,
  type AppPipe,
  type HandleSink
} from '../../src/mms/netEngine/helper/appChannel'
import { EngineHelper } from '../../src/mms/netEngine/helper/connections'
import { engineLimits } from '../../src/mms/netEngine/limits'
import { EngineClient } from '../../src/mms/netEngine/session/client'
import { encodeMessage } from '../../src/mms/netEngine/session/frame'
import { EngineHost } from '../../src/mms/netEngine/session/host'
import type { EngineConnection, EngineStream } from '../../src/mms/netEngine/session/transport'
import type { NodeId, StreamId } from '../../src/shared/net'

/** A pipe whose helper side is the test: frames the app wrote, and frames pushed to the app. */
function pipe() {
  const written: Array<{ type: number; body: Buffer }> = []
  const reader = new FrameReader()
  let data: (bytes: Uint8Array) => void = () => undefined
  let closed = false
  const app: AppPipe = {
    write: (bytes) => {
      for (const frame of reader.push(bytes)) written.push({ type: frame.type, body: Buffer.from(frame.body) })
      return true
    },
    onDrain: () => undefined,
    onData: (listener) => void (data = listener),
    onClose: () => undefined,
    close: () => void (closed = true)
  }
  const data_ = (handle: number) =>
    written
      .filter((frame) => frame.type === FRAME_DATA && frame.body.readUInt32BE(0) === handle)
      .map((frame) => ({ bytes: frame.body.byteLength - 5, fin: (frame.body[4]! & 1) === 1 }))
  return { app, written, push: (bytes: Uint8Array) => data(bytes), data: data_, closed: () => closed }
}

const sink = (): HandleSink & { got: number; ended?: string } => {
  const out = {
    got: 0,
    ended: undefined as string | undefined,
    data: (bytes: Uint8Array) => void (out.got += bytes.byteLength),
    reset: (code: string) => void (out.ended = code)
  }
  return out
}

/** The handles the app reset, from the frames it wrote. */
const resets = (written: Array<{ type: number; body: Buffer }>) =>
  written
    .filter((frame) => frame.type === FRAME_JSON)
    .map((frame) => JSON.parse(frame.body.toString('utf8')) as { op?: string; handle?: number })
    .filter((message) => message.op === 'stream.reset')
    .map((message) => message.handle)

describe('the app channel', () => {
  it('sends a stream only as far as the helper’s credit, with FIN after every queued byte', () => {
    const p = pipe()
    const channel = new AppChannel(p.app)
    channel.bind(7, 'bulk', sink())
    channel.send(7, new Uint8Array(100 * 1024), true)
    expect(p.data(7)).toEqual([])
    p.push(creditFrame(7, 64 * 1024))
    expect(p.data(7)).toEqual([{ bytes: 64 * 1024, fin: false }])
    p.push(creditFrame(7, 36 * 1024))
    expect(p.data(7)).toEqual([
      { bytes: 64 * 1024, fin: false },
      { bytes: 36 * 1024, fin: true }
    ])
  })

  it('writes control first, then interactive data, then bulk', () => {
    const p = pipe()
    // A pipe that takes one frame and then wants a drain: each drain shows the writer's next choice.
    let drain: () => void = () => undefined
    const order: string[] = []
    const slow: AppPipe = {
      ...p.app,
      onDrain: (listener) => void (drain = listener),
      write: (bytes) => {
        p.app.write(bytes)
        const frame = p.written[p.written.length - 1]!
        order.push(frame.type === FRAME_DATA ? `data ${frame.body.readUInt32BE(0)}` : frame.type === FRAME_JSON ? 'json' : 'credit')
        return false
      }
    }
    const channel = new AppChannel(slow)
    channel.bind(1, 'bulk', sink())
    channel.bind(2, 'interactive', sink())
    p.push(Buffer.concat([creditFrame(1, 1024), creditFrame(2, 1024)]))
    channel.send(1, new Uint8Array(10))
    channel.send(2, new Uint8Array(10))
    void channel.request('stats').catch(() => undefined)
    for (let i = 0; i < 4; i += 1) drain()
    // The first bind's credit went at once; then the second's, the request, interactive data, bulk data.
    expect(order).toEqual(['credit', 'credit', 'json', 'data 2', 'data 1'])
  })

  it('closes on a malformed frame', () => {
    for (const malformed of [
      // A CREDIT of 0 bytes.
      Buffer.concat([Buffer.from([0, 0, 0, 9, FRAME_CREDIT]), Buffer.alloc(8)]),
      // DATA with a flag other than FIN.
      Buffer.concat([Buffer.from([0, 0, 0, 6, FRAME_DATA, 0, 0, 0, 1, 0x02])]),
      // An unknown frame type.
      Buffer.from([0, 0, 0, 1, 0x09])
    ]) {
      const p = pipe()
      const channel = new AppChannel(p.app)
      const one = sink()
      channel.bind(1, 'interactive', one)
      p.push(malformed)
      expect(channel.isOpen()).toBe(false)
      expect(p.closed()).toBe(true)
      expect(one.ended).toBeDefined()
    }
  })

  it('drops a frame for a handle it does not know, and counts it', () => {
    const p = pipe()
    const channel = new AppChannel(p.app)
    p.push(dataFrame(42, new Uint8Array(3), false))
    p.push(jsonFrame({ ev: 'stream.reset', handle: 42, code: 'cancelled' }))
    expect(channel.dropped).toBe(1)
    expect(channel.isOpen()).toBe(true)
  })
})

describe('what the app queues for the helper', () => {
  it('has a stream’s producer wait while its queue is full, and refuses a write past the hard cap', async () => {
    const p = pipe()
    const channel = new AppChannel(p.app)
    channel.bind(7, 'bulk', sink())
    const { appStreamQueueBytes, appStreamQueueMaxBytes } = engineLimits()
    channel.send(7, new Uint8Array(appStreamQueueBytes))
    expect(channel.hasRoom(7)).toBe(false)
    let roomy = false
    void channel.whenRoom(7).then(() => (roomy = true))
    await Promise.resolve()
    expect(roomy).toBe(false)
    // The helper's credit lets the queue out: the producer goes on.
    p.push(creditFrame(7, appStreamQueueBytes))
    await Promise.resolve()
    expect(roomy).toBe(true)
    expect(() => channel.send(7, new Uint8Array(appStreamQueueMaxBytes + 1))).toThrow(
      expect.objectContaining({ code: 'too_large' })
    )
  })

  it('refuses requests past the control queue’s bound while the pipe takes nothing', async () => {
    const p = pipe()
    const channel = new AppChannel({ ...p.app, write: (bytes) => (p.app.write(bytes), false) })
    const big = 'x'.repeat(engineLimits().appFrameMaxBytes - 1024)
    const answers = Array.from({ length: Math.ceil(engineLimits().appControlQueueBytes / big.length) + 1 }, () =>
      channel.request('stats', { pad: big }).then(
        () => 'answered',
        (error: { code?: string }) => error.code
      )
    )
    channel.close()
    expect(await Promise.all(answers)).toContain('rate_limited')
  })

  it('sends a blob to a slow reader a chunk at a time, as the stream takes them', async () => {
    const { blobChunkBytes } = engineLimits()
    const size = 4 * blobChunkBytes
    const written: number[] = []
    let open: () => void = () => undefined
    let data: (bytes: Uint8Array) => void = () => undefined
    const stream: EngineStream = {
      label: 'mousse.blob',
      write: (bytes) => void written.push(bytes.byteLength),
      end: () => undefined,
      reset: () => undefined,
      // Nothing more leaves until the reader takes what it has.
      ready: () => new Promise<void>((resolve) => (open = resolve)),
      onData: (listener) => void (data = listener),
      onEnd: () => undefined
    }
    let accept: (stream: EngineStream) => void = () => undefined
    const connection = {
      id: '1',
      peer: 'node' as NodeId,
      direction: 'inbound',
      onStream: (listener: (stream: EngineStream) => void) => void (accept = listener),
      onClose: () => undefined
    } as unknown as EngineConnection
    new EngineHost(connection, {
      caller: () => ({}) as never,
      canFetchBlob: () => true,
      blobs: { size: () => size, read: (_blob: unknown, _at: number, length: number) => new Uint8Array(length) }
    } as never)
    accept(stream)
    data(encodeMessage({ t: 'get', stream: 's', blob: 'b' }))
    await new Promise((resolve) => setImmediate(resolve))
    // The `blob` header and one chunk; the rest waits for room.
    expect(written).toHaveLength(2)
    open()
    await new Promise((resolve) => setImmediate(resolve))
    expect(written).toHaveLength(3)
  })
})

describe('the helper, as the app sees it', () => {
  it('releases the streams of a connection that went down, with their credit', () => {
    const p = pipe()
    const ended: Array<string | undefined> = []
    new EngineHelper(new AppChannel(p.app), {
      peers: { byIdentity: () => ({ node: 'node' as NodeId, grant: '1', endpoint: 'ab' }) },
      attach: async (connection) =>
        connection.onStream((stream) => stream.onEnd((reason) => ended.push(reason))),
      name: () => 'Desk'
    })
    const credit = (handle: number) =>
      p.written
        .filter((frame) => frame.type === FRAME_CREDIT && frame.body.readUInt32BE(0) === handle)
        .reduce((sum, frame) => sum + frame.body.readUInt32BE(4), 0)
    const { appStreamsPerConnection, appStreamCreditBytes } = engineLimits()
    p.push(jsonFrame({ ev: 'conn.up', conn: 1, identity: 'ab', dir: 'in', grant: 1 }))
    for (let handle = 1; handle <= appStreamsPerConnection; handle += 1)
      p.push(jsonFrame({ ev: 'stream.incoming', conn: 1, handle, label: 'mousse.rpc', class: 'interactive' }))
    p.push(jsonFrame({ ev: 'conn.down', conn: 1, reason: 'closed' }))
    expect(ended).toHaveLength(appStreamsPerConnection)
    // The budget those streams held is free again for the next connection's.
    p.push(jsonFrame({ ev: 'conn.up', conn: 2, identity: 'ab', dir: 'in', grant: 1 }))
    p.push(jsonFrame({ ev: 'stream.incoming', conn: 2, handle: 100, label: 'mousse.rpc', class: 'interactive' }))
    expect(credit(100)).toBe(appStreamCreditBytes)
  })

  it('resets a stream the helper names in the same read as its connection going down', async () => {
    const p = pipe()
    const channel = new AppChannel(p.app)
    let opened: EngineStream | undefined
    new EngineHelper(channel, {
      peers: { byIdentity: () => ({ node: 'node' as NodeId, grant: '1', endpoint: 'ab' }) },
      attach: async (connection) => {
        // Its reader is listening, as the session's always is.
        opened = connection.open('mousse.rpc')
        opened.onEnd(() => undefined)
      },
      name: () => 'Desk'
    })
    p.push(jsonFrame({ ev: 'conn.up', conn: 1, identity: 'ab', dir: 'in', grant: 1 }))
    const ask = p.written
      .filter((frame) => frame.type === FRAME_JSON)
      .map((frame) => JSON.parse(frame.body.toString('utf8')) as { id: number; op: string })
      .find((message) => message.op === 'stream.open')
    expect(opened).toBeDefined()
    // The helper's answer naming handle 5 and its conn.down arrive in one read.
    p.push(
      Buffer.concat([
        jsonFrame({ re: ask!.id, handle: 5 }),
        jsonFrame({ ev: 'conn.down', conn: 1, reason: 'closed' })
      ])
    )
    await new Promise((resolve) => setImmediate(resolve))
    expect(resets(p.written)).toContain(5)
    // Handle 5 holds nothing here any more: what the helper still sends on it is dropped.
    p.push(dataFrame(5, new Uint8Array(3), false))
    expect(channel.dropped).toBe(1)
  })

  it('resets a stream it could not accept because the control queue was full', async () => {
    const p = pipe()
    const channel = new AppChannel({ ...p.app, write: (bytes) => (p.app.write(bytes), false) })
    const ended: Array<string | undefined> = []
    new EngineHelper(channel, {
      peers: { byIdentity: () => ({ node: 'node' as NodeId, grant: '1', endpoint: 'ab' }) },
      attach: async (connection) =>
        connection.onStream((stream) => stream.onEnd((reason) => ended.push(reason))),
      name: () => 'Desk'
    })
    p.push(jsonFrame({ ev: 'conn.up', conn: 1, identity: 'ab', dir: 'in', grant: 1 }))
    // The pipe takes nothing more: requests of halving sizes fill the control queue to within a bare request.
    const fill = (pad: number, times: number) => {
      for (let at = 0; at < times; at += 1) channel.request('stats', { pad: 'x'.repeat(pad) }).catch(() => undefined)
    }
    const big = engineLimits().appFrameMaxBytes - 1024
    fill(big, Math.ceil(engineLimits().appControlQueueBytes / big) + 1)
    for (let pad = big; pad >= 1; pad = Math.floor(pad / 2)) fill(pad, 3)
    fill(0, 3)
    p.push(jsonFrame({ ev: 'stream.incoming', conn: 1, handle: 9, label: 'mousse.rpc', class: 'interactive' }))
    await new Promise((resolve) => setImmediate(resolve))
    expect(ended).toEqual(['rate_limited'])
    // Handle 9 and its credit are gone here: what the helper still sends on it is dropped.
    p.push(dataFrame(9, new Uint8Array(3), false))
    expect(channel.dropped).toBe(1)
    channel.close()
  })


  it('calls back over an inbound connection only when the helper says it carries calls both ways, else dials', async () => {
    for (const both of [true, false]) {
      const p = pipe()
      const helper = new EngineHelper(new AppChannel(p.app), {
        peers: { byIdentity: () => ({ node: 'node' as NodeId, grant: '1', endpoint: 'ab' }) },
        // This computer's client says hello over the reversed connection; an inbound one needs nothing here.
        attach: (connection) =>
          connection.direction === 'inbound'
            ? Promise.resolve()
            : new Promise((resolve, reject) =>
                connection.open('mousse.hello').onEnd((reason) => (reason ? reject(new Error(reason)) : resolve()))
              ),
        name: () => 'Desk'
      })
      const asked = (op: string) =>
        p.written
          .filter((frame) => frame.type === FRAME_JSON)
          .map((frame) => JSON.parse(frame.body.toString('utf8')) as { id: number; op: string; conn?: number })
          .filter((message) => message.op === op)
      const settle = () => new Promise((resolve) => setImmediate(resolve))
      // The helper announces an inbound connection once the caller's HELLO agreed what it carries.
      p.push(jsonFrame({ ev: 'conn.up', conn: 1, identity: 'ab', dir: 'in', grant: 1, both }))
      p.push(jsonFrame({ ev: 'stream.incoming', conn: 1, handle: 1, label: 'mousse.rpc', class: 'interactive' }))
      await settle()
      void helper.dial('ab').catch(() => undefined)
      await settle()
      if (both) {
        expect(asked('stream.open')).toMatchObject([{ conn: 1, label: 'mousse.hello' }])
        expect(asked('dial')).toHaveLength(0)
      } else {
        expect(asked('stream.open')).toHaveLength(0)
        expect(asked('dial')).toMatchObject([{ identity: 'ab' }])
      }
    }
  })

  it('says its name and profile in hello, and keeps whether networking is paused', async () => {
    const p = pipe()
    const helper = new EngineHelper(new AppChannel(p.app), {
      peers: { byIdentity: () => undefined },
      attach: async () => undefined,
      name: () => 'Desk',
      profile: () => 'profile-1'
    })
    const seen: Array<string | undefined> = []
    helper.onPaused((reason) => seen.push(reason))
    const hello = helper.hello()
    const asked = JSON.parse(p.written[0]!.body.toString('utf8'))
    // The app offers 1.2; a 1.1 helper answers with its own minor.
    expect(asked).toMatchObject({ op: 'hello', proto: [1, 2], name: 'Desk', profile: 'profile-1' })
    p.push(jsonFrame({ re: asked.id, proto: [1, 1], identity: 'ab', paused: 'journal' }))
    await hello
    expect(helper.speaks(1)).toBe(true)
    expect(helper.paused).toBe('journal')
    p.push(jsonFrame({ ev: 'net.resumed' }))
    p.push(jsonFrame({ ev: 'net.paused', reason: 'disk' }))
    expect(helper.paused).toBe('disk')
    expect(seen).toEqual(['journal', undefined, 'disk'])
  })

  it('closes both halves on unsubscribe so repeated subscribe/unsubscribe never leaks past the stream cap', async () => {
    const cap = engineLimits().appStreamsPerConnection
    // Wire two real AppChannel/EngineHelper stacks through a strict helper pair that enforces `STREAMS_PER_CONNECTION`
    // across both halves: a stream keeps its slot until BOTH sides send FIN (or either resets).
    const clientPipe = pipe()
    const hostPipe = pipe()
    const clientChannel = new AppChannel(clientPipe.app)
    const hostChannel = new AppChannel(hostPipe.app)
    let clientConn!: EngineConnection
    let hostConn!: EngineConnection
    new EngineHelper(clientChannel, {
      peers: { byIdentity: () => ({ node: 'host' as NodeId, grant: '1', endpoint: 'host' }) },
      attach: async (connection) => void (clientConn = connection),
      name: () => 'Client'
    })
    new EngineHelper(hostChannel, {
      peers: { byIdentity: () => ({ node: 'client' as NodeId, grant: '1', endpoint: 'client' }) },
      attach: async (connection) => void (hostConn = connection),
      name: () => 'Host'
    })
    clientPipe.push(jsonFrame({ ev: 'conn.up', conn: 1, identity: 'host', dir: 'out' }))
    hostPipe.push(jsonFrame({ ev: 'conn.up', conn: 1, identity: 'client', dir: 'in', grant: 1 }))

    const head = { epoch: 1, seq: 0 }
    const store = {
      head: () => head,
      cursor: () => head,
      snapshotReason: () => undefined,
      read: () => ({ records: [] }),
      openSnapshot: () => ({ target: head, next: () => ({ records: [], done: true }), close: () => undefined })
    }
    new EngineHost(hostConn, {
      caller: () => ({ node: 'client' as NodeId }) as never,
      assertReadable: () => undefined,
      store
    } as never)
    const client = new EngineClient(clientConn, { store: store as never, verify: () => undefined })

    interface RelayStream {
      handle: number
      clientFin: boolean
      hostFin: boolean
    }
    const open = new Map<number, RelayStream>()
    let nextHandle = 1
    let clientRead = 0
    let hostRead = 0
    let streamLimitErrors = 0

    const releaseIfBothFin = (handle: number): void => {
      const s = open.get(handle)
      if (s && s.clientFin && s.hostFin) open.delete(handle)
    }
    const pump = (): void => {
      let progressed = true
      while (progressed) {
        progressed = false
        while (clientRead < clientPipe.written.length) {
          progressed = true
          const frame = clientPipe.written[clientRead++]!
          if (frame.type === FRAME_JSON) {
            const msg = JSON.parse(frame.body.toString('utf8')) as {
              id: number
              op: string
              label?: string
              class?: string
              handle?: number
            }
            if (msg.op === 'stream.open') {
              if (open.size >= cap) {
                streamLimitErrors += 1
                clientPipe.push(jsonFrame({ re: msg.id, error: 'stream_limit', reason: 'too many open streams' }))
              } else {
                const handle = nextHandle++
                open.set(handle, { handle, clientFin: false, hostFin: false })
                clientPipe.push(Buffer.concat([jsonFrame({ re: msg.id, handle }), creditFrame(handle, 256 * 1024)]))
                hostPipe.push(
                  jsonFrame({
                    ev: 'stream.incoming',
                    conn: 1,
                    handle,
                    label: msg.label,
                    class: msg.class
                  })
                )
              }
            } else if (msg.op === 'stream.reset' && typeof msg.handle === 'number') {
              if (open.delete(msg.handle)) {
                hostPipe.push(jsonFrame({ ev: 'stream.reset', handle: msg.handle, code: 'cancelled' }))
              }
            }
          } else if (frame.type === FRAME_DATA) {
            const handle = frame.body.readUInt32BE(0)
            const fin = (frame.body.readUInt8(4) & 1) === 1
            const payload = frame.body.subarray(5)
            const s = open.get(handle)
            if (s) {
              if (fin) s.clientFin = true
              hostPipe.push(dataFrame(handle, payload, fin))
              releaseIfBothFin(handle)
            }
          }
        }
        while (hostRead < hostPipe.written.length) {
          progressed = true
          const frame = hostPipe.written[hostRead++]!
          if (frame.type === FRAME_JSON) {
            const msg = JSON.parse(frame.body.toString('utf8')) as { id: number; op: string; handle?: number }
            if (msg.op === 'stream.accept' && typeof msg.handle === 'number') {
              hostPipe.push(Buffer.concat([jsonFrame({ re: msg.id }), creditFrame(msg.handle, 256 * 1024)]))
            } else if (msg.op === 'stream.reset' && typeof msg.handle === 'number') {
              if (open.delete(msg.handle)) {
                clientPipe.push(jsonFrame({ ev: 'stream.reset', handle: msg.handle, code: 'cancelled' }))
              }
            }
          } else if (frame.type === FRAME_DATA) {
            const handle = frame.body.readUInt32BE(0)
            const fin = (frame.body.readUInt8(4) & 1) === 1
            const payload = frame.body.subarray(5)
            const s = open.get(handle)
            if (s) {
              if (fin) s.hostFin = true
              clientPipe.push(dataFrame(handle, payload, fin))
              releaseIfBothFin(handle)
            }
          }
        }
      }
    }

    // Run well past `STREAMS_PER_CONNECTION` (32) subscribe → unsubscribe cycles.
    for (let i = 0; i < cap + 12; i += 1) {
      let caughtUp = false
      const sub = client.subscribe(`str_sub_${i}` as StreamId, {
        onRecord: () => undefined,
        onCaughtUp: () => void (caughtUp = true),
        onError: (code) => {
          throw new Error(`unexpected subscription error: ${code}`)
        }
      })
      for (let step = 0; step < 8 && !caughtUp; step += 1) {
        pump()
        await new Promise((resolve) => setImmediate(resolve))
      }
      expect(caughtUp).toBe(true)
      sub.close()
      for (let step = 0; step < 8 && open.size > 0; step += 1) {
        pump()
        await new Promise((resolve) => setImmediate(resolve))
      }
      expect(open.size).toBe(0)
    }
    expect(streamLimitErrors).toBe(0)
    // Verify AppChannel did not retain finished receiving entries on either side.
    expect((clientChannel as unknown as { receiving: Map<number, unknown> }).receiving.size).toBe(0)
    expect((hostChannel as unknown as { receiving: Map<number, unknown> }).receiving.size).toBe(0)
    clientChannel.close()
    hostChannel.close()
  })

  it('does not underflow stream slots when queued opens are reset, and shares the cap across both directions', async () => {
    const cap = engineLimits().appStreamsPerConnection
    const p = pipe()
    const channel = new AppChannel(p.app)
    let outbound!: EngineConnection
    let reverseInbound!: EngineConnection
    new EngineHelper(channel, {
      peers: { byIdentity: () => ({ node: 'node' as NodeId, grant: '1', endpoint: 'ab' }) },
      attach: async (connection) => {
        if (connection.reversed) reverseInbound = connection
        else outbound = connection
      },
      name: () => 'Desk'
    })
    const opens = () =>
      p.written
        .filter((frame) => frame.type === FRAME_JSON)
        .map((frame) => JSON.parse(frame.body.toString('utf8')) as { id: number; op: string; handle?: number })
        .filter((message) => message.op === 'stream.open')

    p.push(jsonFrame({ ev: 'conn.up', conn: 1, identity: 'ab', dir: 'out', both: true }))
    // Fill half the connection's cap with reverse inbound streams from the peer.
    const half = Math.floor(cap / 2)
    for (let h = 1; h <= half; h += 1) {
      p.push(jsonFrame({ ev: 'stream.incoming', conn: 1, handle: h, label: 'mousse.rpc', class: 'interactive', grant: 1 }))
    }
    expect(reverseInbound).toBeDefined()
    // Fill the remaining slots with outbound streams, then queue 5 more past the shared cap.
    const liveOut: EngineStream[] = []
    for (let i = 0; i < cap - half; i += 1) liveOut.push(outbound.open('mousse.rpc'))
    expect(opens()).toHaveLength(cap - half)
    const queued: EngineStream[] = []
    for (let i = 0; i < 5; i += 1) queued.push(outbound.open('mousse.rpc'))
    expect(opens()).toHaveLength(cap - half)

    // Cancelling all 5 queued streams must NOT decrement live slots or trigger any new `stream.open`.
    for (const stream of queued) stream.reset('deadline_exceeded')
    const extra = outbound.open('mousse.rpc')
    expect(opens()).toHaveLength(cap - half)

    // Bind the in-flight outbound opens, then reset one: exactly one waiting stream (`extra`) starts.
    const inflight = opens()
    for (let i = 0; i < inflight.length; i += 1) p.push(jsonFrame({ re: inflight[i]!.id, handle: 100 + i }))
    await new Promise((resolve) => setImmediate(resolve))
    liveOut[0]!.reset('cancelled')
    expect(opens()).toHaveLength(cap - half + 1)
    expect(extra).toBeDefined()
    channel.close()
  })

  it('opens a bot stream at once with every thread place taken, and a thread open never takes a bot place', () => {
    const { appStreamsPerConnection: cap, botStreamsPerConnection: botCap } = engineLimits()
    const p = pipe()
    const channel = new AppChannel(p.app)
    let outbound!: EngineConnection
    new EngineHelper(channel, {
      peers: { byIdentity: () => ({ node: 'node' as NodeId, grant: '1', endpoint: 'ab' }) },
      attach: async (connection) => void (outbound = connection),
      name: () => 'Desk'
    })
    const opens = () =>
      p.written
        .filter((frame) => frame.type === FRAME_JSON)
        .map((frame) => JSON.parse(frame.body.toString('utf8')) as { op: string; label?: string; class?: string })
        .filter((message) => message.op === 'stream.open')
    p.push(jsonFrame({ ev: 'conn.up', conn: 1, identity: 'ab', dir: 'out' }))
    // Every thread place taken, and one more thread open waiting.
    for (let i = 0; i <= cap; i += 1) outbound.open('mousse.rpc')
    expect(opens()).toHaveLength(cap)
    // Bot chat, a bot call and a bot's browser view still go out at once; the view as bulk.
    outbound.open('mousse.botsub')
    outbound.open('mousse.botrpc', 'bots.chat.send')
    outbound.open('mousse.botview')
    expect(opens().slice(cap).map((open) => `${open.label} ${open.class}`)).toEqual([
      'mousse.botsub interactive',
      'mousse.botrpc interactive',
      'mousse.botview bulk'
    ])
    // The bot places fill on their own; a thread open still waits for a thread place.
    for (let i = 3; i <= botCap; i += 1) outbound.open('mousse.botsub')
    expect(opens().filter((open) => open.label === 'mousse.rpc')).toHaveLength(cap)
    expect(opens().filter((open) => open.label?.startsWith('mousse.bot'))).toHaveLength(botCap)
    channel.close()
  })

  it('resets a closed subscription stream after linger if an older peer never sends FIN on unsubscribe', async () => {
    vi.useFakeTimers()
    try {
      const resetsSeen: Array<string | undefined> = []
      const endsSeen: number[] = []
      let onEndListener: ((reason?: string) => void) | undefined
      const stream: EngineStream = {
        label: 'mousse.sub',
        write: () => undefined,
        end: () => void endsSeen.push(1),
        reset: (reason) => void resetsSeen.push(reason),
        onData: () => undefined,
        onEnd: (listener) => void (onEndListener = listener)
      }
      const connection: EngineConnection = {
        id: '1',
        peer: 'node' as NodeId,
        direction: 'outbound',
        open: () => stream,
        onStream: () => undefined,
        onClose: () => undefined,
        close: () => undefined,
        isOpen: () => true
      }
      const client = new EngineClient(connection, {
        store: { cursor: () => ({ epoch: 1, seq: 0 }) } as never,
        verify: () => undefined
      })
      const sub = client.subscribe('str_old_peer' as StreamId, {
        onRecord: () => undefined,
        onCaughtUp: () => undefined,
        onError: () => undefined
      })
      sub.close()
      expect(endsSeen).toHaveLength(1)
      expect(resetsSeen).toEqual([])
      expect(onEndListener).toBeDefined()
      vi.advanceTimersByTime(engineLimits().tunnelCloseLingerMs)
      expect(resetsSeen).toEqual(['cancelled'])
    } finally {
      vi.useRealTimers()
    }
  })
})
