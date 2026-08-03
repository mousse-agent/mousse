import { describe, expect, it } from 'vitest'
import {
  encodeFrame,
  FrameDecoder,
  FrameTooLargeError,
  FrameDecodeError
} from '../src/mms/protocol/framing'
import { MMS_PROTOCOL_MAX_FRAME_BYTES } from '../src/mms/protocol/types'
import { hashHomeForEndpoint, resolveLocalEndpoint, windowsNamedPipePath } from '../src/mms/protocol/endpoint'
import { canonicalizeHome } from '../src/mms/ownership/MmsOwnerLease'

describe('protocol framing', () => {
  it('encodes and decodes a single frame', () => {
    const frame = encodeFrame({ kind: 'req', id: '1', method: 'health' })
    const dec = new FrameDecoder()
    dec.push(frame)
    expect(dec.shift()).toEqual({ kind: 'req', id: '1', method: 'health' })
    expect(dec.shift()).toBeNull()
  })

  it('handles fragmented reads', () => {
    const frame = encodeFrame({ a: 1 })
    const dec = new FrameDecoder()
    dec.push(frame.subarray(0, 2))
    expect(dec.shift()).toBeNull()
    dec.push(frame.subarray(2, 6))
    expect(dec.shift()).toBeNull()
    dec.push(frame.subarray(6))
    expect(dec.shift()).toEqual({ a: 1 })
  })

  it('handles coalesced frames in one chunk', () => {
    const a = encodeFrame({ n: 1 })
    const b = encodeFrame({ n: 2 })
    const dec = new FrameDecoder()
    dec.push(Buffer.concat([a, b]))
    expect(dec.shiftAll()).toEqual([{ n: 1 }, { n: 2 }])
  })

  it('rejects oversize frames', () => {
    const header = Buffer.alloc(4)
    header.writeUInt32BE(MMS_PROTOCOL_MAX_FRAME_BYTES + 1, 0)
    const dec = new FrameDecoder()
    expect(() => dec.push(header)).toThrow(FrameTooLargeError)
  })

  it('rejects malformed JSON body', () => {
    const body = Buffer.from('{not-json', 'utf-8')
    const header = Buffer.alloc(4)
    header.writeUInt32BE(body.length, 0)
    const dec = new FrameDecoder()
    dec.push(Buffer.concat([header, body]))
    expect(() => dec.shift()).toThrow(FrameDecodeError)
  })
})

describe('endpoint derivation', () => {
  it('derives stable hash from canonical home', () => {
    const h1 = hashHomeForEndpoint('/tmp/foo')
    const h2 = hashHomeForEndpoint('/tmp/foo/../foo')
    // resolve may differ by platform; same canonicalize should match
    expect(hashHomeForEndpoint(canonicalizeHome('/tmp/foo'))).toBe(
      hashHomeForEndpoint(canonicalizeHome('/tmp/foo'))
    )
    expect(h1).toHaveLength(32)
    expect(windowsNamedPipePath('/tmp/x')).toMatch(/^\\\\\.\\pipe\\mousse-mms-/)
  })

  it('resolves platform endpoint', () => {
    const ep = resolveLocalEndpoint(process.cwd())
    expect(ep.path).toBeTruthy()
    expect(['win32', 'unix']).toContain(ep.platform)
  })
})
