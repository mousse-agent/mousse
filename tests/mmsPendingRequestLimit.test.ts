/**
 * Issue 420: a brief overload of the request limit is retried quietly, and the GUI's resnapshot
 * bursts (one per event while the gap flag is set) run one at a time. Past the in-flight limit a call
 * waits for a slot, and identical reads in flight share one request, so opening threads while the
 * service is slow to answer no longer fails unrelated calls.
 */
import { mkdtempSync, rmSync } from 'fs'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { coalescedRunner } from '../src/main/mms/coalescedRunner'
import { FrameDecoder, encodeFrame } from '../src/mms/protocol/framing'
import { LocalMmsClient, MMS_CLIENT_MAX_WAITING_REQUESTS, MmsProtocolError, OVERLOAD_RETRY_DELAYS_MS, isPendingRequestLimitError } from '../src/mms/protocol/client'
import { MMS_PROTOCOL_MAX_PENDING_REQUESTS, MMS_PROTOCOL_VERSION } from '../src/mms/protocol/types'

interface HeldRequest { id: string; method: string; params?: unknown }

describe('request limit overload', () => {
  let dir: string
  let endpoint: string
  let server: Server
  let socket: Socket | undefined
  let received: HeldRequest[]
  /** What the fake service does with a request: answer now (true), refuse as overloaded, or hold it. */
  let answer: (request: HeldRequest) => 'ok' | 'busy' | 'hold'
  let client: LocalMmsClient

  const reply = (request: HeldRequest) => socket!.write(encodeFrame({ kind: 'res', id: request.id, ok: true, result: { method: request.method } }))

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'mpr-'))
    endpoint = join(dir, 's.sock')
    received = []
    answer = () => 'ok'
    server = createServer((connection) => {
      socket = connection
      const decoder = new FrameDecoder()
      connection.on('data', (chunk) => {
        decoder.push(chunk)
        let frame: unknown
        while ((frame = decoder.shift()) !== null) {
          const message = frame as { kind: string; id?: string; method?: string; params?: unknown }
          if (message.kind === 'hello') {
            connection.write(encodeFrame({ kind: 'hello_ok', protocolVersion: MMS_PROTOCOL_VERSION, serverVersion: 'test', instanceId: 'fake', capabilities: [], globalSequence: 0 }))
            continue
          }
          if (message.kind !== 'req') continue
          const request = { id: message.id!, method: message.method!, params: message.params }
          received.push(request)
          const action = answer(request)
          if (action === 'ok') reply(request)
          if (action === 'busy') connection.write(encodeFrame({ kind: 'res', id: request.id, ok: false, error: { code: 'backpressure', message: 'Too many pending requests' } }))
        }
      })
    })
    await new Promise<void>((resolve) => server.listen(endpoint, resolve))
    client = new LocalMmsClient({ homeDir: dir, ownerToken: 'token', endpoint, clientType: 'test', shareIdenticalReads: true })
    await client.connect()
  })

  afterEach(async () => {
    await client.close()
    socket?.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(dir, { recursive: true, force: true })
  })

  const holdAll = async (count: number): Promise<HeldRequest[]> => {
    answer = () => 'hold'
    const start = received.length
    for (let i = 0; i < count; i += 1) void client.request('slow.read', { i }).catch(() => undefined)
    await expect.poll(() => received.length - start).toBe(count)
    return received.slice(start)
  }

  it('waits for a free slot instead of failing at once when the client limit is full', async () => {
    const held = await holdAll(MMS_PROTOCOL_MAX_PENDING_REQUESTS)
    answer = () => 'ok'
    const queued = client.request<{ method: string }>('queue.list', { threadId: 't1' })
    // The limit is full, so nothing has been sent yet; one held request finishing frees a slot.
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(received.some((request) => request.method === 'queue.list')).toBe(false)
    reply(held[0])
    await expect(queued).resolves.toEqual({ method: 'queue.list' })
  })

  it('fails with a recognizable overload error once too many are waiting and the retries are spent', async () => {
    await holdAll(MMS_PROTOCOL_MAX_PENDING_REQUESTS)
    for (let i = 0; i < MMS_CLIENT_MAX_WAITING_REQUESTS; i += 1) void client.request('slow.read', { waiting: i }).catch(() => undefined)
    await expect.poll(() => client.waitingRequestCount).toBe(MMS_CLIENT_MAX_WAITING_REQUESTS)
    const started = Date.now()
    const failure = await client.request('queue.list', { threadId: 't1' }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(MmsProtocolError)
    expect(isPendingRequestLimitError(failure)).toBe(true)
    expect((failure as Error).message).toBe('Too many pending requests')
    const total = OVERLOAD_RETRY_DELAYS_MS.reduce((sum, delay) => sum + delay, 0)
    expect(Date.now() - started).toBeGreaterThanOrEqual(total - 20)
  })

  it('sends waiting calls in call order, times one out from its call, and fails them all on disconnect', async () => {
    const held = await holdAll(MMS_PROTOCOL_MAX_PENDING_REQUESTS)
    answer = () => 'hold'
    const late = client.request('slow.read', { waiting: 'times out' }, 60).catch((error: unknown) => error)
    const first = client.request('slow.read', { waiting: 'first' })
    const second = client.request('slow.read', { waiting: 'second' })
    expect(client.waitingRequestCount).toBe(3)
    await expect(late).resolves.toMatchObject({ message: 'Request timeout: slow.read' })
    expect(client.waitingRequestCount).toBe(2)
    reply(held[0])
    await expect.poll(() => received.length).toBe(MMS_PROTOCOL_MAX_PENDING_REQUESTS + 1)
    expect(received.at(-1)!.params).toEqual({ waiting: 'first' })
    expect(client.waitingRequestCount).toBe(1)
    socket!.destroy()
    await expect(first).rejects.toThrow()
    await expect(second).rejects.toThrow()
    expect(client.waitingRequestCount).toBe(0)
  })

  it('answers identical reads in flight with one request, and gives each caller its own copy', async () => {
    answer = () => 'hold'
    const calls = [
      client.request<{ method: string }>('projects.list'),
      client.request<{ method: string }>('projects.list'),
      client.request<{ method: string }>('files.root', { threadId: 'a' }),
      client.request<{ method: string }>('files.root', { threadId: 'a' }),
      client.request<{ method: string }>('files.root', { threadId: 'b' }),
      // Not a read: always its own request.
      client.request<{ method: string }>('queue.enqueue', { threadId: 'a' }),
      client.request<{ method: string }>('queue.enqueue', { threadId: 'a' })
    ]
    await expect.poll(() => received.length).toBe(5)
    expect(received.map((request) => request.method)).toEqual(['projects.list', 'files.root', 'files.root', 'queue.enqueue', 'queue.enqueue'])
    received.forEach(reply)
    const answers = await Promise.all(calls)
    expect(answers[0]).toEqual(answers[1])
    expect(answers[0]).not.toBe(answers[1])

    // Once answered, the same read is asked again.
    answer = () => 'ok'
    await client.request('projects.list')
    expect(received.filter((request) => request.method === 'projects.list')).toHaveLength(2)
    // A read after a change (here a new profile binding) never takes the answer of a read from before it.
    answer = (request) => (request.method === 'profiles.bind' || request.method === 'queue.remove' ? 'ok' : 'hold')
    void client.request('settings.get').catch(() => undefined)
    await client.request('profiles.bind', { profile: 'other' })
    void client.request('settings.get').catch(() => undefined)
    await expect.poll(() => received.filter((request) => request.method === 'settings.get').length).toBe(2)
    void client.request('queue.list', { threadId: 'a' }).catch(() => undefined)
    await client.request('queue.remove', { threadId: 'a', itemId: 'i' })
    void client.request('queue.list', { threadId: 'a' }).catch(() => undefined)
    await expect.poll(() => received.filter((request) => request.method === 'queue.list').length).toBe(2)
  })

  it('opens five threads while the service is not answering without failing a call', async () => {
    // What a window asked when each of five threads was opened while the service was paused: 64 calls
    // were in flight after the fifth, 41 of them distinct, and its queue load failed (measured on #420).
    answer = () => 'hold'
    const open = (threadId: string) => [
      ...[1, 2, 3].map(() => client.request('files.root', { threadId })),
      ...[1, 2].map(() => client.request('browser.access.status', { profileId: 'p' })),
      client.request('projects.list'),
      client.request('settings.get'),
      client.request('settings.getOptions'),
      client.request('thread.snapshot', { threadId }),
      client.request('subagents.list', { threadId }),
      client.request('actions.list', { threadId }),
      client.request('threads.approvalRules', { threadId }),
      client.request('orchestrator.isTurnActive', { threadId }),
      client.request('orchestrator.contextUsage', { threadId }),
      client.request('queue.list', { threadId })
    ]
    const calls = ['t1', 't2', 't3', 't4', 't5'].flatMap(open)
    expect(calls).toHaveLength(75)
    const outcomes = Promise.allSettled(calls)
    // Five threads' own reads plus one of each shared one; nothing is refused or left waiting.
    await expect.poll(() => received.length).toBe(5 * 8 + 4)
    expect(client.waitingRequestCount).toBe(0)
    answer = () => 'ok'
    received.forEach(reply)
    const settled = await outcomes
    expect(settled.filter((outcome) => outcome.status === 'rejected')).toEqual([])
  })

  it('retries a request the service refused as overloaded, and nothing else', async () => {
    let refusals = 2
    answer = (request) => request.method === 'queue.list' && refusals-- > 0 ? 'busy' : 'ok'
    await expect(client.request('queue.list', { threadId: 't1' })).resolves.toEqual({ method: 'queue.list' })
    expect(received.filter((request) => request.method === 'queue.list')).toHaveLength(3)

    socket!.removeAllListeners('data')
    const decoder = new FrameDecoder()
    socket!.on('data', (chunk) => {
      decoder.push(chunk)
      let frame: unknown
      while ((frame = decoder.shift()) !== null) {
        const message = frame as { id: string; method: string }
        received.push(message)
        socket!.write(encodeFrame({ kind: 'res', id: message.id, ok: false, error: { code: 'thread_not_found', message: 'Thread not found' } }))
      }
    })
    const before = received.length
    await expect(client.request('queue.list', { threadId: 'gone' })).rejects.toMatchObject({ code: 'thread_not_found' })
    expect(received.length - before).toBe(1)
  })
})

describe('coalescedRunner', () => {
  it('runs a burst of triggers as one run plus one follow-up, per key', async () => {
    const releases: Array<() => void> = []
    const runs: string[] = []
    const run = coalescedRunner(async (key: string) => {
      runs.push(key)
      await new Promise<void>((resolve) => releases.push(resolve))
    })
    // Fifty events while the window's gap flag is set used to send fifty thread snapshots.
    for (let i = 0; i < 50; i += 1) void run('window-1')
    void run('window-2')
    expect(runs).toEqual(['window-1', 'window-2'])
    releases.shift()!()
    await expect.poll(() => runs.length).toBe(3)
    expect(runs[2]).toBe('window-1')
    releases.splice(0).forEach((release) => release())
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(runs).toHaveLength(3)
  })

  it('keeps going after a run fails', async () => {
    let calls = 0
    const run = coalescedRunner(async () => {
      calls += 1
      if (calls === 1) throw new Error('snapshot failed')
    })
    await run('base')
    await run('base')
    expect(calls).toBe(2)
  })
})
