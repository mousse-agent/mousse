/**
 * Phase 3: GUI MMS client lifecycle against a local protocol server.
 * Electron does not own MMS; controller is a client only.
 */

import { mkdtempSync, rmSync } from 'fs'
import { createServer, type Socket } from 'node:net'
import { FrameDecoder, encodeFrame } from '../src/mms/protocol/framing'
import { EventEmitter } from 'node:events'
import type { WebContents } from 'electron'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MousseMainService } from '../src/mms/MousseMainService'
import { MmsProtocolServer } from '../src/mms/protocol/server'
import { GuiMmsController } from '../src/main/mms/GuiMmsController'
import { PresentationState } from '../src/main/mms/PresentationState'
import { bridgeProtocolEvent, broadcastThreadSnapshot } from '../src/main/mms/protocolEventBridge'
import type { ProtocolEvent } from '../src/mms/protocol/types'
import { bootstrapPresentation } from '../src/main/ipc/registerGuiIpc'

describe('GuiMmsController lifecycle', () => {
  let home: string
  let mms: MousseMainService
  let server: MmsProtocolServer
  let ownerToken: string
  let endpoint: string

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'mousse-gui-'))
    process.env.MOUSSE_HOME = home
    mms = await MousseMainService.create({
      homeDir: home,
      headless: true,
      ownerKind: 'daemon'
    })
    await mms.start()
    ownerToken = mms.getOwnerLease()!.owner.token
    server = new MmsProtocolServer({ mms, ownerToken, version: 'test' })
    endpoint = await server.start()
    // Publish endpoint like production daemon
    mms.getOwnerLease()?.setEndpoint(endpoint)
  })

  afterEach(async () => {
    await server.stop()
    await mms.stop()
    rmSync(home, { recursive: true, force: true })
    delete process.env.MOUSSE_HOME
  })

  it('hides applet owner bindings throughout overlapping profile transitions', async () => {
    const gui = new GuiMmsController({homeDir:home,disableAutoStart:true,endpointOverride:endpoint,ownerTokenOverride:ownerToken})
    const sender = Object.assign(new EventEmitter(), {id:987,isDestroyed:()=>false}) as unknown as WebContents
    await gui.start()
    try {
      const binding = await gui.prepareWindow(sender)
      const internals = gui as unknown as {windowSessions:Map<number,{client:{request:(method:string,params?:unknown)=>Promise<unknown>}}>}
      const client=internals.windowSessions.get(sender.id)!.client
      const original=client.request.bind(client)
      const releases:Array<()=>void>=[]
      vi.spyOn(client,'request').mockImplementation(async (method,params)=>{
        if(method==='profiles.bind')await new Promise<void>(resolve=>releases.push(resolve))
        return original(method,params)
      })
      const events=vi.fn();gui.on('window-profile-changing',events)
      const first=gui.runWithSender(sender,()=>gui.request('profiles.bind',{profile:binding.profileId}))
      const second=gui.runWithSender(sender,()=>gui.request('profiles.bind',{profile:binding.profileId}))
      await vi.waitFor(()=>expect(releases).toHaveLength(2))
      expect(gui.getWindowBindingForSender(sender.id)).toBeNull()
      releases[0]();await first
      expect(gui.getWindowBindingForSender(sender.id)).toBeNull()
      releases[1]();await second
      expect(gui.getWindowBindingForSender(sender.id)?.profileId).toBe(binding.profileId)
      expect(events).toHaveBeenCalledTimes(4)
    } finally {await gui.stop()}
  })

  it('connects when daemon is already running (no ownership)', async () => {
    const gui = new GuiMmsController({
      homeDir: home,
      disableAutoStart: true,
      endpointOverride: endpoint,
      ownerTokenOverride: ownerToken
    })
    const hello = await gui.start()
    expect(hello.instanceId).toBeTruthy()
    expect(gui.connected).toBe(true)
    const health = await gui.request<{ ok: boolean }>('health')
    expect(health.ok).toBe(true)
    await gui.stop()
    // Daemon still serves
    expect(server.endpoint).toBeTruthy()
  })

  it('shares a cold base handshake across concurrent startup and window bootstrap requests', async () => {
    const gui = new GuiMmsController({ homeDir: home, disableAutoStart: true, endpointOverride: endpoint, ownerTokenOverride: ownerToken })
    const connect = vi.spyOn(gui as unknown as { connectOnce: () => Promise<unknown> }, 'connectOnce')
    const sender = Object.assign(new EventEmitter(), { id: 321, isDestroyed: () => false }) as unknown as WebContents
    try {
      const [hello, binding, status] = await Promise.all([
        gui.start(),
        gui.prepareWindow(sender),
        gui.runWithSender(sender, () => gui.request<{ binding: { profileId: string } }>('profiles.status'))
      ])
      expect(hello.instanceId).toBeTruthy()
      expect(connect).toHaveBeenCalledTimes(1)
      expect(binding.profileId).toBeTruthy()
      expect(status.binding.profileId).toBe(binding.profileId)
      expect(gui.getWindowBindingForSender(sender.id)).toEqual(binding)
    } finally { await gui.stop() }
  })

  it.each(['missing', 'malformed', 'failed'])('rejects %s capabilities from an old same-version daemon before feature calls without stopping it', async mode => {
    await server.stop()
    const requests: string[] = []
    const sockets = new Set<Socket>()
    const legacy = createServer(socket => {
      sockets.add(socket); socket.once('close', () => sockets.delete(socket))
      const decoder = new FrameDecoder()
      socket.on('data', chunk => {
        decoder.push(chunk)
        let frame: unknown
        while ((frame = decoder.shift()) !== null) {
          const request = frame as { kind: string; id?: string; method?: string }
          if (request.kind === 'hello') socket.write(encodeFrame({ kind: 'hello_ok', protocolVersion: 1, serverVersion: '0.1.1', instanceId: 'legacy-daemon', capabilities: [], globalSequence: 0 }))
          else if (request.kind === 'req') {
            requests.push(request.method!)
            socket.write(encodeFrame(mode === 'failed'
              ? { kind: 'res', id: request.id, ok: false, error: { code: 'method_not_allowed', message: 'Old service' } }
              : { kind: 'res', id: request.id, ok: true, result: { protocolVersion: 1, methods: mode === 'malformed' ? 'invalid' : ['health', 'capabilities'], capabilities: [] } }))
          }
        }
      })
    })
    await new Promise<void>((resolve, reject) => { legacy.once('error', reject); legacy.listen(endpoint, resolve) })
    const gui = new GuiMmsController({ homeDir: home, disableAutoStart: true, endpointOverride: endpoint, ownerTokenOverride: ownerToken })
    try {
      await expect(gui.start()).rejects.toThrow(/service stop.*not been stopped automatically/)
      expect(gui.connected).toBe(false)
      expect(requests).toEqual(['capabilities'])
      expect(mms.getOwnerLease()?.owner.token).toBe(ownerToken)
      expect(legacy.listening).toBe(true)
    } finally {
      await gui.stop()
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve, reject) => legacy.close(error => error ? reject(error) : resolve()))
    }
  })

  function advertiseOldMethods(): void {
    const transport = server as unknown as { sendRaw(session: unknown, value: unknown): boolean }
    const send = transport.sendRaw.bind(server)
    vi.spyOn(transport, 'sendRaw').mockImplementation((session, value) => {
      const frame = value as { result?: { methods?: string[] } }
      if (Array.isArray(frame.result?.methods)) {
        value = { ...frame, result: { ...frame.result, methods: frame.result.methods.filter(method => method !== 'agents.listNamed') } }
      }
      return send(session, value)
    })
  }

  it('rechecks the exact window connection and closes an incompatible window client', async () => {
    const gui = new GuiMmsController({ homeDir: home, disableAutoStart: true, endpointOverride: endpoint, ownerTokenOverride: ownerToken })
    await gui.start()
    advertiseOldMethods()
    const sender = Object.assign(new EventEmitter(), { id: 123, isDestroyed: () => false }) as unknown as WebContents
    const clients = (server as unknown as { clients: Set<unknown> }).clients
    const count = clients.size
    try {
      await expect(gui.prepareWindow(sender)).rejects.toThrow(/Missing APIs: agents.listNamed/)
      expect(gui.getWindowBindingForSender(sender.id)).toBeNull()
      await vi.waitFor(() => expect(clients.size).toBe(count))
      expect(sender.listenerCount('destroyed')).toBe(0)
    } finally { await gui.stop() }
  })

  it('rejects an incompatible daemon on reconnect before ready or resnapshot', async () => {
    const gui = new GuiMmsController({ homeDir: home, disableAutoStart: true, endpointOverride: endpoint, ownerTokenOverride: ownerToken, reconnectBaseMs: 10 })
    await gui.start()
    const resnapshot = vi.fn(); gui.on('resnapshot', resnapshot)
    const errors = vi.fn(); gui.on('error', errors)
    await server.stop()
    server = new MmsProtocolServer({ mms, ownerToken, version: '0.1.1' })
    endpoint = await server.start()
    advertiseOldMethods()
    try {
      await vi.waitFor(() => expect(gui.connectionState).toBe('failed'), { timeout: 5_000 })
      expect(gui.connected).toBe(false)
      expect(resnapshot).not.toHaveBeenCalled()
      expect(errors).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('agents.listNamed') }))
      expect(mms.getOwnerLease()?.owner.token).toBe(ownerToken)
    } finally { await gui.stop() }
  })

  it('mismatched/stale owner token fails without stealing ownership', async () => {
    const gui = new GuiMmsController({
      homeDir: home,
      disableAutoStart: true,
      endpointOverride: endpoint,
      ownerTokenOverride: 'wrong-token'
    })
    await expect(gui.start()).rejects.toThrow(/Hello rejected|auth|token/i)
    // Live owner lease intact
    expect(mms.getOwnerLease()?.owner.token).toBe(ownerToken)
    await gui.stop()
  })

  it('Electron client shutdown does not stop MMS', async () => {
    const gui = new GuiMmsController({
      homeDir: home,
      disableAutoStart: true,
      endpointOverride: endpoint,
      ownerTokenOverride: ownerToken
    })
    await gui.start()
    await gui.stop()
    // New client still connects to same server
    const gui2 = new GuiMmsController({
      homeDir: home,
      disableAutoStart: true,
      endpointOverride: endpoint,
      ownerTokenOverride: ownerToken
    })
    await gui2.start()
    await expect(gui2.request('health')).resolves.toMatchObject({ ok: true })
    await gui2.stop()
  })

  it('waits for a managed daemon reconnect instead of failing requests in the restart gap', async () => {
    const gui = new GuiMmsController({
      homeDir: home,
      managedDaemon: true,
      endpointOverride: endpoint,
      ownerTokenOverride: ownerToken,
      reconnectBaseMs: 10,
      requestTimeoutMs: 2_000
    })
    await gui.start()
    await server.stop()
    await vi.waitFor(() => expect(gui.connected).toBe(false))

    const pendingHealth = gui.request<{ ok: boolean }>('health')
    server = new MmsProtocolServer({ mms, ownerToken, version: 'test' })
    endpoint = await server.start()
    mms.getOwnerLease()?.setEndpoint(endpoint)

    await expect(pendingHealth).resolves.toMatchObject({ ok: true })
    await gui.stop()
  })

  it('same-client send/steer/abort via controller', async () => {
    let release: (() => void) | null = null
    let entered!: () => void
    const waitEnter = new Promise<void>((r) => {
      entered = r
    })
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
      signature: 'gui'
    }
    vi.spyOn(llm, 'getSelectedModelContextLimit').mockReturnValue({ limit: 100_000 })
    vi.spyOn(llm, 'getContextInputs').mockResolvedValue(contextInputs)
    vi.spyOn(llm, 'chat').mockImplementation(async () => {
      entered()
      await new Promise<void>((r) => {
        release = r
      })
      return {
        text: 'done',
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

    const gui = new GuiMmsController({
      homeDir: home,
      disableAutoStart: true,
      endpointOverride: endpoint,
      ownerTokenOverride: ownerToken
    })
    await gui.start()
    const thread = mms.threads.createThread('GuiFlow')

    const sendP = gui.request('orchestrator.send', {
      threadId: thread.id,
      content: 'from gui client'
    })
    await waitEnter
    const steer = await gui.request<{ ok: boolean }>('orchestrator.steer', {
      threadId: thread.id,
      text: 'prefer tests'
    })
    expect(steer.ok).toBe(true)
    const abort = await gui.request<{ ok: boolean }>('orchestrator.abort', {
      threadId: thread.id
    })
    expect(abort.ok).toBe(true)
    release?.()
    await sendP
    await gui.stop()
  })

  it('disconnect during turn; subsequent snapshot contains result', async () => {
    let release: (() => void) | null = null
    let entered!: () => void
    const waitEnter = new Promise<void>((r) => {
      entered = r
    })
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
      signature: 'gui'
    }
    vi.spyOn(llm, 'getSelectedModelContextLimit').mockReturnValue({ limit: 100_000 })
    vi.spyOn(llm, 'getContextInputs').mockResolvedValue(contextInputs)
    vi.spyOn(llm, 'chat').mockImplementation(async () => {
      entered()
      await new Promise<void>((r) => {
        release = r
      })
      return {
        text: 'persisted-after-disconnect',
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

    const gui = new GuiMmsController({
      homeDir: home,
      disableAutoStart: true,
      endpointOverride: endpoint,
      ownerTokenOverride: ownerToken
    })
    await gui.start()
    const thread = mms.threads.createThread('Persist')
    const sendP = gui.request('orchestrator.send', {
      threadId: thread.id,
      content: 'survive client death'
    })
    await waitEnter
    // Simulate Electron process death: stop client only
    await gui.stop()
    await sendP.catch(() => undefined)
    release?.()
    await vi.waitFor(() => {
      const messages = mms.orchestrator.getMessages(thread.id)
      expect(
        messages.some((m) => m.content === 'survive client death') ||
          messages.some((m) => m.content.includes('persisted') || m.content.includes('Stopped'))
      ).toBe(true)
    })

    // Subsequent client sees authoritative snapshot
    const gui2 = new GuiMmsController({
      homeDir: home,
      disableAutoStart: true,
      endpointOverride: endpoint,
      ownerTokenOverride: ownerToken
    })
    await gui2.start()
    await vi.waitFor(async () => {
      const snap = await gui2.snapshotThread(thread.id)
      expect(snap.messages.length).toBeGreaterThan(0)
    })
    await gui2.stop()
  })

  it('bootstrap presentation selects/creates thread and snapshots', async () => {
    const gui = new GuiMmsController({
      homeDir: home,
      disableAutoStart: true,
      endpointOverride: endpoint,
      ownerTokenOverride: ownerToken
    })
    await gui.start()
    const presentation = new PresentationState()
    const broadcasts: Array<{ channel: string; data: unknown }> = []
    const turnSnaps: unknown[] = []
    await bootstrapPresentation(
      gui,
      presentation,
      (channel, data) => {
        broadcasts.push({ channel, data })
      },
      { onTurnSnapshot: (snap) => turnSnaps.push(snap) }
    )
    expect(presentation.getActiveThreadId()).toBeTruthy()
    expect(broadcasts.some((b) => b.channel === 'thread:view')).toBe(true)
    expect(broadcasts.some((b) => b.channel === 'threads:updated')).toBe(true)
    // Daemon turn state must be forwarded so a reopened GUI never shows a
    // live turn as idle (queued prompts looking stuck).
    expect(turnSnaps).toHaveLength(1)
    await gui.stop()
  })

  it('event gap / resnapshot flag forces snapshot path', async () => {
    // Use a long-lived LocalMmsClient so prior sequence/instance is retained across reconnect.
    const { LocalMmsClient } = await import('../src/mms/protocol/client')
    const client = new LocalMmsClient({
      homeDir: home,
      ownerToken,
      endpoint,
      clientType: 'test'
    })
    await client.connect()
    await client.subscribe(0)
    const thread = mms.threads.createThread('Gap')
    mms.orchestrator.bindThread(thread.id, [], undefined, [])
    mms.orchestrator.enqueueForThread(thread.id, 'e1')
    await vi.waitFor(() => {
      expect(client.lastKnownSequence).toBeGreaterThan(0)
    })
    const seqBefore = client.lastKnownSequence
    await client.close()

    await server.stop()
    server = new MmsProtocolServer({ mms, ownerToken, version: 'test', build: 'gap-2' })
    endpoint = await server.start()
    mms.getOwnerLease()?.setEndpoint(endpoint)

    // Reconnect same client object — detects sequence regression / new ring.
    const hello2 = await client.connect()
    expect(hello2.globalSequence).toBeLessThan(seqBefore)
    expect(client.requiresResnapshot).toBe(true)
    await client.close()
  })
})

describe('protocolEventBridge IPC mapping', () => {
  it('maps protocol events to preload-compatible channels', () => {
    const presentation = new PresentationState()
    presentation.setActiveThreadId('t1')
    const seen: Array<{ channel: string; data: unknown }> = []
    const broadcast = (channel: string, data: unknown): void => {
      seen.push({ channel, data })
    }

    const msgEvent: ProtocolEvent = {
      kind: 'event',
      sequence: 1,
      type: 'thread.message',
      threadId: 't1',
      data: { message: { id: 'm1', content: 'hi' } },
      ts: new Date().toISOString()
    }
    expect(bridgeProtocolEvent(msgEvent, broadcast, presentation)).toBe(true)
    expect(seen.some((s) => s.channel === 'orchestrator:thread-message')).toBe(true)

    seen.length = 0
    const bgEvent: ProtocolEvent = {
      ...msgEvent,
      sequence: 2,
      threadId: 'other'
    }
    bridgeProtocolEvent(bgEvent, broadcast, presentation)
    expect(seen.some((s) => s.channel === 'orchestrator:thread-message')).toBe(true)
    // The unscoped selected-thread alias was removed; only thread-scoped channels remain.
    expect(seen.some((s) => s.channel === 'orchestrator:message')).toBe(false)

    seen.length = 0
    broadcastThreadSnapshot(
      't1',
      {
        messages: [{ id: 'm' }],
        queue: [],
        connectionFailed: true,
        agents: [],
        tasks: []
      },
      broadcast,
      presentation
    )
    expect(seen.some((s) => s.channel === 'thread:view')).toBe(true)
    expect(seen.some((s) => s.channel === 'queue:updated')).toBe(true)
    expect(seen.some((s) => s.channel === 'orchestrator:connection-failed')).toBe(true)
  })

  it('forwards questions.cleared to the selected thread so stale prompts drop', () => {
    const presentation = new PresentationState()
    presentation.setActiveThreadId('t1')
    const seen: Array<{ channel: string; data: unknown }> = []
    const broadcast = (channel: string, data: unknown): void => {
      seen.push({ channel, data })
    }

    const cleared: ProtocolEvent = {
      kind: 'event',
      sequence: 1,
      type: 'questions.cleared',
      threadId: 't1',
      data: { requestId: 'r1', threadId: 't1' },
      ts: new Date().toISOString()
    }
    expect(bridgeProtocolEvent(cleared, broadcast, presentation)).toBe(true)
    expect(
      seen.some(
        (s) =>
          s.channel === 'orchestrator:questionsCleared' &&
          (s.data as { requestId?: string }).requestId === 'r1'
      )
    ).toBe(true)

    // Background threads must not clear the selected thread's composer.
    seen.length = 0
    bridgeProtocolEvent({ ...cleared, sequence: 2, threadId: 'other' }, broadcast, presentation)
    expect(seen.some((s) => s.channel === 'orchestrator:questionsCleared')).toBe(false)
  })
})
