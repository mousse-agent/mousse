import { createConnection, createServer, type Server, type Socket } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MousseMainService } from '../src/mms/MousseMainService'
import { MmsProtocolServer } from '../src/mms/protocol/server'
import { LocalMmsClient } from '../src/mms/protocol/client'
import { encodeFrame, FrameDecoder } from '../src/mms/protocol/framing'
import { EnvelopeAssembler, envelopeBudget, envelopeFrames, requestFrames } from '../src/mms/protocol/envelopeChunks'
import { asChatImages } from '../src/mms/protocol/validators'
import type { ProtocolEnvelopeChunk } from '../src/mms/protocol/types'
import {
  MMS_PROTOCOL_CHUNK_CAPABILITY,
  MMS_PROTOCOL_INBOUND_CHUNK_CAPABILITY,
  MMS_PROTOCOL_MAX_INBOUND_ENVELOPE_BYTES,
  MMS_PROTOCOL_MAX_FRAME_BYTES,
  MMS_PROTOCOL_VERSION
} from '../src/mms/protocol/types'
import { IMAGE_MAX_DATA_CHARS, IMAGE_PREVIEW_DATA_CHARS, MESSAGE_IMAGES_MAX_DATA_CHARS, MESSAGE_MAX_IMAGES } from '../src/shared/imageLimits'
import { scriptTurns } from './net/bridge/hub/fixture'

/**
 * Requests larger than one frame (a message with large images) go from the client to the service in chunks, only
 * when the service advertises `envelope-chunks-inbound.v1`; the service puts them back together within bounds. A
 * message whose images are refused never reaches the thread's transcript.
 */

const image = (name: string, chars: number, mimeType = 'image/png') => ({ name, mimeType, data: 'A'.repeat(chars) })

function pipePath(): string {
  return process.platform === 'win32' ? `\\\\.\\pipe\\mousse-inbound-${randomUUID()}` : join(tmpdir(), `mousse-inbound-${randomUUID()}.sock`)
}

describe('requestFrames', () => {
  it('sends one frame when it fits, chunks only to a service that takes them, and refuses past what can be sent', () => {
    const small = { kind: 'req', id: '1', method: 'm', params: { text: 'x' } }
    const large = { kind: 'req', id: '2', method: 'm', params: { text: 'x'.repeat(MMS_PROTOCOL_MAX_FRAME_BYTES) } }
    const huge = { kind: 'req', id: '3', method: 'm', params: { text: 'x'.repeat(MMS_PROTOCOL_MAX_INBOUND_ENVELOPE_BYTES) } }
    const rows: Array<[string, unknown, boolean, 'frame' | 'chunks' | number]> = [
      ['fits, chunk-capable', small, true, 'frame'],
      ['fits, older service', small, false, 'frame'],
      ['past a frame, chunk-capable', large, true, 'chunks'],
      ['past a frame, older service', large, false, MMS_PROTOCOL_MAX_FRAME_BYTES],
      ['past an inbound envelope', huge, true, MMS_PROTOCOL_MAX_INBOUND_ENVELOPE_BYTES]
    ]
    for (const [label, value, chunked, expected] of rows) {
      const out = requestFrames(value, chunked)
      if (typeof expected === 'number') {
        expect('tooLarge' in out && out.tooLarge.max, label).toBe(expected)
        continue
      }
      expect('frames' in out, label).toBe(true)
      const frames = (out as { frames: Buffer[] }).frames
      const decoder = new FrameDecoder()
      for (const frame of frames) decoder.push(frame)
      const decoded = decoder.shiftAll() as Array<{ kind: string }>
      expect(decoded.every((frame) => frame.kind === (expected === 'frame' ? 'req' : 'envelope_chunk')), label).toBe(true)
      expect(decoded.length > 1, label).toBe(expected === 'chunks')
    }
  })
})

describe('a message with the most images it may carry', () => {
  it('takes 80 MB of images (as base64) and refuses more, and fits in one chunked request', () => {
    // One shared string per image keeps the test's memory to one image.
    const full = 'A'.repeat(IMAGE_MAX_DATA_CHARS)
    const count = Math.floor(MESSAGE_IMAGES_MAX_DATA_CHARS / IMAGE_MAX_DATA_CHARS)
    const rest = 'A'.repeat(MESSAGE_IMAGES_MAX_DATA_CHARS - count * IMAGE_MAX_DATA_CHARS)
    const most = [...Array.from({ length: count }, (_, index) => ({ name: `${index}.png`, mimeType: 'image/png', data: full })), { name: 'rest.png', mimeType: 'image/png', data: rest }]
    expect(most.length).toBeLessThanOrEqual(MESSAGE_MAX_IMAGES)
    expect(asChatImages(most)).toHaveLength(most.length)
    expect(() => asChatImages([...most.slice(0, -1), { ...most.at(-1)!, data: rest + 'AAAA' }])).toThrow(/larger together/)
    // With its text and the JSON around it, it is still inside one inbound request.
    expect(MESSAGE_IMAGES_MAX_DATA_CHARS + 2 * 1024 * 1024).toBeLessThan(MMS_PROTOCOL_MAX_INBOUND_ENVELOPE_BYTES)
  })
})

describe('chunked requests held at once', () => {
  it('reserve their whole size from one budget; a transfer past it is refused, and a finished or dropped one gives it back', () => {
    const budget = envelopeBudget(3 * 256 * 1024)
    const chunk = (transferId: string, totalBytes: number): ProtocolEnvelopeChunk => ({ kind: 'envelope_chunk', transferId, index: 0, totalBytes, data: Buffer.alloc(Math.min(totalBytes, 256 * 1024), 32).toString('base64') })
    const first = new EnvelopeAssembler(() => {}, 15_000, 4 * 1024 * 1024, budget)
    const second = new EnvelopeAssembler(() => {}, 15_000, 4 * 1024 * 1024, budget)
    expect(first.accept(chunk('one', 2 * 256 * 1024))).toBeNull()
    expect(() => second.accept(chunk('two', 2 * 256 * 1024))).toThrow(/at once/)
    first.reset()
    expect(budget.used).toBe(0)
    expect(second.accept(chunk('two', 2 * 256 * 1024))).toBeNull()
    second.reset()
  })
})

describe('client against a service without inbound chunks', () => {
  let fake: Server
  let endpoint: string
  const received: Array<{ kind: string; method?: string }> = []

  beforeEach(async () => {
    received.length = 0
    endpoint = pipePath()
    fake = createServer((socket) => {
      const decoder = new FrameDecoder()
      socket.on('data', (chunk) => {
        decoder.push(chunk)
        for (const frame of decoder.shiftAll() as Array<{ kind: string; method?: string }>) {
          received.push(frame)
          if (frame.kind === 'hello') {
            socket.write(encodeFrame({ kind: 'hello_ok', protocolVersion: MMS_PROTOCOL_VERSION, instanceId: 'older', capabilities: [MMS_PROTOCOL_CHUNK_CAPABILITY], globalSequence: 0 }))
          }
        }
      })
      socket.on('error', () => undefined)
    })
    await new Promise<void>((resolve) => fake.listen(endpoint, resolve))
  })

  afterEach(async () => {
    await new Promise<void>((resolve) => fake.close(() => resolve()))
  })

  it('refuses a request larger than one frame before writing it, and keeps the connection', async () => {
    const client = new LocalMmsClient({ homeDir: tmpdir(), ownerToken: 'token', endpoint, clientType: 'test' })
    await client.connect()
    await expect(client.request('orchestrator.send', { threadId: 't', content: 'big', images: [image('big.png', MMS_PROTOCOL_MAX_FRAME_BYTES)] }))
      .rejects.toMatchObject({ code: 'request_too_large' })
    expect(received.filter((frame) => frame.kind !== 'hello')).toEqual([])
    void client.request('health', {}, 60_000).catch(() => undefined)
    await vi.waitFor(() => expect(received.some((frame) => frame.kind === 'req')).toBe(true))
    expect(received.some((frame) => frame.kind === 'envelope_chunk')).toBe(false)
    await client.close()
  })
})

describe('service taking requests in chunks', () => {
  let home: string
  let mms: MousseMainService
  let server: MmsProtocolServer
  let ownerToken: string
  let endpoint: string

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'mousse-inbound-'))
    process.env.MOUSSE_HOME = home
    mms = await MousseMainService.create({ homeDir: home, headless: true, ownerKind: 'test' })
    await mms.start()
    mms.settings.set({ provider: { llmProvider: 'openai', model: 'test' } })
    scriptTurns(mms, async () => 'ok')
    ownerToken = mms.getOwnerLease()!.owner.token
    server = new MmsProtocolServer({ mms, ownerToken, version: 'test' })
    endpoint = await server.start()
  })

  afterEach(async () => {
    await server.stop()
    await mms.stop()
    // On Windows the stopped profile's folder can stay held a moment (as in `botContinuationPermission`); a folder left behind is no failure here.
    try { rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error }
    delete process.env.MOUSSE_HOME
  })

  it('takes a message whose images are larger than one frame, and sends windows its images within the update budget', async () => {
    const client = new LocalMmsClient({ homeDir: home, ownerToken, endpoint, clientType: 'test' })
    await client.connect()
    const events: Array<{ type: string; data: { message?: { role?: string; images?: Array<{ data?: string }> } } }> = []
    client.onEvent((event) => events.push(event as never))
    await client.subscribe(0)
    const thread = mms.threads.createThread('Large images')
    const images = [image('a.png', 3 * 1024 * 1024), image('b.png', 3 * 1024 * 1024), image('c.png', 3 * 1024 * 1024)]
    await client.request('orchestrator.send', { threadId: thread.id, content: 'look', images })

    const saved = mms.orchestrator.getMessages(thread.id).find((message) => message.role === 'user')
    expect(saved?.images?.map((entry) => entry.data.length)).toEqual(images.map((entry) => entry.data.length))
    // The live update carries no more image data than its budget; each image is fetched when it is shown.
    await vi.waitFor(() => expect(events.some((event) => event.type === 'thread.message' && event.data.message?.role === 'user')).toBe(true))
    const live = events.find((event) => event.type === 'thread.message' && event.data.message?.role === 'user')!
    const liveChars = (live.data.message?.images ?? []).reduce((sum, entry) => sum + (entry.data?.length ?? 0), 0)
    expect(liveChars).toBeLessThanOrEqual(IMAGE_PREVIEW_DATA_CHARS)
    const fetched = await client.request<{ data: string }>('thread.messageImage', { threadId: thread.id, messageId: saved!.id, index: 2 })
    expect(fetched.data.length).toBe(images[2]!.data.length)
    await client.close()
  })

  it('refuses images past the limits or of a type providers do not take, leaving no row in the transcript', async () => {
    const client = new LocalMmsClient({ homeDir: home, ownerToken, endpoint, clientType: 'test' })
    await client.connect()
    const thread = mms.threads.createThread('Refused images')
    const rows: Array<[string, unknown[], string]> = [
      ['one image past its size', [image('huge.png', IMAGE_MAX_DATA_CHARS + 4)], 'image_too_large'],
      ['a type no provider takes', [image('photo.bmp', 64, 'image/bmp')], 'image_unsupported']
    ]
    for (const [label, sent, code] of rows) {
      await expect(client.request('orchestrator.send', { threadId: thread.id, content: label, images: sent }), label).rejects.toMatchObject({ code })
    }
    expect(mms.orchestrator.getMessages(thread.id)).toEqual([])
    await client.close()
  })

  /** A raw connection that asked for `capabilities`, and a promise of its close. */
  async function rawConnection(capabilities: string[]): Promise<{ socket: Socket; closed: Promise<void> }> {
    const socket = createConnection(endpoint)
    const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()))
    socket.on('error', () => undefined)
    await new Promise<void>((resolve, reject) => {
      const decoder = new FrameDecoder()
      socket.once('connect', () => socket.write(encodeFrame({ kind: 'hello', protocolVersion: MMS_PROTOCOL_VERSION, ownerToken, clientType: 'test', requestedCapabilities: capabilities })))
      socket.on('data', (chunk) => {
        decoder.push(chunk)
        for (const frame of decoder.shiftAll() as Array<{ kind: string }>) {
          if (frame.kind === 'hello_ok') resolve()
          if (frame.kind === 'hello_err') reject(new Error('hello refused'))
        }
      })
    })
    return { socket, closed }
  }

  const chunkFrames = (threadId: string): Buffer[] => [...envelopeFrames(Buffer.from(JSON.stringify({
    kind: 'req', id: randomUUID(), method: 'orchestrator.send', params: { threadId, content: 'chunked', images: [image('a.png', 2 * MMS_PROTOCOL_MAX_FRAME_BYTES)] }
  })), true)]

  it('closes a connection that breaks a transfer, sends chunks it did not ask to, or closes mid-transfer, and runs nothing', async () => {
    const thread = mms.threads.createThread('Broken transfers')
    const frames = chunkFrames(thread.id)
    const cases: Array<[string, string[], (socket: Socket) => void]> = [
      ['another frame between chunks', [MMS_PROTOCOL_INBOUND_CHUNK_CAPABILITY], (socket) => {
        socket.write(frames[0]!)
        socket.write(encodeFrame({ kind: 'req', id: 'between', method: 'health', params: {} }))
      }],
      ['chunks out of order', [MMS_PROTOCOL_INBOUND_CHUNK_CAPABILITY], (socket) => {
        socket.write(frames[0]!)
        socket.write(frames[2]!)
      }],
      ['chunks without the capability', [MMS_PROTOCOL_CHUNK_CAPABILITY], (socket) => socket.write(frames[0]!)],
      ['closed mid-transfer', [MMS_PROTOCOL_INBOUND_CHUNK_CAPABILITY], (socket) => {
        socket.write(frames[0]!)
        socket.end()
      }]
    ]
    for (const [label, capabilities, act] of cases) {
      const { socket, closed } = await rawConnection(capabilities)
      act(socket)
      await expect(closed, label).resolves.toBeUndefined()
    }
    // The service still answers, and none of the partial messages reached the thread.
    const client = new LocalMmsClient({ homeDir: home, ownerToken, endpoint, clientType: 'test' })
    await client.connect()
    await client.request('orchestrator.send', { threadId: thread.id, content: 'after' })
    expect(mms.orchestrator.getMessages(thread.id).filter((message) => message.role === 'user').map((message) => message.content)).toEqual(['after'])
    await client.close()
  })
})
