import { EventEmitter } from 'node:events'
import type { Socket } from 'node:net'
import { describe, expect, it, vi } from 'vitest'
import { EnvelopeAssembler, envelopeFrames } from '../src/mms/protocol/envelopeChunks'
import { OUTBOUND_MAX_PENDING, OutboundWriter } from '../src/mms/protocol/outboundWriter'
import { OUTBOUND_BATCH_BYTES } from '../src/mms/protocol/connectionEventWriter'
import { supersedingKey } from '../src/mms/protocol/server'
import { FrameDecoder } from '../src/mms/protocol/framing'
import { parseEnvelope } from '../src/mms/protocol/validators'
import { MMS_PROTOCOL_CHUNK_BYTES, MMS_PROTOCOL_MAX_ENVELOPE_BYTES, type ProtocolEnvelopeChunk } from '../src/mms/protocol/types'

function chunks(value: unknown): ProtocolEnvelopeChunk[] {
  const decoder = new FrameDecoder()
  const result: ProtocolEnvelopeChunk[] = []
  for (const frame of envelopeFrames(Buffer.from(JSON.stringify(value)), true)) {
    decoder.push(frame)
    for (const raw of decoder.shiftAll()) {
      const parsed = parseEnvelope(raw)
      expect(parsed?.kind).toBe('envelope_chunk')
      result.push(parsed as ProtocolEnvelopeChunk)
    }
  }
  return result
}

describe('bounded envelope transfer', () => {
  it('reconstructs Unicode exceeding the frame limit without changing content', () => {
    const value = { kind: 'res', id: 'test', ok: true, result: '🫧字'.repeat(700_000) }
    const assembler = new EnvelopeAssembler(() => {})
    let result: unknown = null
    for (const chunk of chunks(value)) result = assembler.accept(chunk)
    expect(result).toEqual(value)
    expect(assembler.active).toBe(false)
  })
  it('rejects reordered chunks, alternate transfers, noncanonical base64 and excess aggregate bytes', () => {
    const parts = chunks({ content: 'x'.repeat(MMS_PROTOCOL_CHUNK_BYTES * 2) })
    for (const corrupt of [parts[1], { ...parts[0], totalBytes: MMS_PROTOCOL_MAX_ENVELOPE_BYTES + 1 }, { ...parts[0], data: parts[0].data.slice(1) }]) {
      const assembler = new EnvelopeAssembler(() => {})
      expect(() => assembler.accept(corrupt)).toThrow()
      expect(assembler.active).toBe(false)
    }
    const assembler = new EnvelopeAssembler(() => {})
    assembler.accept(parts[0])
    expect(() => assembler.accept({ ...parts[1], transferId: 'other' })).toThrow()
  })
  it('cleans up partial transfers on timeout and explicit disconnect reset', () => {
    vi.useFakeTimers()
    try {
      const timeout = vi.fn()
      const assembler = new EnvelopeAssembler(timeout, 100)
      const first = chunks({ content: 'x'.repeat(MMS_PROTOCOL_CHUNK_BYTES * 2) })[0]
      assembler.accept(first)
      vi.advanceTimersByTime(100)
      expect(timeout).toHaveBeenCalledOnce()
      expect(assembler.active).toBe(false)
      assembler.accept(first)
      assembler.reset()
      vi.advanceTimersByTime(100)
      expect(timeout).toHaveBeenCalledOnce()
    } finally { vi.useRealTimers() }
  })
  it('expires a transfer after sixty seconds even while chunks keep arriving', () => {
    vi.useFakeTimers()
    try {
      const timeout = vi.fn()
      const assembler = new EnvelopeAssembler(timeout)
      const parts = chunks({ content: 'x'.repeat(MMS_PROTOCOL_CHUNK_BYTES * 8) })
      for (let index = 0; index < 5; index++) {
        assembler.accept(parts[index])
        vi.advanceTimersByTime(14_000)
      }
      expect(timeout).toHaveBeenCalledOnce()
      expect(assembler.active).toBe(false)
    } finally { vi.useRealTimers() }
  })

  it('writes a connection event frame only after the previous write callback and drain', async () => {
    const socket = new EventEmitter() as EventEmitter & { destroyed: boolean; writableLength: number; write: ReturnType<typeof vi.fn> }
    socket.destroyed = false
    socket.writableLength = 0
    const callbacks: ((error?: Error) => void)[] = []
    socket.write = vi.fn((_frame, callback) => { callbacks.push(callback); return false })
    const failure = vi.fn()
    const writer = new OutboundWriter(socket as unknown as Socket, failure)
    const first = writer.enqueue(2, () => [Buffer.from('a'), Buffer.from('b')], undefined, undefined, { flush: true })!
    const second = writer.enqueue(1, () => [Buffer.from('c')], undefined, undefined, { flush: true })!
    await Promise.resolve()
    expect(socket.write).toHaveBeenCalledTimes(1)
    callbacks[0]()
    await Promise.resolve()
    expect(socket.write).toHaveBeenCalledTimes(1)
    socket.emit('drain')
    await new Promise(resolve => setImmediate(resolve))
    expect(socket.write).toHaveBeenCalledTimes(2)
    callbacks[1](); socket.emit('drain')
    await first
    await new Promise(resolve => setImmediate(resolve))
    expect(socket.write).toHaveBeenCalledTimes(3)
    callbacks[2](); socket.emit('drain')
    await second
    writer.close()
    expect(failure).not.toHaveBeenCalled()
  })
})

describe('outbound producer limits', () => {
  it('bounds logical queued bytes before writing them to a paused peer', async () => {
    const socket = new EventEmitter() as unknown as Socket
    Object.assign(socket, { destroyed: false, writableLength: 0, write: vi.fn(() => false) })
    const failure = vi.fn()
    const writer = new OutboundWriter(socket, failure)
    const first = writer.enqueue(MMS_PROTOCOL_MAX_ENVELOPE_BYTES, () => [Buffer.from('x')])!
    const second = writer.enqueue(MMS_PROTOCOL_MAX_ENVELOPE_BYTES, () => [Buffer.from('x')])!
    first.catch(() => {}); second.catch(() => {})
    expect(writer.enqueue(1, () => [Buffer.from('x')])).toBeNull()
    expect(failure).toHaveBeenCalledOnce()
    writer.close()
    await Promise.allSettled([first, second])
  })
  it('closes a stalled peer instead of buffering more frames indefinitely', async () => {
    vi.useFakeTimers()
    try {
      const socket = bufferingSocket()
      const failure = vi.fn()
      const writer = new OutboundWriter(socket, failure)
      const operation = writer.enqueue(OUTBOUND_BATCH_BYTES + 1, () => [Buffer.alloc(OUTBOUND_BATCH_BYTES), Buffer.from('b')])!
      operation.catch(() => {})
      await Promise.resolve()
      await vi.advanceTimersByTimeAsync(15_000)
      await expect(operation).rejects.toThrow(/did not drain/)
      expect(socket.write).toHaveBeenCalledOnce()
      expect(socket.destroy).toHaveBeenCalledOnce()
      expect(failure).toHaveBeenCalledOnce()
      writer.close()
    } finally { vi.useRealTimers() }
  })

  it('bounds producer item count even when envelopes are tiny', async () => {
    const socket = new EventEmitter() as unknown as Socket
    Object.assign(socket, { destroyed: false, writableLength: 0, write: vi.fn(() => false) })
    const failure = vi.fn()
    const writer = new OutboundWriter(socket, failure)
    const pending = Array.from({ length: 1024 }, () => writer.enqueue(1, () => [Buffer.from('x')])!)
    pending.forEach(operation => operation.catch(() => {}))
    expect(writer.enqueue(1, () => [Buffer.from('x')])).toBeNull()
    expect(failure).toHaveBeenCalledOnce()
    writer.close()
    await Promise.allSettled(pending)
  })

  it('hands frames to Node without waiting for each write to finish while the peer keeps up', async () => {
    const socket = bufferingSocket()
    const writer = new OutboundWriter(socket, vi.fn())
    const sent = [writer.enqueue(1, () => [Buffer.from('a')])!, writer.enqueue(1, () => [Buffer.from('b')])!, writer.enqueue(1, () => [Buffer.from('c')])!]
    await Promise.all(sent)
    // No write callback has run: the frames are in Node's buffer, under the batch size.
    expect(socket.write).toHaveBeenCalledTimes(3)
    writer.close()
  })

  it('waits for a drain once a batch is buffered, then continues', async () => {
    const socket = bufferingSocket()
    const writer = new OutboundWriter(socket, vi.fn())
    const big = writer.enqueue(OUTBOUND_BATCH_BYTES, () => [Buffer.alloc(OUTBOUND_BATCH_BYTES)])!
    const next = writer.enqueue(1, () => [Buffer.from('x')])!
    await big
    await new Promise(resolve => setImmediate(resolve))
    expect(socket.write).toHaveBeenCalledTimes(1)
    socket.flush()
    await next
    expect(socket.write).toHaveBeenCalledTimes(2)
    writer.close()
  })

  it('sends a slow peer only the latest of the states still waiting', async () => {
    const socket = bufferingSocket()
    const failure = vi.fn()
    const writer = new OutboundWriter(socket, failure)
    // Fills the batch, so everything after waits for the peer.
    void writer.enqueue(OUTBOUND_BATCH_BYTES, () => [Buffer.alloc(OUTBOUND_BATCH_BYTES)])
    const blocker = writer.enqueue(1, () => [Buffer.from('blocked')])!
    const steps = Array.from({ length: OUTBOUND_MAX_PENDING + 10 }, (_, index) =>
      writer.enqueue(1, () => [Buffer.from(`state-${index}`)], undefined, undefined, { supersedes: 'message' })!)
    const other = writer.enqueue(1, () => [Buffer.from('other')])!
    // A superseded state no longer counts, so the queue never reaches its limit.
    expect(failure).not.toHaveBeenCalled()
    await Promise.all(steps.slice(0, -1))
    socket.flush()
    await Promise.all([blocker, steps.at(-1), other])
    const written = socket.write.mock.calls.slice(1).map(([frame]) => (frame as Buffer).toString())
    expect(written).toEqual(['blocked', `state-${OUTBOUND_MAX_PENDING + 9}`, 'other'])
    writer.close()
  })

  it('does not replace a state whose write has begun', async () => {
    const socket = bufferingSocket()
    const writer = new OutboundWriter(socket, vi.fn())
    const first = writer.enqueue(1, () => [Buffer.from('one')], undefined, undefined, { supersedes: 'k' })!
    await first
    const second = writer.enqueue(1, () => [Buffer.from('two')], undefined, undefined, { supersedes: 'k' })!
    await second
    expect(socket.write.mock.calls.map(([frame]) => (frame as Buffer).toString())).toEqual(['one', 'two'])
    writer.close()
  })
})

describe('superseding events', () => {
  const event = (type: string, data: unknown, threadId?: string) => ({ kind: 'event', type, sequence: 1, data, ...(threadId ? { threadId } : {}), profileId: 'p' })
  it('keys a message update by its thread and message', () => {
    const key = supersedingKey(event('thread.message-updated', { message: { id: 'm1', content: 'a' } }, 't1'))
    expect(key).toBe(supersedingKey(event('thread.message-updated', { message: { id: 'm1', content: 'ab' } }, 't1')))
    expect(key).not.toBe(supersedingKey(event('thread.message-updated', { message: { id: 'm2' } }, 't1')))
    expect(key).not.toBe(supersedingKey(event('thread.message-updated', { message: { id: 'm1' } }, 't2')))
  })
  it('keys whole lists by type and leaves other events and responses alone', () => {
    expect(supersedingKey(event('threads.updated', { threads: [] }))).toBe(supersedingKey(event('threads.updated', { threads: [1] }, 't9')))
    expect(supersedingKey(event('activity.snapshot', { activity: {} }))).toBeDefined()
    expect(supersedingKey(event('thread.message', { message: { id: 'm1' } }, 't1'))).toBeUndefined()
    expect(supersedingKey(event('turn.state', { phase: 'idle' }, 't1'))).toBeUndefined()
    expect(supersedingKey({ kind: 'res', id: '1', ok: true, result: {} })).toBeUndefined()
  })
})

/** A socket that buffers like Node's: `write` returns false at the high-water mark, and `flush` drains it. */
function bufferingSocket(): Socket & { write: ReturnType<typeof vi.fn>; flush: () => void } {
  const socket = new EventEmitter() as EventEmitter & { destroyed: boolean; writableLength: number; writableNeedDrain: boolean; write: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn>; flush: () => void }
  Object.assign(socket, { destroyed: false, writableLength: 0, writableNeedDrain: false, destroy: vi.fn() })
  socket.write = vi.fn((frame: Buffer) => {
    socket.writableLength += frame.length
    if (socket.writableLength >= 16 * 1024) socket.writableNeedDrain = true
    return !socket.writableNeedDrain
  })
  socket.flush = () => {
    socket.writableLength = 0
    if (!socket.writableNeedDrain) return
    socket.writableNeedDrain = false
    socket.emit('drain')
  }
  return socket as unknown as Socket & { write: ReturnType<typeof vi.fn>; flush: () => void }
}
