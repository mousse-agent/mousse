import { randomUUID } from 'node:crypto'
import { createServer, connect, type Socket } from 'node:net'
import { once } from 'node:events'
import { afterEach, expect, it } from 'vitest'
import { newId } from '../../../../src/shared/net'
import {
  BridgeDisplayDecoder,
  BRIDGE_DISPLAY_CHUNK_BYTES,
  BRIDGE_DISPLAY_FRAME_BYTES,
  BRIDGE_DISPLAY_EVENT_TYPES,
  displayHash,
  displayJson,
  displayBase64
} from '../../../../src/shared/bridge'
import type { BridgeDisplayEvent, BridgeDisplayPart } from '../../../../src/shared/bridge'
import { BridgeDisplayEmitter, bridgeDisplayParts } from '../../../../src/mms/bridge/hub'
import { FrameDecoder, encodeFrame } from '../../../../src/mms/protocol/framing'
import { MMS_PROTOCOL_MAX_OUTBOUND_QUEUED_BYTES } from '../../../../src/mms/protocol/types'
import { THREAD_EVENT_TYPES } from '../../../../src/mms/bridge/remote'
const closers: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close()
})
function event(bytes = 100000): BridgeDisplayEvent {
  return {
    ref: { nodeId: newId('node'), entityId: 'thread' },
    stream: newId('stream'),
    epoch: 1,
    seq: 3,
    update: {
      kind: 'snapshot',
      value: { thread: { id: 'thread' }, messages: [{ content: 'x'.repeat(bytes) }] }
    }
  }
}
async function parts(value: BridgeDisplayEvent) {
  const result: BridgeDisplayPart[] = []
  for await (const part of bridgeDisplayParts(value)) result.push(part)
  return result
}
async function deliver(decoder: BridgeDisplayDecoder, values: BridgeDisplayPart[]) {
  const result: BridgeDisplayEvent[] = []
  for (const value of values) {
    const update = await decoder.accept(value)
    if (update) result.push(update)
  }
  return result
}

it('frames and reconstructs a >4MiB display through actual TCP with an awaited socket writer, adopting only the final validated generation', async () => {
  const source = event(5 * 1024 * 1024),
    server = createServer(),
    listening = once(server, 'listening')
  server.listen(0, '127.0.0.1')
  await listening
  closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
  const accepted = once(server, 'connection'),
    client = connect((server.address() as { port: number }).port, '127.0.0.1'),
    connected = once(client, 'connect'),
    socket = (await accepted)[0] as Socket
  closers.push(
    () => client.destroy(),
    () => socket.destroy()
  )
  await connected
  const framing = new FrameDecoder(),
    display = new BridgeDisplayDecoder({ ref: source.ref }),
    shown: BridgeDisplayEvent[] = [],
    errors: unknown[] = []
  let frames = 0,
    maxQueued = 0
  client.on('data', (bytes) => {
    framing.push(bytes)
    for (;;) {
      const value = framing.shift()
      if (!value) break
      frames++
      void display.accept((value as { data: unknown }).data).then(
        (event) => {
          if (event) shown.push(event)
        },
        (error) => errors.push(error)
      )
    }
  })
  const emitter = new BridgeDisplayEmitter({
    emit: (part) =>
      new Promise<void>((resolve, reject) => {
        const frame = encodeFrame({
          kind: 'event',
          sequence: frames + 1,
          type: 'bridge.hub.thread',
          data: part
        })
        expect(frame.length).toBeLessThan(BRIDGE_DISPLAY_FRAME_BYTES + 4)
        socket.write(frame, (error) => (error ? reject(error) : resolve()))
        maxQueued = Math.max(maxQueued, socket.writableLength)
        expect(socket.writableLength).toBeLessThan(MMS_PROTOCOL_MAX_OUTBOUND_QUEUED_BYTES)
      })
  })
  closers.push(async () => {
    emitter.close()
    await emitter.drain()
    display.close()
    await display.drain()
  })
  await emitter.enqueue(source)
  await new Promise<void>((resolve, reject) => {
    const start = Date.now()
    const poll = () => {
      if (shown.length) return resolve()
      if (errors.length) return reject(errors[0])
      if (Date.now() - start > 5000) return reject(new Error('Framed display delivery timed out'))
      setImmediate(poll)
    }
    poll()
  })
  await display.drain()
  expect(shown).toEqual([source])
  expect(errors).toEqual([])
  expect(frames).toBeGreaterThan(160)
  expect(maxQueued).toBeLessThan(MMS_PROTOCOL_MAX_OUTBOUND_QUEUED_BYTES)
  expect(display.usage()).toMatchObject({ transactions: 0, bytes: 0 })
})

it('rejects hash mismatch, reordered/duplicate/truncated chunks, different transaction/generation, foreign stream and unknown fields without display changes', async () => {
  const source = event(),
    original = await parts(source)
  const cases: Array<BridgeDisplayPart[]> = [
    [original[0], original[2], ...original.slice(1)],
    [original[0], original[1], original[1], ...original.slice(2)],
    [original[0], original[1], original.at(-1)!],
    original.map((part, index) => (index === 1 ? { ...part, epoch: 2 } : part)),
    original.map((part, index) => (index === 1 ? { ...part, stream: newId('stream') } : part)),
    original.map((part, index) =>
      index === 1
        ? ({ ...part, update: { ...part.update, transaction: randomUUID() } } as BridgeDisplayPart)
        : part
    ),
    original.map((part, index) =>
      index === 1
        ? ({
            ...part,
            update: {
              ...part.update,
              index: 0,
              data: displayBase64(new Uint8Array(BRIDGE_DISPLAY_CHUNK_BYTES))
            }
          } as BridgeDisplayPart)
        : part
    ),
    original.map((part, index) =>
      index === original.length - 1
        ? ({
            ...part,
            update: { ...part.update, sha256: displayBase64(new Uint8Array(32)) }
          } as BridgeDisplayPart)
        : part
    ),
    [{ ...original[0], authority: 'untrusted' } as BridgeDisplayPart, ...original.slice(1)]
  ]
  for (const corrupt of cases) {
    const decoder = new BridgeDisplayDecoder(),
      shown: BridgeDisplayEvent[] = []
    let failed = false
    for (const part of corrupt) {
      try {
        const framed = new FrameDecoder(),
          wire = encodeFrame({ data: part })
        for (let at = 0; at < wire.length; at += 113) framed.push(wire.subarray(at, at + 113))
        const parsed = framed.shift() as { data: unknown }
        const result = await decoder.accept(parsed.data)
        if (result) shown.push(result)
      } catch {
        failed = true
        break
      }
    }
    expect(failed).toBe(true)
    expect(shown).toEqual([])
    expect(decoder.usage()).toMatchObject({ transactions: 0, bytes: 0 })
    decoder.close()
  }
})

it('validates all bytes before stale-generation suppression and allows a fresh complete reconnect after cancellation/reset', async () => {
  const source = event(),
    values = await parts(source),
    decoder = new BridgeDisplayDecoder()
  await decoder.accept(values[0])
  await decoder.accept(values[1])
  expect(decoder.usage().bytes).toBeGreaterThan(0)
  decoder.reset()
  expect(decoder.usage().bytes).toBe(0)
  await expect(decoder.accept(values.at(-1))).rejects.toMatchObject({ code: 'bad_request' })
  const next = {
    ...source,
    epoch: 2,
    seq: 3,
    update: {
      kind: 'snapshot' as const,
      value: { thread: { id: 'thread' }, messages: [{ content: 'Fresh generation' }] }
    }
  }
  expect(await deliver(decoder, await parts(next))).toEqual([next])
  expect(await deliver(decoder, values)).toEqual([])
  const replay = await parts({ ...next, seq: 4 }),
    controller = new AbortController()
  controller.abort()
  await expect(decoder.accept(replay[0], controller.signal)).rejects.toMatchObject({
    code: 'cancelled'
  })
  expect(await deliver(decoder, replay)).toHaveLength(1)
  const samePosition = {
    ...next,
    seq: 4,
    update: { kind: 'snapshot' as const, value: { different: true } }
  }
  await expect(deliver(decoder, await parts(samePosition))).rejects.toMatchObject({
    code: 'conflict'
  })
  expect(decoder.usage()).toMatchObject({ transactions: 0, bytes: 0 })
})

it('enforces frame, aggregate, concurrency, structure and queue bounds and exact event whitelist', async () => {
  expect(BRIDGE_DISPLAY_EVENT_TYPES).toEqual(THREAD_EVENT_TYPES)
  const source = event(),
    values = await parts(source),
    decoder = new BridgeDisplayDecoder({ maxConcurrent: 1, maxAggregateBytes: 150000 })
  await decoder.accept(values[0])
  await expect(decoder.accept((await parts(event()))[0])).rejects.toMatchObject({
    code: 'too_large'
  })
  expect(decoder.usage()).toMatchObject({ transactions: 0, bytes: 0 })
  const aggregate = new BridgeDisplayDecoder({ maxAggregateBytes: 50000 })
  await expect(aggregate.accept(values[0])).rejects.toMatchObject({ code: 'too_large' })
  const queue = new BridgeDisplayDecoder({ maxQueuedFrames: 1 })
  const first = queue.accept(values[0])
  await expect(queue.accept(values[1])).rejects.toMatchObject({ code: 'too_large' })
  await expect(first).rejects.toMatchObject({ code: 'cancelled' })
  await expect(
    bridgeDisplayParts({
      ...source,
      update: { kind: 'event', type: 'provider.login', data: {} }
    }).next()
  ).rejects.toMatchObject({ code: 'bad_request' })
  await expect(
    deliver(new BridgeDisplayDecoder(), [
      {
        ...source,
        update: { kind: 'snapshot', value: { text: 'x'.repeat(BRIDGE_DISPLAY_FRAME_BYTES) } }
      }
    ])
  ).rejects.toMatchObject({ code: 'too_large' })
  expect(() => displayJson({ bad: Number.POSITIVE_INFINITY })).toThrow()
  expect(() => new BridgeDisplayDecoder({ maxConcurrent: Infinity })).toThrow()
})

it('awaits a stalled sink, bounds pending work and cancels the remaining transaction instead of claiming synchronous emission has backpressure', async () => {
  let release: () => void = () => {}
  const stalled = new Promise<void>((resolve) => {
      release = resolve
    }),
    sent: BridgeDisplayPart[] = [],
    source = event()
  const emitter = new BridgeDisplayEmitter(
    {
      emit: async (part) => {
        sent.push(part)
        await stalled
      }
    },
    { maxQueuedEvents: 1 }
  )
  const pending = emitter.enqueue(source)
  pending.catch(() => {})
  await new Promise<void>((resolve) => {
    const poll = () => (sent.length ? resolve() : setImmediate(poll))
    poll()
  })
  expect(sent).toHaveLength(1)
  await expect(emitter.enqueue({ ...source, seq: 4 })).rejects.toMatchObject({ code: 'too_large' })
  emitter.close()
  release()
  await expect(pending).rejects.toMatchObject({ code: 'cancelled' })
  await emitter.drain()
  expect(sent).toHaveLength(1)
  expect(emitter.usage()).toEqual({ events: 0, bytes: 0 })
})

it('requires canonical UTF-8 snapshot bytes even when a malformed JSON transaction carries its own valid hash', async () => {
  const source = event(),
    malformed = new TextEncoder().encode('{"a":1,"a":2}'),
    transaction = randomUUID(),
    sha256 = await displayHash(malformed),
    binding = { ref: source.ref, stream: source.stream, epoch: 1, seq: 3 }
  const frames: BridgeDisplayPart[] = [
    {
      ...binding,
      update: {
        kind: 'snapshot.begin',
        transaction,
        totalBytes: malformed.length,
        chunks: 1,
        sha256
      }
    },
    {
      ...binding,
      update: { kind: 'snapshot.chunk', transaction, index: 0, data: displayBase64(malformed) }
    },
    { ...binding, update: { kind: 'snapshot.end', transaction, sha256 } }
  ]
  await expect(deliver(new BridgeDisplayDecoder(), frames)).rejects.toMatchObject({
    code: 'bad_request'
  })
})

it('keeps actual TCP writable buffering below the MMS queue bound while a peer is paused and cancels the awaited writer', async () => {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
  const accepted = once(server, 'connection'),
    client = connect((server.address() as { port: number }).port, '127.0.0.1'),
    connected = once(client, 'connect'),
    socket = (await accepted)[0] as Socket
  closers.push(
    () => client.destroy(),
    () => socket.destroy()
  )
  await connected
  client.pause()
  let written = 0,
    waiting = 0,
    maxQueued = 0,
    lastWriteAt = Date.now()
  const emitter = new BridgeDisplayEmitter({
    emit: (part, signal) =>
      new Promise<void>((resolve, reject) => {
        const frame = encodeFrame({ data: part })
        waiting++
        written++
        lastWriteAt = Date.now()
        socket.write(frame, (error) => {
          waiting--
          signal.removeEventListener('abort', abort)
          error ? reject(error) : resolve()
        })
        const abort = () => {
          signal.removeEventListener('abort', abort)
          reject(new Error('Owned writer cancelled'))
        }
        signal.addEventListener('abort', abort, { once: true })
        maxQueued = Math.max(maxQueued, socket.writableLength)
      })
  })
  closers.push(async () => {
    emitter.close()
    await emitter.drain()
  })
  const pending = emitter.enqueue(event(12 * 1024 * 1024))
  pending.catch(() => {})
  await new Promise<void>((resolve, reject) => {
    const start = Date.now(),
      poll = () => {
        if (waiting && socket.writableLength > 0 && Date.now() - lastWriteAt >= 50) return resolve()
        if (Date.now() - start > 4000)
          return reject(
            new Error(
              `Real paused peer did not stall the writer: written=${written}, waiting=${waiting}, read=${client.readableLength}, write=${socket.writableLength}, usage=${JSON.stringify(emitter.usage())}`
            )
          )
        setImmediate(poll)
      }
    poll()
  })
  const stalledAt = written
  await new Promise<void>((resolve) => setTimeout(resolve, 50))
  expect(written).toBe(stalledAt)
  expect(waiting).toBe(1)
  expect(maxQueued).toBeLessThan(MMS_PROTOCOL_MAX_OUTBOUND_QUEUED_BYTES)
  emitter.close()
  await expect(pending).rejects.toBeDefined()
  await emitter.drain()
  expect(emitter.usage()).toEqual({ events: 0, bytes: 0 })
})

it('rejects a synchronous event emitter as a qualified display sink before completing a generation', async () => {
  const emitted: BridgeDisplayPart[] = [],
    emitter = new BridgeDisplayEmitter({
      emit: ((part) => {
        emitted.push(part)
      }) as any
    })
  await expect(emitter.enqueue(event())).rejects.toMatchObject({ code: 'bad_request' })
  await emitter.drain()
  expect(emitted).toHaveLength(1)
  expect(emitted[0].update.kind).toBe('snapshot.begin')
  expect(emitter.usage()).toEqual({ events: 0, bytes: 0 })
})
