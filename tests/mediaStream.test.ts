import { describe, expect, it, vi } from 'vitest'
import {
  MediaStreamRegistry,
  MOUSSE_MEDIA_SCHEME,
  parseByteRange
} from '../src/main/ipc/mediaStream'

describe('parseByteRange', () => {
  it.each([
    { label: 'no header', header: null, size: 100, expected: { kind: 'full' } },
    { label: 'empty header', header: '   ', size: 100, expected: { kind: 'full' } },
    { label: 'empty file without range', header: null, size: 0, expected: { kind: 'full' } },
    { label: 'closed range', header: 'bytes=0-9', size: 100, expected: { kind: 'partial', start: 0, end: 9 } },
    { label: 'single byte', header: 'bytes=5-5', size: 100, expected: { kind: 'partial', start: 5, end: 5 } },
    { label: 'end clamped to eof', header: 'bytes=90-500', size: 100, expected: { kind: 'partial', start: 90, end: 99 } },
    { label: 'open-ended range', header: 'bytes=25-', size: 100, expected: { kind: 'partial', start: 25, end: 99 } },
    { label: 'suffix range', header: 'bytes=-10', size: 100, expected: { kind: 'partial', start: 90, end: 99 } },
    { label: 'suffix larger than file', header: 'bytes=-500', size: 100, expected: { kind: 'partial', start: 0, end: 99 } },
    { label: 'range on empty file', header: 'bytes=0-0', size: 0, expected: { kind: 'invalid' } },
    { label: 'start at eof', header: 'bytes=100-', size: 100, expected: { kind: 'invalid' } },
    { label: 'start past eof', header: 'bytes=120-130', size: 100, expected: { kind: 'invalid' } },
    { label: 'end before start', header: 'bytes=20-10', size: 100, expected: { kind: 'invalid' } },
    { label: 'zero suffix', header: 'bytes=-0', size: 100, expected: { kind: 'invalid' } },
    { label: 'bare dash', header: 'bytes=-', size: 100, expected: { kind: 'invalid' } },
    { label: 'multi-range', header: 'bytes=0-5,10-15', size: 100, expected: { kind: 'invalid' } },
    { label: 'non-bytes unit', header: 'items=0-5', size: 100, expected: { kind: 'invalid' } }
  ])('handles $label ($header)', ({ header, size, expected }) => {
    expect(parseByteRange(header, size)).toEqual(expected)
  })
})

describe('MediaStreamRegistry', () => {
  const makePayload = (length: number) => Buffer.from(Array.from({ length }, (_, index) => index % 251))

  const registerBuffer = (registry: MediaStreamRegistry, payload: Buffer, overrides?: { senderId?: number; profileId?: string; mtimeMs?: number; mimeType?: string }) => {
    const reads: Array<{ offset: number; length: number }> = []
    let current = payload
    let currentMtimeMs = overrides?.mtimeMs ?? 1_000
    const { token, url } = registry.register({
      senderId: overrides?.senderId ?? 1,
      profileId: overrides?.profileId ?? 'profile-a',
      mimeType: overrides?.mimeType ?? 'video/mp4',
      size: payload.length,
      mtimeMs: currentMtimeMs,
      readPiece: async (offset, length) => {
        reads.push({ offset, length })
        const slice = current.subarray(offset, offset + length)
        return {
          mimeType: overrides?.mimeType ?? 'video/mp4',
          size: current.length,
          mtimeMs: currentMtimeMs,
          data: slice.toString('base64')
        }
      }
    })
    return {
      token,
      url,
      reads,
      replaceFile: (next: Buffer, nextMtimeMs: number) => {
        current = next
        currentMtimeMs = nextMtimeMs
      }
    }
  }

  it('streams 206 byte ranges in bounded chunks and stops reading on cancel', async () => {
    const registry = new MediaStreamRegistry(8)
    const payload = makePayload(40)
    const { url, reads } = registerBuffer(registry, payload)

    expect(url.startsWith(`${MOUSSE_MEDIA_SCHEME}://asset/`)).toBe(true)

    const partial = await registry.handleRequest(new Request(url, { headers: { Range: 'bytes=10-25' } }))
    expect(partial.status).toBe(206)
    expect(partial.headers.get('content-type')).toBe('video/mp4')
    expect(partial.headers.get('accept-ranges')).toBe('bytes')
    expect(partial.headers.get('content-range')).toBe('bytes 10-25/40')
    expect(partial.headers.get('content-length')).toBe('16')
    const body = Buffer.from(await partial.arrayBuffer())
    expect(body.equals(payload.subarray(10, 26))).toBe(true)
    expect(reads).toEqual([
      { offset: 10, length: 8 },
      { offset: 18, length: 8 }
    ])

    // Open-ended range pulls only what the consumer reads before cancelling (e.g. a seek).
    reads.length = 0
    const openEnded = await registry.handleRequest(new Request(url, { headers: { Range: 'bytes=0-' } }))
    expect(openEnded.status).toBe(206)
    expect(openEnded.headers.get('content-range')).toBe('bytes 0-39/40')
    const reader = openEnded.body!.getReader()
    const first = await reader.read()
    expect(Buffer.from(first.value!).equals(payload.subarray(0, 8))).toBe(true)
    await reader.cancel()
    expect(reads).toEqual([{ offset: 0, length: 8 }])
  })

  it('answers HEAD without reading file bytes, and returns 416 for unsatisfiable ranges', async () => {
    const registry = new MediaStreamRegistry(16)
    const payload = makePayload(32)
    const { url, reads } = registerBuffer(registry, payload)

    const head = await registry.handleRequest(new Request(url, { method: 'HEAD' }))
    expect(head.status).toBe(200)
    expect(head.headers.get('content-length')).toBe('32')
    expect(head.headers.get('accept-ranges')).toBe('bytes')
    expect(reads).toEqual([])

    const invalid = await registry.handleRequest(new Request(url, { headers: { Range: 'bytes=999-' } }))
    expect(invalid.status).toBe(416)
    expect(invalid.headers.get('content-range')).toBe('bytes */32')
    expect(reads).toEqual([])
  })

  it('enforces method, token ownership, profile binding, and cleanup', async () => {
    const registry = new MediaStreamRegistry(16)
    const payload = makePayload(16)
    const { url } = registerBuffer(registry, payload, { senderId: 7, profileId: 'profile-a' })

    expect((await registry.handleRequest(new Request(url, { method: 'POST' }))).status).toBe(405)
    expect((await registry.handleRequest(new Request(`${MOUSSE_MEDIA_SCHEME}://asset/missing`))).status).toBe(404)

    // Profile switch refuses stale handles.
    let activeProfile = 'profile-a'
    const ok = await registry.handleRequest(new Request(url, { method: 'HEAD' }), () => activeProfile)
    expect(ok.status).toBe(200)
    activeProfile = 'profile-b'
    const forbidden = await registry.handleRequest(new Request(url, { method: 'HEAD' }), () => activeProfile)
    expect(forbidden.status).toBe(403)

    // Another sender cannot release sender 7's handle.
    expect(registry.release(url, 8)).toBe(false)
    expect(registry.size).toBe(1)
    expect(registry.release(url, 7)).toBe(true)
    expect(registry.size).toBe(0)
    expect((await registry.handleRequest(new Request(url))).status).toBe(404)
  })

  it('errors an in-flight stream when the file changes mid-read', async () => {
    const registry = new MediaStreamRegistry(4)
    const payload = makePayload(12)
    const { url, replaceFile } = registerBuffer(registry, payload, { mtimeMs: 100 })

    const response = await registry.handleRequest(new Request(url))
    const reader = response.body!.getReader()
    await reader.read()
    replaceFile(makePayload(12), 200)
    await expect(reader.read()).rejects.toThrow(/changed while streaming/i)
  })

  it('releases all handles when a sender disconnects', () => {
    const registry = new MediaStreamRegistry(16)
    registerBuffer(registry, makePayload(8), { senderId: 1 })
    registerBuffer(registry, makePayload(8), { senderId: 1 })
    registerBuffer(registry, makePayload(8), { senderId: 2 })
    expect(registry.size).toBe(3)
    registry.releaseForSender(1)
    expect(registry.size).toBe(1)
  })

  it('returns 200 with empty body for a 0-byte video file', async () => {
    const registry = new MediaStreamRegistry(16)
    const readPiece = vi.fn()
    const { url } = registry.register({
      senderId: 1,
      profileId: 'p',
      mimeType: 'video/mp4',
      size: 0,
      readPiece
    })
    const response = await registry.handleRequest(new Request(url))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-length')).toBe('0')
    expect((await response.arrayBuffer()).byteLength).toBe(0)
    expect(readPiece).not.toHaveBeenCalled()
  })
})
