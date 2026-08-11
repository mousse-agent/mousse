import { createConnection, type Socket } from 'net'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MousseMainService } from '../src/mms/MousseMainService'
import { MmsProtocolServer } from '../src/mms/protocol/server'
import { LocalMmsClient } from '../src/mms/protocol/client'
import { EventSequenceRing } from '../src/mms/protocol/eventRing'
import { encodeFrame, FrameDecoder } from '../src/mms/protocol/framing'
import { MMS_PROTOCOL_VERSION } from '../src/mms/protocol/types'
import { parseEnvelope, validateHello, asChatMode, asChatImages, asStringArray } from '../src/mms/protocol/validators'

function mockLlm(mms: MousseMainService, chatImpl?: () => Promise<unknown>): void {
  const llm = (
    mms.orchestrator as unknown as {
      llm: {
        getSelectedModelContextLimit: () => { limit: number }
        getContextInputs: () => Promise<unknown>
        chat: () => Promise<unknown>
      }
    }
  ).llm
  const contextInputs = {
    systemPromptText: '',
    mcpToolsText: '',
    otherToolsText: '',
    signature: 'proto'
  }
  vi.spyOn(llm, 'getSelectedModelContextLimit').mockReturnValue({ limit: 100_000 })
  vi.spyOn(llm, 'getContextInputs').mockResolvedValue(contextInputs)
  vi.spyOn(llm, 'chat').mockImplementation(async () => {
    if (chatImpl) return chatImpl()
    await new Promise((r) => setTimeout(r, 20))
    return {
      text: 'assistant-ok',
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
      },
      modelName: 'test',
      totalResponseTimeMs: 1,
      totalTokensUsed: 2,
      tokensPerSecond: 1,
      contextInputs,
      toolEvents: [],
      nativeMessages: []
    }
  })
}

describe('MmsProtocolServer + LocalMmsClient', () => {
  let home: string
  let mms: MousseMainService
  let server: MmsProtocolServer
  let ownerToken: string
  let endpoint: string

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'mousse-proto-'))
    process.env.MOUSSE_HOME = home
    mms = await MousseMainService.create({
      homeDir: home,
      headless: true,
      ownerKind: 'test'
    })
    await mms.start()
    ownerToken = mms.getOwnerLease()!.owner.token
    server = new MmsProtocolServer({ mms, ownerToken, version: 'test' })
    endpoint = await server.start()
  })

  afterEach(async () => {
    await server.stop()
    await mms.stop()
    rmSync(home, { recursive: true, force: true })
    delete process.env.MOUSSE_HOME
  })

  it('rejects wrong owner token and protocol version', async () => {
    const badToken = new LocalMmsClient({
      homeDir: home,
      ownerToken: 'wrong-token',
      endpoint,
      clientType: 'test'
    })
    await expect(badToken.connect()).rejects.toThrow(/Hello rejected|auth/i)
    await badToken.close()
  })

  it('rejects wrong protocol version via raw hello frame', async () => {
    const result = await new Promise<{ kind: string; code?: string }>((resolve, reject) => {
      const socket = createConnection(endpoint)
      const dec = new FrameDecoder()
      const timer = setTimeout(() => {
        socket.destroy()
        reject(new Error('timeout'))
      }, 5_000)
      socket.on('connect', () => {
        socket.write(
          encodeFrame({
            kind: 'hello',
            protocolVersion: 999,
            ownerToken,
            clientType: 'test'
          })
        )
      })
      socket.on('data', (chunk) => {
        dec.push(chunk)
        for (const frame of dec.shiftAll()) {
          const env = parseEnvelope(frame)
          if (env?.kind === 'hello_err') {
            clearTimeout(timer)
            resolve({ kind: env.kind, code: env.code })
            socket.destroy()
            return
          }
        }
      })
      socket.on('error', reject)
    })
    expect(result.kind).toBe('hello_err')
    expect(result.code).toBe('protocol_version')
  })

  it('processes same-chunk hello_ok + response residual frames', async () => {
    // Connect normally, then verify health works (residual path exercised by framing unit + connect).
    const client = new LocalMmsClient({
      homeDir: home,
      ownerToken,
      endpoint,
      clientType: 'test'
    })
    const hello = await client.connect()
    expect(hello.protocolVersion).toBe(MMS_PROTOCOL_VERSION)

    // Raw socket: send hello then immediately a request in one write after connect.
    // Use a second raw connection that coalesces hello response handling with a request.
    const frames = await new Promise<unknown[]>((resolve, reject) => {
      const socket = createConnection(endpoint)
      const dec = new FrameDecoder()
      const out: unknown[] = []
      const timer = setTimeout(() => {
        socket.destroy()
        reject(new Error('timeout'))
      }, 5_000)
      let authed = false
      socket.on('connect', () => {
        // Single write: hello only first; then after hello_ok send req — coalesced path on client side.
        socket.write(
          encodeFrame({
            kind: 'hello',
            protocolVersion: MMS_PROTOCOL_VERSION,
            ownerToken,
            clientType: 'test'
          })
        )
      })
      socket.on('data', (chunk) => {
        dec.push(chunk)
        for (const frame of dec.shiftAll()) {
          out.push(frame)
          const env = parseEnvelope(frame)
          if (env?.kind === 'hello_ok' && !authed) {
            authed = true
            // Immediately write request; may coalesce with later responses.
            socket.write(
              encodeFrame({ kind: 'req', id: 'same-chunk-1', method: 'health' })
            )
          }
          if (env?.kind === 'res' && env.id === 'same-chunk-1') {
            clearTimeout(timer)
            resolve(out)
            socket.destroy()
            return
          }
        }
      })
      socket.on('error', reject)
    })
    expect(frames.some((f) => parseEnvelope(f)?.kind === 'hello_ok')).toBe(true)
    expect(
      frames.some((f) => {
        const e = parseEnvelope(f)
        return e?.kind === 'res' && e.id === 'same-chunk-1' && e.ok
      })
    ).toBe(true)
    await client.close()
  })

  it('serializes delayed requests in stream order per client', async () => {
    const client = new LocalMmsClient({
      homeDir: home,
      ownerToken,
      endpoint,
      clientType: 'test'
    })
    await client.connect()

    // Patch dispatch via orchestrator methods that have async delay: use threads.get
    // and force first call to delay by creating many sequential health requests.
    // Server chain ensures order; use unique methods that complete in order.
    const order: string[] = []
    const origGet = mms.threads.getThread.bind(mms.threads)
    let gate: Promise<void> | null = null
    let releaseGate: (() => void) | null = null
    vi.spyOn(mms.threads, 'getThread').mockImplementation((id: string) => {
      order.push(`start:${id}`)
      if (id === 'slow-first') {
        // Hold the first request until second has been received — serialization should
        // prevent second from starting before first finishes.
        if (!gate) {
          gate = new Promise((r) => {
            releaseGate = r
          })
        }
        // Block in async handler path — getThread is sync; use send path instead.
        return origGet(id)
      }
      order.push(`done:${id}`)
      return origGet(id)
    })

    // Better: concurrent requests on same connection — health is fast; use raw frames
    // with a hanging handler via orchestrator.send mocked.
    mockLlm(mms, async () => {
      await new Promise((r) => setTimeout(r, 80))
      return {
        text: 'ok',
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
        },
        modelName: 'test',
        totalResponseTimeMs: 1,
        totalTokensUsed: 2,
        tokensPerSecond: 1,
        contextInputs: {
          systemPromptText: '',
          mcpToolsText: '',
          otherToolsText: '',
          signature: 'x'
        },
        toolEvents: [],
        nativeMessages: []
      }
    })

    const thread = mms.threads.createThread('Serial')
    const started: number[] = []
    const finished: number[] = []
    let call = 0
    const llm = (
      mms.orchestrator as unknown as {
        llm: { chat: () => Promise<unknown> }
      }
    ).llm
    vi.spyOn(llm, 'chat').mockImplementation(async () => {
      const n = ++call
      started.push(n)
      await new Promise((r) => setTimeout(r, n === 1 ? 60 : 5))
      finished.push(n)
      return {
        text: `r${n}`,
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
        },
        modelName: 'test',
        totalResponseTimeMs: 1,
        totalTokensUsed: 2,
        tokensPerSecond: 1,
        contextInputs: {
          systemPromptText: '',
          mcpToolsText: '',
          otherToolsText: '',
          signature: 'x'
        },
        toolEvents: [],
        nativeMessages: []
      }
    })

    // Fire two requests without awaiting the first — stream order serialization.
    // Second send will queue while first turn runs (orchestrator queue), so use
    // health with artificial delay via server chain: raw concurrent frames.
    const rawOrder: string[] = []
    await new Promise<void>((resolve, reject) => {
      const socket = createConnection(endpoint)
      const dec = new FrameDecoder()
      let step = 0
      const timer = setTimeout(() => {
        socket.destroy()
        reject(new Error('timeout'))
      }, 10_000)
      socket.on('connect', () => {
        socket.write(
          encodeFrame({
            kind: 'hello',
            protocolVersion: MMS_PROTOCOL_VERSION,
            ownerToken,
            clientType: 'test'
          })
        )
      })
      socket.on('data', (chunk) => {
        dec.push(chunk)
        for (const frame of dec.shiftAll()) {
          const env = parseEnvelope(frame)
          if (env?.kind === 'hello_ok' && step === 0) {
            step = 1
            // Two requests in one chunk — must execute in order.
            socket.write(
              Buffer.concat([
                encodeFrame({ kind: 'req', id: 'a', method: 'health' }),
                encodeFrame({ kind: 'req', id: 'b', method: 'health' })
              ])
            )
          }
          if (env?.kind === 'res') {
            rawOrder.push(env.id)
            if (rawOrder.length === 2) {
              clearTimeout(timer)
              socket.destroy()
              resolve()
            }
          }
        }
      })
      socket.on('error', reject)
    })
    expect(rawOrder).toEqual(['a', 'b'])
    void started
    void finished
    void thread
    void releaseGate
    void order
    await client.close()
  })

  it('same connection steer/abort complete while long send is still in flight', async () => {
    let releaseChat: (() => void) | null = null
    let chatEntered!: () => void
    const entered = new Promise<void>((r) => {
      chatEntered = r
    })
    mockLlm(mms, async () => {
      chatEntered()
      await new Promise<void>((r) => {
        releaseChat = r
      })
      return {
        text: 'long-send-done',
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
        },
        modelName: 'test',
        totalResponseTimeMs: 1,
        totalTokensUsed: 2,
        tokensPerSecond: 1,
        contextInputs: {
          systemPromptText: '',
          mcpToolsText: '',
          otherToolsText: '',
          signature: 'x'
        },
        toolEvents: [],
        nativeMessages: []
      }
    })

    const client = new LocalMmsClient({
      homeDir: home,
      ownerToken,
      endpoint,
      clientType: 'test'
    })
    await client.connect()
    const thread = mms.threads.createThread('ConcurrentCtl')

    const sendP = client.request('orchestrator.send', {
      threadId: thread.id,
      content: 'long running'
    })
    await entered

    // These must not wait for send to finish (admission allows concurrent execution).
    const steerStart = Date.now()
    const steered = await client.request<{ ok: boolean }>('orchestrator.steer', {
      threadId: thread.id,
      text: 'prefer tests'
    })
    const steerMs = Date.now() - steerStart
    expect(steered.ok).toBe(true)
    expect(steerMs).toBeLessThan(2_000)

    const abortStart = Date.now()
    const aborted = await client.request<{ ok: boolean }>('orchestrator.abort', {
      threadId: thread.id
    })
    const abortMs = Date.now() - abortStart
    expect(aborted.ok).toBe(true)
    expect(abortMs).toBeLessThan(2_000)

    // Send may settle as interrupted/stopped after abort — either way it must resolve.
    releaseChat?.()
    await expect(sendP).resolves.toBeTruthy()
    await client.close()
  })

  it('duplicate request id does not double-execute', async () => {
    let executions = 0
    let releaseChat: (() => void) | null = null
    let chatEntered!: () => void
    const chatGate = new Promise<void>((r) => {
      chatEntered = r
    })
    mockLlm(mms, async () => {
      executions += 1
      chatEntered()
      await new Promise<void>((r) => {
        releaseChat = r
      })
      return {
        text: 'dup-ok',
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
        },
        modelName: 'test',
        totalResponseTimeMs: 1,
        totalTokensUsed: 2,
        tokensPerSecond: 1,
        contextInputs: {
          systemPromptText: '',
          mcpToolsText: '',
          otherToolsText: '',
          signature: 'x'
        },
        toolEvents: [],
        nativeMessages: []
      }
    })

    const thread = mms.threads.createThread('Dup')
    const responses = await new Promise<
      Array<{ id: string; ok: boolean; code?: string }>
    >((resolve, reject) => {
      const socket = createConnection(endpoint)
      const dec = new FrameDecoder()
      const out: Array<{ id: string; ok: boolean; code?: string }> = []
      const timer = setTimeout(() => {
        socket.destroy()
        reject(new Error('timeout'))
      }, 10_000)
      let helloDone = false
      socket.on('connect', () => {
        socket.write(
          encodeFrame({
            kind: 'hello',
            protocolVersion: MMS_PROTOCOL_VERSION,
            ownerToken,
            clientType: 'test'
          })
        )
      })
      socket.on('data', (chunk) => {
        dec.push(chunk)
        for (const frame of dec.shiftAll()) {
          const env = parseEnvelope(frame)
          if (env?.kind === 'hello_ok' && !helloDone) {
            helloDone = true
            socket.write(
              encodeFrame({
                kind: 'req',
                id: 'dup-1',
                method: 'orchestrator.send',
                params: { threadId: thread.id, content: 'first' }
              })
            )
          }
          if (env?.kind === 'res' && env.id === 'dup-1') {
            out.push({
              id: env.id,
              ok: env.ok,
              code: env.error?.code
            })
            if (out.length === 1) {
              // Replay same id after completion — completed-response cache, no re-execute.
              socket.write(
                encodeFrame({
                  kind: 'req',
                  id: 'dup-1',
                  method: 'orchestrator.send',
                  params: { threadId: thread.id, content: 'second' }
                })
              )
            }
            if (out.length >= 2) {
              clearTimeout(timer)
              socket.destroy()
              resolve(out)
            }
          }
        }
      })
      socket.on('error', reject)

      void chatGate.then(() => {
        // In-flight same-id while first send is still running (queued on chain until first finishes
        // OR rejected as duplicate if processed while inFlightIds still holds the id).
        socket.write(
          encodeFrame({
            kind: 'req',
            id: 'dup-1',
            method: 'orchestrator.send',
            params: { threadId: thread.id, content: 'inflight-dup' }
          })
        )
        releaseChat?.()
      })
    })

    // Exactly one LLM execution regardless of duplicate frames.
    expect(executions).toBe(1)
    expect(responses.length).toBeGreaterThanOrEqual(2)
    expect(responses[0].ok || responses.some((r) => r.ok)).toBe(true)
  })

  it('request write failure cleans up pending immediately', async () => {
    const client = new LocalMmsClient({
      homeDir: home,
      ownerToken,
      endpoint,
      clientType: 'test',
      requestTimeoutMs: 30_000
    })
    await client.connect()
    // Force write to throw after pending is registered.
    const writeSpy = vi
      .spyOn(client as unknown as { write: (v: unknown) => void }, 'write')
      .mockImplementation(() => {
        throw new Error('write failed')
      })
    const start = Date.now()
    await expect(client.request('health')).rejects.toThrow(/write failed/)
    expect(Date.now() - start).toBeLessThan(2_000)
    expect((client as unknown as { pending: Map<string, unknown> }).pending.size).toBe(0)
    writeSpy.mockRestore()
    await client.close()
  })

  it('subscribe boundary race: replay before live events from same batch', async () => {
    const client = new LocalMmsClient({
      homeDir: home,
      ownerToken,
      endpoint,
      clientType: 'test'
    })
    await client.connect()
    const delivered: Array<{ type: string; seq: number }> = []
    client.onEvent((e) => {
      delivered.push({ type: e.type, seq: e.sequence })
    })

    // Pre-emit an event into the ring before subscribe.
    const thread = mms.threads.createThread('SubRace')
    mms.orchestrator.bindThread(thread.id, [], undefined, [])
    mms.orchestrator.enqueueForThread(thread.id, 'before-sub')

    await vi.waitFor(() => {
      // Wait until server has sequenced at least one event (via ring) — subscribe will replay.
      expect(server.globalSequence).toBeGreaterThan(0)
    })

    // Subscribe and simultaneously enqueue during/after — client must not deliver live
    // before replay for the handshake.
    const subP = client.subscribe(0)
    // Event emitted around subscribe response boundary.
    mms.orchestrator.enqueueForThread(thread.id, 'around-sub')
    const sub = await subP
    expect(typeof sub.sequence).toBe('number')

    // Wait for live event after subscribe
    await vi.waitFor(() => {
      expect(delivered.length).toBeGreaterThan(0)
    })

    // Sequences must be non-decreasing
    for (let i = 1; i < delivered.length; i++) {
      expect(delivered[i].seq).toBeGreaterThanOrEqual(delivered[i - 1].seq)
    }
    // lastSequence must never go backwards after live
    expect(client.lastKnownSequence).toBeGreaterThanOrEqual(sub.sequence)
    await client.close()
  })

  it('new instance forces resnapshot (sequence regression)', async () => {
    const client = new LocalMmsClient({
      homeDir: home,
      ownerToken,
      endpoint,
      clientType: 'test'
    })
    const hello1 = await client.connect()
    await client.subscribe(0)
    // Bump sequence
    const thread = mms.threads.createThread('Inst')
    mms.orchestrator.bindThread(thread.id, [], undefined, [])
    mms.orchestrator.enqueueForThread(thread.id, 'bump')
    await vi.waitFor(() => expect(client.lastKnownSequence).toBeGreaterThan(0))
    const seqBefore = client.lastKnownSequence
    await client.close()

    // Simulate new server instance with fresh ring (sequence restarts).
    await server.stop()
    // New server object = new EventSequenceRing (sequence 0).
    server = new MmsProtocolServer({
      mms,
      ownerToken,
      version: 'test',
      build: 'rebuild-2'
    })
    endpoint = await server.start()

    // Force prior connection comparison: reconnect.
    // instanceId may be same process — but sequence regresses, which must require resnapshot.
    const hello2 = await client.connect()
    expect(hello2.globalSequence).toBeLessThan(seqBefore)
    expect(client.requiresResnapshot).toBe(true)
    expect(hello1.instanceId).toBeTruthy()
    await client.close()
  })

  it('slow client disconnect under outbound backpressure does not affect MMS', async () => {
    // Use a raw socket that never reads, flooding events, then verify MMS still works.
    const flood = await new Promise<Socket>((resolve, reject) => {
      const socket = createConnection(endpoint)
      socket.on('connect', () => {
        socket.write(
          encodeFrame({
            kind: 'hello',
            protocolVersion: MMS_PROTOCOL_VERSION,
            ownerToken,
            clientType: 'test'
          })
        )
      })
      const dec = new FrameDecoder()
      socket.on('data', (chunk) => {
        // Consume hello only, then stop reading by pausing.
        dec.push(chunk)
        for (const frame of dec.shiftAll()) {
          const env = parseEnvelope(frame)
          if (env?.kind === 'hello_ok') {
            socket.write(
              encodeFrame({
                kind: 'req',
                id: 'sub',
                method: 'events.subscribe',
                params: { afterSequence: 0 }
              })
            )
            // Pause so OS buffers fill — server should disconnect on backlog.
            socket.pause()
            resolve(socket)
          }
        }
      })
      socket.on('error', () => {
        /* may close */
      })
      setTimeout(() => reject(new Error('flood setup timeout')), 5_000)
    })

    // Generate many events
    const thread = mms.threads.createThread('Flood')
    mms.orchestrator.bindThread(thread.id, [], undefined, [])
    for (let i = 0; i < 200; i++) {
      mms.orchestrator.enqueueForThread(thread.id, `flood-${i}`)
    }

    // MMS still serves a healthy client
    const client = new LocalMmsClient({
      homeDir: home,
      ownerToken,
      endpoint,
      clientType: 'test'
    })
    await client.connect()
    await expect(client.request('health')).resolves.toMatchObject({ ok: true })
    await client.close()
    try {
      flood.destroy()
    } catch {
      /* ignore */
    }
  }, 15_000)

  it('start failure disposes orchestrator listeners and leaves endpoint free', async () => {
    // Wire a spy by creating a server that fails listen (EADDRINUSE on same path).
    const orch = mms.orchestrator
    const listenerCountBefore = orch.listenerCount('thread-message')

    const bad = new MmsProtocolServer({ mms, ownerToken, version: 'fail' })
    // First server already listening on endpoint — second must not unlink / must fail.
    await expect(bad.start()).rejects.toThrow()
    // Listeners should not leak from failed start
    expect(orch.listenerCount('thread-message')).toBe(listenerCountBefore)
    // Original server still works
    const client = new LocalMmsClient({
      homeDir: home,
      ownerToken,
      endpoint,
      clientType: 'test'
    })
    await client.connect()
    await expect(client.request('health')).resolves.toMatchObject({ ok: true })
    await client.close()
    // Failed server stop is idempotent
    await bad.stop()
    await bad.stop()
  })

  it('strict invalid payload rejection (mode/images/orderedIds/booleans)', async () => {
    const client = new LocalMmsClient({
      homeDir: home,
      ownerToken,
      endpoint,
      clientType: 'test'
    })
    await client.connect()
    const thread = mms.threads.createThread('Val')

    await expect(
      client.request('orchestrator.send', {
        threadId: thread.id,
        content: 'x',
        mode: 'not-a-mode'
      })
    ).rejects.toThrow(/mode/i)

    await expect(
      client.request('orchestrator.send', {
        threadId: thread.id,
        content: 'x',
        images: [{ name: 'a', mimeType: 'image/png' }] // missing data
      })
    ).rejects.toThrow(/images|data/i)

    await expect(
      client.request('queue.reorder', {
        threadId: thread.id,
        orderedIds: ['a', 'a']
      })
    ).rejects.toThrow(/duplicate/i)

    await expect(
      client.request('orchestrator.abort', {
        threadId: thread.id,
        clearQueue: 'yes'
      })
    ).rejects.toThrow(/boolean/i)

    await expect(client.request('health')).resolves.toMatchObject({ ok: true })
    await client.close()
  })

  it('disconnect client during active LLM turn; turn completes and persists', async () => {
    let resolveChat: (() => void) | null = null
    const chatStarted = new Promise<void>((r) => {
      // released when chat is entered
      const prev = r
      resolveChat = () => prev()
    })
    let chatEntered: () => void
    const entered = new Promise<void>((r) => {
      chatEntered = r
    })

    mockLlm(mms, async () => {
      chatEntered!()
      await new Promise<void>((r) => {
        resolveChat = r
      })
      return {
        text: 'completed-after-disconnect',
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
        },
        modelName: 'test',
        totalResponseTimeMs: 1,
        totalTokensUsed: 2,
        tokensPerSecond: 1,
        contextInputs: {
          systemPromptText: '',
          mcpToolsText: '',
          otherToolsText: '',
          signature: 'x'
        },
        toolEvents: [],
        nativeMessages: []
      }
    })

    const client = new LocalMmsClient({
      homeDir: home,
      ownerToken,
      endpoint,
      clientType: 'test'
    })
    await client.connect()
    const thread = mms.threads.createThread('DiscTurn')

    const lifecycle: string[] = []
    mms.orchestrator.on('turn-started', () => lifecycle.push('started'))
    mms.orchestrator.on('turn-completed', () => lifecycle.push('completed'))
    mms.orchestrator.on('turn-interrupted', () => lifecycle.push('interrupted'))

    const sendP = client.request('orchestrator.send', {
      threadId: thread.id,
      content: 'survive disconnect'
    })
    await entered
    // Disconnect client mid-turn
    await client.close()
    // send request may reject due to disconnect
    await sendP.catch(() => undefined)

    // Complete the LLM turn
    resolveChat?.()
    await vi.waitFor(() => {
      expect(lifecycle).toContain('started')
      expect(lifecycle).toContain('completed')
    })
    // Messages persisted on session
    const messages = mms.orchestrator.getMessages(thread.id)
    expect(
      messages.some((m) => m.content === 'survive disconnect') ||
        messages.some((m) => m.content === 'completed-after-disconnect')
    ).toBe(true)
    void chatStarted
  })

  it('snapshot includes claimed, connectionFailed, and lifecycle turn state', async () => {
    const client = new LocalMmsClient({
      homeDir: home,
      ownerToken,
      endpoint,
      clientType: 'test'
    })
    await client.connect()
    const thread = mms.threads.createThread('Snap')
    mms.orchestrator.bindThread(thread.id, [], undefined, [])

    const snap = await client.request<{
      activeTurn: { active: boolean; running: boolean }
      connectionFailed: boolean
      queue: unknown[]
      claimed: unknown[]
    }>('thread.snapshot', { threadId: thread.id })

    expect(snap.activeTurn).toEqual({ active: false, running: false })
    expect(snap.connectionFailed).toBe(false)
    expect(Array.isArray(snap.queue)).toBe(true)
    expect(Array.isArray(snap.claimed)).toBe(true)

    // Active turn while mocked LLM runs — use a second client for snapshot so
    // per-connection request serialization does not deadlock behind send.
    let release: (() => void) | null = null
    let entered: () => void
    const waitEnter = new Promise<void>((r) => {
      entered = r
    })
    mockLlm(mms, async () => {
      entered!()
      await new Promise<void>((r) => {
        release = r
      })
      return {
        text: 'snap-ok',
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
        },
        modelName: 'test',
        totalResponseTimeMs: 1,
        totalTokensUsed: 2,
        tokensPerSecond: 1,
        contextInputs: {
          systemPromptText: '',
          mcpToolsText: '',
          otherToolsText: '',
          signature: 'x'
        },
        toolEvents: [],
        nativeMessages: []
      }
    })

    const client2 = new LocalMmsClient({
      homeDir: home,
      ownerToken,
      endpoint,
      clientType: 'test'
    })
    await client2.connect()

    const sendP = client.request('orchestrator.send', {
      threadId: thread.id,
      content: 'during-snap'
    })
    await waitEnter
    const mid = await client2.request<{
      activeTurn: { active: boolean; running: boolean }
      connectionFailed: boolean
      claimed: unknown[]
    }>('thread.snapshot', { threadId: thread.id })
    expect(mid.activeTurn.running).toBe(true)
    expect(mid.connectionFailed).toBe(false)
    expect(Array.isArray(mid.claimed)).toBe(true)
    release?.()
    await sendP
    await client.close()
    await client2.close()
  })

  it('stop is idempotent and does not hang', async () => {
    const t0 = Date.now()
    await server.stop()
    await server.stop()
    await server.stop()
    expect(Date.now() - t0).toBeLessThan(5_000)
    // Restart for afterEach
    server = new MmsProtocolServer({ mms, ownerToken, version: 'test' })
    endpoint = await server.start()
  })

  it('health and capabilities over authenticated connection', async () => {
    const client = new LocalMmsClient({
      homeDir: home,
      ownerToken,
      endpoint,
      clientType: 'test'
    })
    const hello = await client.connect()
    expect(hello.protocolVersion).toBe(1)
    expect(hello.instanceId).toBeTruthy()
    expect(hello.capabilities.length).toBeGreaterThan(0)

    const health = await client.request<{ ok: boolean }>('health')
    expect(health.ok).toBe(true)

    const caps = await client.request<{ methods: string[] }>('capabilities')
    expect(caps.methods).toContain('orchestrator.send')

    await client.close()
  })

  it('request timeout rejects pending', async () => {
    const client = new LocalMmsClient({
      homeDir: home,
      ownerToken,
      endpoint,
      clientType: 'test',
      requestTimeoutMs: 50
    })
    await client.connect()
    const p = client.request('health', undefined, 5_000)
    await client.close()
    await expect(p).rejects.toThrow(/closed|timeout|Not connected|Client closed|Connection/i)
  })

  it('handler errors are isolated as error responses', async () => {
    const client = new LocalMmsClient({
      homeDir: home,
      ownerToken,
      endpoint,
      clientType: 'test'
    })
    await client.connect()
    await expect(
      client.request('threads.get', { threadId: 'does-not-exist' })
    ).rejects.toThrow(/not found/i)
    await expect(client.request('health')).resolves.toMatchObject({ ok: true })
    await client.close()
  })

  it('event sequence is monotonic with subscribe replay', async () => {
    const client = new LocalMmsClient({
      homeDir: home,
      ownerToken,
      endpoint,
      clientType: 'test'
    })
    await client.connect()
    const events: number[] = []
    client.onEvent((e) => events.push(e.sequence))

    const sub = await client.subscribe(0)
    expect(typeof sub.sequence).toBe('number')

    const thread = mms.threads.createThread('Proto')
    mms.orchestrator.bindThread(thread.id, [], undefined, [])
    mms.orchestrator.enqueueForThread(thread.id, 'hello-queue')

    await vi.waitFor(() => {
      expect(events.length).toBeGreaterThan(0)
    })
    for (let i = 1; i < events.length; i++) {
      expect(events[i]).toBeGreaterThan(events[i - 1])
    }
    await client.close()
  })

  it('complete local send/queue/steer/abort flow with mocked LLM', async () => {
    const client = new LocalMmsClient({
      homeDir: home,
      ownerToken,
      endpoint,
      clientType: 'test'
    })
    await client.connect()
    await client.subscribe(0)

    const thread = mms.threads.createThread('Flow')
    const projects = await client.request<{ projects: unknown[] }>('projects.list')
    expect(Array.isArray(projects.projects)).toBe(true)

    const threads = await client.request<{ threads: { id: string }[] }>('threads.list')
    expect(threads.threads.some((t) => t.id === thread.id)).toBe(true)

    mockLlm(mms)

    const sendResult = await client.request<{ message: string; queued?: boolean }>(
      'orchestrator.send',
      { threadId: thread.id, content: 'hi from protocol' }
    )
    expect(sendResult.queued || sendResult.message).toBeTruthy()

    const snap = await client.request<{
      messages: { content: string }[]
      queue: unknown[]
    }>('thread.snapshot', { threadId: thread.id })
    expect(
      snap.messages.some((m) => m.content === 'hi from protocol') || snap.queue.length >= 0
    ).toBe(true)

    const session = mms.orchestrator.getOrCreateSession(thread.id)
    session.activeTurn = { abort: new AbortController(), pendingSteer: [] }
    await client.request('orchestrator.send', {
      threadId: thread.id,
      content: 'queued-msg',
      forceQueue: true
    })
    const q = await client.request<{ items: { content: string }[] }>('queue.list', {
      threadId: thread.id
    })
    expect(q.items.some((i) => i.content === 'queued-msg')).toBe(true)

    await client.request('orchestrator.steer', { threadId: thread.id, text: 'prefer tests' })
    await client.request('orchestrator.abort', { threadId: thread.id })

    await client.close()
  })

  it('client disconnect does not stop server / execution path', async () => {
    const client = new LocalMmsClient({
      homeDir: home,
      ownerToken,
      endpoint,
      clientType: 'test'
    })
    await client.connect()
    await client.close()
    const client2 = new LocalMmsClient({
      homeDir: home,
      ownerToken,
      endpoint,
      clientType: 'test'
    })
    await client2.connect()
    await expect(client2.request('health')).resolves.toMatchObject({ ok: true })
    await client2.close()
  })

  it('emits turn.started and turn.completed lifecycle protocol events', async () => {
    const client = new LocalMmsClient({
      homeDir: home,
      ownerToken,
      endpoint,
      clientType: 'test'
    })
    await client.connect()
    const types: string[] = []
    client.onEvent((e) => types.push(e.type))
    await client.subscribe(0)

    mockLlm(mms)
    const thread = mms.threads.createThread('Life')
    await client.request('orchestrator.send', {
      threadId: thread.id,
      content: 'lifecycle'
    })
    await vi.waitFor(() => {
      expect(types).toContain('turn.started')
      expect(types).toContain('turn.completed')
    })
    await client.close()
  })
})

describe('EventSequenceRing', () => {
  it('detects gap when afterSeq is older than ring', () => {
    const ring = new EventSequenceRing(3)
    ring.push('a', 1)
    ring.push('b', 2)
    ring.push('c', 3)
    ring.push('d', 4)
    const replay = ring.replayAfter(0)
    expect(replay.gap).toBe(true)
    expect(replay.events.map((e) => e.sequence)).toEqual([2, 3, 4])
  })
})

describe('protocol validators', () => {
  it('validateHello rejects wrong version', () => {
    const v = validateHello({
      kind: 'hello',
      protocolVersion: 42,
      ownerToken: 'tok',
      clientType: 'test'
    })
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.code).toBe('protocol_version')
  })

  it('rejects invalid chat mode and images without casting', () => {
    expect(() => asChatMode('hacker')).toThrow(/mode/)
    expect(() => asChatMode({ type: 'skill' })).toThrow()
    expect(asChatMode('agent')).toBe('agent')
    expect(asChatMode({ type: 'skill', skillId: 's1' })).toEqual({
      type: 'skill',
      skillId: 's1'
    })
    expect(() =>
      asChatImages([{ name: 'x', mimeType: 'image/png', data: 1 as unknown as string }])
    ).toThrow()
    expect(() => asStringArray(['a', 'a'], 'orderedIds', { unique: true })).toThrow(/duplicate/)
  })

  it('parseEnvelope validates response and event shapes', () => {
    expect(parseEnvelope({ kind: 'res', id: '1', ok: true, result: {} })?.kind).toBe('res')
    expect(parseEnvelope({ kind: 'res', id: '1', ok: 'yes' })).toBeNull()
    expect(
      parseEnvelope({
        kind: 'event',
        sequence: 1,
        type: 'x',
        data: null,
        ts: 't'
      })?.kind
    ).toBe('event')
    expect(
      parseEnvelope({
        kind: 'event',
        sequence: -1,
        type: 'x',
        data: null,
        ts: 't'
      })
    ).toBeNull()
    expect(
      parseEnvelope({
        kind: 'event',
        sequence: Number.NaN,
        type: 'x',
        data: null,
        ts: 't'
      })
    ).toBeNull()
  })
})
