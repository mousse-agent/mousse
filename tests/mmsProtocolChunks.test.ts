import { EventEmitter } from 'node:events'
import type { Socket } from 'node:net'
import { describe, expect, it, vi } from 'vitest'
import { EnvelopeAssembler, envelopeFrames } from '../src/mms/protocol/envelopeChunks'
import { OutboundWriter } from '../src/mms/protocol/outboundWriter'
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

  it('does not enqueue another frame until write callback and drain complete', async () => {
    const socket = new EventEmitter() as EventEmitter & { destroyed: boolean; writableLength: number; write: ReturnType<typeof vi.fn> }
    socket.destroyed = false
    socket.writableLength = 0
    const callbacks: ((error?: Error) => void)[] = []
    socket.write = vi.fn((_frame, callback) => { callbacks.push(callback); return false })
    const failure = vi.fn()
    const writer = new OutboundWriter(socket as unknown as Socket, failure)
    const first = writer.enqueue(2, () => [Buffer.from('a'), Buffer.from('b')])!
    const second = writer.enqueue(1, () => [Buffer.from('c')])!
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
      const socket = new EventEmitter() as unknown as Socket
      Object.assign(socket, { destroyed: false, writableLength: 0, write: vi.fn(() => false), destroy: vi.fn() })
      const failure = vi.fn()
      const writer = new OutboundWriter(socket, failure)
      const operation = writer.enqueue(2, () => [Buffer.from('a'), Buffer.from('b')])!
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
})
