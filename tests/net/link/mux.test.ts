import { afterEach, describe, expect, it } from 'vitest'
import { Duplex } from 'node:stream'
import type { Lane, WireMessage } from '../../../src/shared/net'
import { NetError } from '../../../src/shared/net/errors'
import { StreamMux, MUX_WINDOWS } from '../../../src/mms/net/link/mux'
import { encodeMessage } from '../../../src/mms/net/sync/codec'
import { memoryPair } from '../harness/MemoryTransport'
import { FakeClock } from '../harness/FakeClock'
import type { MuxMessage } from '../../../src/mms/net/contracts'

const cleanup: Array<() => void> = []
afterEach(() => {
  for (const close of cleanup.splice(0)) close()
})
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))
const message = (lane: Lane, count = 14): MuxMessage => {
  const records = Array.from({ length: count }, (_, i) => ({ seq: i + 1, epoch: 1, recvTs: i }))
  const parts = records.flatMap(() => [new Uint8Array(65536).fill(97), new Uint8Array(64)])
  return {
    header: {
      t: 'events',
      stream: 'str_00000000000000000000000000',
      records,
      replay: lane === 'bulk',
      parts: parts.map((part) => part.length)
    },
    parts
  }
}
const ping = { header: { t: 'ping', n: 1, now: 0 } as WireMessage, parts: [] }
const framed = (
  payload: Uint8Array,
  { flags = 3, id = 1, lane = 0, grant = 0, version = 1, reserved = 0 } = {}
): Buffer => {
  const bytes = Buffer.alloc(16 + payload.length)
  bytes[0] = version
  bytes[1] = lane
  bytes[2] = flags
  bytes[3] = reserved
  bytes.writeUInt32BE(id, 4)
  bytes.writeUInt32BE(payload.length, 8)
  bytes.writeUInt32BE(grant, 12)
  bytes.set(payload, 16)
  return bytes
}
const pair = (clock = new FakeClock()) => {
  const connection = memoryPair(clock),
    a = new StreamMux(connection.a, { clock }),
    b = new StreamMux(connection.b, { clock })
  cleanup.push(() => {
    a.close()
    b.close()
    connection.cut()
  })
  return { connection, a, b, clock }
}

describe('real duplex mux', () => {
  it.each(['event', 'callback', 'throw'] as const)(
    'normalizes raw ECONNRESET from %s and preserves its cause',
    async (mode) => {
      const cause = Object.assign(new Error('socket reset'), { code: 'ECONNRESET' })
      const raw = new Duplex({
        read() {},
        write(_chunk, _encoding, callback) {
          if (mode === 'callback') callback(cause)
          else if (mode === 'throw') throw cause
          // Event mode leaves a write pending until the socket reports its reset.
        }
      })
      const mux = new StreamMux(raw)
      cleanup.push(() => mux.close())
      const closed = new Promise<Error | undefined>((resolve) => mux.onClose(resolve))
      const pending = mux.send('control', ping).catch((error) => error)
      if (mode === 'event') {
        await tick()
        raw.emit('error', cause)
      }
      const error = await closed
      expect(error).toBeInstanceOf(NetError)
      expect(error).toMatchObject({ code: 'route_unreachable' })
      expect(error?.cause).toBe(cause)
      expect(await pending).toBe(error)
      await expect(mux.send('control', ping)).rejects.toBe(error)
      expect(raw.destroyed).toBe(true)
    }
  )
  it('exchanges both lanes and fragments a control message larger than its credit window without deadlock', async () => {
    const { a, b, clock } = pair()
    const input = message('control'),
      received = new Promise<MuxMessage>((resolve) => b.onMessage((_lane, value) => resolve(value)))
    expect(encodeMessage(input.header, input.parts).length).toBeGreaterThan(MUX_WINDOWS.control)
    await a.send('control', input)
    const value = await received
    expect(value.header).toEqual(input.header)
    expect(value.parts.map((part) => part.length)).toEqual(input.parts.map((part) => part.length))
    expect(value.parts[0][65535]).toBe(97)
    expect(a.queued('control')).toBe(0)
    await tick()
    expect(clock.pending()).toBe(0)
  })
  it('schedules control ahead of bulk while reassembly retains separate messages', async () => {
    const { a, b } = pair(),
      received: string[] = []
    b.onMessage((_lane, value) => received.push(value.header.t))
    await Promise.all([a.send('bulk', message('bulk')), a.send('control', ping)])
    await tick()
    expect(received).toEqual(['ping', 'events'])
  })
  it('continues control when a bulk sender has consumed independent credit', async () => {
    const clock = new FakeClock(),
      connection = memoryPair(clock),
      a = new StreamMux(connection.a, { clock })
    cleanup.push(() => {
      a.close()
      connection.cut()
    })
    const lanes: number[] = []
    connection.b.on('data', (frame: Buffer) => {
      lanes.push(frame[1])
    })
    await a.send('bulk', message('bulk'))
    const blocked = a.send('bulk', message('bulk')).catch((error) => error)
    await tick()
    expect(a.queued('bulk')).toBeGreaterThan(0)
    await a.send('control', ping)
    expect(lanes.at(-1)).toBe(0)
    a.close()
    expect(await blocked).toBeInstanceOf(NetError)
  })
  it('rejects bounded waiting queue overflow without closing an otherwise valid mux', async () => {
    const { a, b, connection } = pair()
    connection.forward.stall()
    const active = a.send('control', message('control')).catch((error) => error)
    const next = a.send('control', ping).catch((error) => error)
    await expect(a.send('control', message('control'))).rejects.toMatchObject({
      code: 'rate_limited'
    })
    expect(a.queued('control')).toBeLessThanOrEqual(1024 * 1024 + MUX_WINDOWS.control)
    a.close()
    b.close()
    expect(await active).toBeInstanceOf(NetError)
    expect(await next).toBeInstanceOf(NetError)
  })
  it('cancels an unsent request safely, and closes after cancellation of a started fragmented request', async () => {
    const { a, connection } = pair(),
      before = new AbortController()
    const unsent = a.send('control', ping, before.signal).catch((error) => error)
    before.abort()
    expect(await unsent).toMatchObject({ code: 'cancelled' })
    expect(a.queued('control')).toBe(0)
    connection.forward.stall()
    const started = new AbortController(),
      pending = a.send('control', message('control'), started.signal).catch((error) => error)
    await tick()
    started.abort()
    expect(await pending).toMatchObject({ code: 'cancelled' })
    await expect(a.send('control', ping)).rejects.toMatchObject({
      code: 'route_unreachable',
      cause: { code: 'cancelled' }
    })
  })
  it('expires only when fragmented byte progress stalls, including partial headers', async () => {
    const clock = new FakeClock(),
      raw = memoryPair(clock),
      mux = new StreamMux(raw.b, { clock })
    cleanup.push(() => {
      mux.close()
      raw.cut()
    })
    const timeout = new Promise<Error | undefined>((resolve) => mux.onClose(resolve))
    raw.a.write(framed(encodeMessage(ping.header)).subarray(0, 7))
    await tick()
    clock.advance(29999)
    expect(raw.b.destroyed).toBe(false)
    clock.advance(1)
    expect(await timeout).toMatchObject({ code: 'deadline_exceeded' })
  })
  it('does not impose an absolute duration while a partial message continues making progress', async () => {
    const clock = new FakeClock(),
      connection = memoryPair(clock),
      b = new StreamMux(connection.b, { clock })
    cleanup.push(() => {
      b.close()
      connection.cut()
    })
    connection.a.on('data', () => {})
    const bytes = encodeMessage(ping.header),
      frame = framed(bytes),
      received = new Promise<MuxMessage>((resolve) => b.onMessage((_lane, value) => resolve(value)))
    for (const byte of frame) {
      connection.a.write(Buffer.from([byte]))
      await tick()
      clock.advance(1000)
    }
    expect((await received).header).toEqual(ping.header)
    expect(connection.b.destroyed).toBe(false)
  })
  it.each([
    { flags: 0 },
    { version: 2 },
    { lane: 2 },
    { reserved: 1 },
    { flags: 7 },
    { id: 0 },
    { grant: 1 }
  ])('rejects malformed frame metadata %j', async (options) => {
    const clock = new FakeClock(),
      connection = memoryPair(clock),
      b = new StreamMux(connection.b, { clock })
    cleanup.push(() => {
      b.close()
      connection.cut()
    })
    const closed = new Promise<Error | undefined>((resolve) => b.onClose(resolve))
    connection.a.write(framed(encodeMessage(ping.header), options))
    expect(await closed).toMatchObject({ code: 'bad_request' })
  })
  it('keeps a full-duplex fragmented send alive when one frame takes over 30 seconds but bytes progress', async () => {
    const { a, b, connection, clock } = pair()
    connection.forward.slow(1)
    let failure: unknown,
      finished = false
    const pending = a.send('bulk', message('bulk', 1)).then(
      () => {
        finished = true
      },
      (error) => {
        failure = error
      }
    )
    await tick()
    clock.advance(30001)
    await tick()
    expect(failure).toBeUndefined()
    expect(connection.a.destroyed).toBe(false)
    expect(finished).toBe(false)
    clock.advance(36000)
    await tick()
    clock.advance(1000)
    await pending
    expect(finished).toBe(true)
    expect(connection.b.destroyed).toBe(false)
  })
  it('counts unfinished and unknown DATA bytes before dispatch for session quarantine limits', async () => {
    const clock = new FakeClock(),
      connection = memoryPair(clock)
    let total = 0
    const mux = new StreamMux(connection.b, {
      clock,
      onBytesReceived: (count) => {
        total += count
        if (total > 16384) throw new NetError('too_large')
      }
    })
    cleanup.push(() => {
      mux.close()
      connection.cut()
    })
    const closed = new Promise<Error | undefined>((resolve) => mux.onClose(resolve))
    // FIRST without LAST deliberately never reaches a schema/message callback.
    connection.a.write(framed(new Uint8Array(20000), { flags: 1 }))
    expect(await closed).toMatchObject({ code: 'too_large' })
    expect(total).toBe(20000)
  })
  it('rejects unsolicited credit and skips a complete unknown wire message without dispatch', async () => {
    const clock = new FakeClock(),
      connection = memoryPair(clock),
      b = new StreamMux(connection.b, { clock })
    cleanup.push(() => {
      b.close()
      connection.cut()
    })
    connection.a.on('data', () => {})
    let messages = 0
    b.onMessage(() => messages++)
    const json = Buffer.from('{"t":"future.safe"}'),
      encoded = Buffer.alloc(json.length + 4)
    encoded.writeUInt32BE(json.length)
    json.copy(encoded, 4)
    connection.a.write(framed(encoded))
    await tick()
    expect(messages).toBe(0)
    expect(connection.b.destroyed).toBe(false)
    const closed = new Promise<Error | undefined>((resolve) => b.onClose(resolve))
    connection.a.write(
      framed(new Uint8Array(), { flags: 4, id: 0, grant: MUX_WINDOWS.control + 1 })
    )
    expect(await closed).toMatchObject({ code: 'bad_request' })
  })
})
