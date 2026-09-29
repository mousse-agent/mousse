import { randomBytes } from 'node:crypto'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebhookAdapter } from '../src/mms/channels/adapters/WebhookAdapter'
import { DiscordAdapter } from '../src/mms/channels/adapters/DiscordAdapter'
import type { Client, ChatInputCommandInteraction } from 'discord.js'
import { IdempotencyStore } from '../src/mms/control/storage/idempotencyStore'
import { RemoteSessionDispatcher } from '../src/mms/control/relay/remoteDispatcher'
import { RelayClient } from '../src/mms/control/relay/relayClient'
import { ControlStore } from '../src/mms/control/storage/controlStore'
import { MmsEventBus } from '../src/mms/events'
import type { ControlEnvelope, ControlRequestEnvelope, PairingGrant } from '../src/shared/controlTypes'
import {
  createChannelService,
  createControlService,
  createOwnedHome,
  createRouter,
  deferred,
  FixtureAdapter,
  heldTurnRunner,
  inbound,
  listenLocal,
  removeOwnedHome
} from './fixtures/agent-platform/channel-control-lifecycle/helpers'

const homes: string[] = []
const releases: Array<{ resolve: () => void }> = []
const closers: Array<() => Promise<void>> = []

function ownHome(): string {
  const home = createOwnedHome()
  homes.push(home)
  return home
}

function hold() {
  const gate = deferred()
  releases.push(gate)
  return gate
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('Timed out waiting for fixture state')
    await new Promise((resolve) => setImmediate(resolve))
  }
}

afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  for (const gate of releases.splice(0)) gate.resolve()
  await new Promise((resolve) => setImmediate(resolve))
  for (const close of closers.splice(0)) await close().catch(() => undefined)
  for (const home of homes.splice(0)) removeOwnedHome(home)
})

describe('channel shutdown ownership', () => {
  it('owns a delayed Discord interaction and does not route or retain it after disconnect', async () => {
    const adapter = new DiscordAdapter({ enabled: true, token: 'fixture-token', allowAllUsers: true })
    const deferredReply = hold()
    const entered = deferred()
    const routed: unknown[] = []
    const client = { destroy: vi.fn() } as unknown as Client
    const interaction = {
      id: 'interaction-late',
      commandName: 'ask',
      options: { getString: () => 'hello' },
      deferReply: async () => {
        entered.resolve()
        await deferredReply.promise
      },
      deferred: true,
      replied: false,
      editReply: vi.fn(),
      channel: null,
      channelId: 'discord-channel',
      guildId: null,
      user: { id: 'discord-user', username: 'fixture' }
    } as unknown as ChatInputCommandInteraction
    const internals = adapter as unknown as {
      client: Client
      connectionEpoch: number
      status: { platform: 'discord'; state: 'connecting' }
      inboundHandler: (message: unknown) => void
      interactionWork: Set<Promise<void>>
      pendingInteractionReplies: Map<string, unknown>
      handleSlashCommand: (interaction: ChatInputCommandInteraction, epoch: number, client: Client) => Promise<void>
      trackInteraction: (work: Promise<void>) => void
    }
    internals.client = client
    internals.connectionEpoch = 7
    internals.status = { platform: 'discord', state: 'connecting' }
    internals.inboundHandler = (message) => routed.push(message)
    internals.trackInteraction(internals.handleSlashCommand(interaction, 7, client))

    await entered.promise
    const disconnecting = adapter.disconnect()
    expect(internals.interactionWork.size).toBe(1)
    await expect(
      Promise.race([
        disconnecting.then(() => 'disconnected'),
        new Promise((resolve) => setTimeout(() => resolve('waiting'), 25))
      ])
    ).resolves.toBe('waiting')

    deferredReply.resolve()
    await disconnecting
    expect(routed).toEqual([])
    expect(internals.pendingInteractionReplies.size).toBe(0)
    expect(internals.interactionWork.size).toBe(0)
    expect(interaction.editReply).not.toHaveBeenCalled()
  })

  it('waits for an inbound turn and typing that ignore abort, then suppresses the reply', async () => {
    const home = ownHome()
    const adapter = new FixtureAdapter()
    const entered = deferred()
    const turn = hold()
    const typing = hold()
    adapter.typingHold = typing.promise
    const marker = join(home, 'channel-final.txt')
    const { router } = createRouter(
      home,
      heldTurnRunner(entered, turn, () => writeFileSync(marker, 'channel-final')),
      adapter
    )

    const inboundWork = router.handleInbound(inbound('hello'))
    await entered.promise
    router.beginShutdown()
    expect(router.getActiveCount()).toBeGreaterThan(0)
    await expect(router.shutdown({ timeoutMs: 25 })).rejects.toMatchObject({ code: 'profile_busy' })
    expect(existsSync(marker)).toBe(false)
    expect(adapter.sent).toEqual([])

    turn.resolve()
    await expect(router.shutdown({ timeoutMs: 25 })).rejects.toMatchObject({ code: 'profile_busy' })
    expect(existsSync(marker)).toBe(true)
    expect(adapter.sent).toEqual([])

    typing.resolve()
    await Promise.all([inboundWork, router.shutdown()])
    expect(adapter.sent).toEqual([])
    expect(router.getActiveCount()).toBe(0)
    await expect(router.handleInbound(inbound('late'))).rejects.toMatchObject({ code: 'profile_draining' })
    await expect(router.sendTest('telegram', '42', 'ping')).rejects.toMatchObject({ code: 'profile_draining' })
  })

  it('admits queued same-session work then suppresses it without a send', async () => {
    const home = ownHome()
    const adapter = new FixtureAdapter()
    const firstEntered = deferred()
    const firstRelease = hold()
    let secondStarted = false
    const { router } = createRouter(
      home,
      {
        runChannelTurn: async (_threadId, text) => {
          if (text === 'one') {
            firstEntered.resolve()
            await firstRelease.promise
          } else {
            secondStarted = true
          }
          return { text: `reply:${text}`, silent: false }
        }
      },
      adapter
    )

    const first = router.handleInbound(inbound('one'))
    await firstEntered.promise
    const second = router.handleInbound(inbound('two'))
    await waitUntil(() => router.getActiveCount() >= 2)
    router.beginShutdown()
    await expect(router.shutdown({ timeoutMs: 25 })).rejects.toMatchObject({ code: 'profile_busy' })
    expect(adapter.sent).toEqual([])
    expect(secondStarted).toBe(false)

    firstRelease.resolve()
    await Promise.all([first, second, router.shutdown()])
    expect(secondStarted).toBe(false)
    expect(adapter.sent).toEqual([])
    expect(router.getActiveCount()).toBe(0)
  })

  it('keeps a mid-connect attempt owned when the adapter ignores abort, then disconnects it', async () => {
    const home = ownHome()
    const adapter = new FixtureAdapter()
    const connect = hold()
    adapter.connectHold = connect.promise
    adapter.ignoreConnectAbort = true
    const { service } = createChannelService(home, { runChannelTurn: async () => ({ text: 'no', silent: true }) }, adapter)
    const directoryPath = join(home, 'channels', 'directory.json')

    const connecting = service.connect('telegram')
    await waitUntil(() => Boolean(adapter.connectSignal))
    service.beginShutdown()
    expect(adapter.connectSignal?.aborted).toBe(true)
    const first = service.shutdown({ timeoutMs: 25 })
    const second = service.shutdown({ timeoutMs: 25 })
    await expect(first).rejects.toMatchObject({ code: 'profile_busy' })
    await expect(second).rejects.toMatchObject({ code: 'profile_busy' })
    expect(service.getActiveCount()).toBeGreaterThan(0)
    expect(adapter.connected).toBe(false)

    connect.resolve()
    await Promise.all([connecting, service.shutdown()])
    expect(adapter.connected).toBe(false)
    expect(adapter.disconnectCalls).toBeGreaterThan(0)
    expect(service.getActiveCount()).toBe(0)
    expect(existsSync(directoryPath)).toBe(false)
    await expect(service.connect('telegram')).rejects.toMatchObject({ code: 'profile_draining' })
    expect(() => service.updateConfig({ unauthorizedDmBehavior: 'ignore' })).toThrowError(/shutting down/)
  })

  it('leaves ordinary stopAll reversible and makes shutdown permanent', async () => {
    const home = ownHome()
    const adapter = new FixtureAdapter()
    const { service } = createChannelService(home, { runChannelTurn: async () => ({ text: 'ok', silent: false }) }, adapter)

    await service.connect('telegram')
    expect(adapter.connected).toBe(true)
    await service.stopAll()
    expect(adapter.connected).toBe(false)
    await service.connect('telegram')
    expect(adapter.connected).toBe(true)
    expect(await service.sendTest('telegram', '42', 'ping')).toMatchObject({ success: true })
    expect(adapter.sent.map((message) => message.text)).toContain('ping')

    await service.shutdown()
    expect(adapter.connected).toBe(false)
    await expect(service.connect('telegram')).rejects.toMatchObject({ code: 'profile_draining' })
    await expect(service.sendTest('telegram', '42', 'later')).rejects.toMatchObject({ code: 'profile_draining' })
  })

  it('does not let a connecting adapter reappear after a concurrent reversible disconnect', async () => {
    const home = ownHome()
    const adapter = new FixtureAdapter()
    const connect = hold()
    adapter.connectHold = connect.promise
    adapter.ignoreConnectAbort = true
    const { service } = createChannelService(home, { runChannelTurn: async () => ({ text: 'ok', silent: false }) }, adapter)

    const connecting = service.connect('telegram')
    await waitUntil(() => Boolean(adapter.connectSignal))
    const disconnected = service.disconnect('telegram')
    await disconnected
    expect(adapter.connected).toBe(false)

    connect.resolve()
    await connecting
    expect(adapter.connected).toBe(false)
    expect(service.getSnapshot().statuses.find(({ platform }) => platform === 'telegram')?.state).toBe('disconnected')
  })

  it('retains a failed adapter close for a later shutdown retry', async () => {
    const adapter = new FixtureAdapter()
    const { service } = createChannelService(
      ownHome(),
      { runChannelTurn: async () => ({ text: 'ok', silent: false }) },
      adapter
    )
    await service.connect('telegram')
    const disconnect = vi.spyOn(adapter, 'disconnect')
    disconnect.mockRejectedValueOnce(new Error('fixture close failed'))

    await expect(service.shutdown()).rejects.toThrow(/failed to disconnect/)
    expect(adapter.connected).toBe(true)
    expect(service.getActiveCount()).toBeGreaterThan(0)

    await service.shutdown()
    expect(disconnect).toHaveBeenCalledTimes(2)
    expect(adapter.connected).toBe(false)
    expect(service.getActiveCount()).toBe(0)
  })

  it('does not freeze a peer profile channel service', async () => {
    const homeA = ownHome()
    const homeB = ownHome()
    const adapterA = new FixtureAdapter()
    const adapterB = new FixtureAdapter()
    const entered = deferred()
    const turn = hold()
    const a = createChannelService(homeA, heldTurnRunner(entered, turn), adapterA)
    const b = createChannelService(homeB, { runChannelTurn: async () => ({ text: 'peer', silent: false }) }, adapterB)

    await a.service.connect('telegram')
    await b.service.connect('telegram')
    adapterA.inboundHandler?.(inbound('held'))
    await entered.promise
    a.service.beginShutdown()
    await expect(a.service.shutdown({ timeoutMs: 25 })).rejects.toMatchObject({ code: 'profile_busy' })
    expect(await b.service.sendTest('telegram', '42', 'peer-ok')).toMatchObject({ success: true })
    expect(adapterB.sent.map((message) => message.text)).toContain('peer-ok')
    expect(adapterA.sent).toEqual([])

    turn.resolve()
    await a.service.shutdown()
    expect(adapterA.sent).toEqual([])
    expect(b.service.getActiveCount()).toBe(0)
  })

  it('drains a real local webhook request and refuses later posts after shutdown', async () => {
    const home = ownHome()
    const adapter = new WebhookAdapter({
      enabled: true,
      webhookPort: 0,
      allowAllUsers: true,
      webhookSecret: 'fixture-secret'
    })
    const entered = deferred()
    const turn = hold()
    const { service } = createChannelService(home, heldTurnRunner(entered, turn), adapter)

    await service.connect('webhook')
    closers.push(() => adapter.disconnect())
    const port = adapter.getListenPort()
    expect(port).toBeTruthy()
    const url = `http://127.0.0.1:${port}/channels/webhook`
    const post = fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-mousse-secret': 'fixture-secret' },
      body: JSON.stringify({ text: 'hook-hi', chatId: 'local' })
    })
    await entered.promise
    service.beginShutdown()
    await expect(service.shutdown({ timeoutMs: 25 })).rejects.toMatchObject({ code: 'profile_busy' })

    turn.resolve()
    await service.shutdown()
    const first = await post
    expect(first.ok).toBe(true)
    expect(await first.json()).toEqual({ replies: [] })
    expect(adapter.getListenPort()).toBeNull()

    await expect(fetch(url, { method: 'POST', body: '{}' })).rejects.toThrow()
    expect(service.getActiveCount()).toBe(0)
  })
})

describe('control shutdown ownership', () => {
  it('retains relay socket ownership until close and ignores an old socket close after restart', async () => {
    class FixtureWebSocket {
      static readonly CLOSED = 3
      static readonly OPEN = 1
      readonly url: string
      readyState = FixtureWebSocket.OPEN
      closeCalls = 0
      onopen: (() => void) | null = null
      onmessage: ((event: { data: unknown }) => void) | null = null
      onclose: ((event: { code: number; reason: string }) => void) | null = null
      onerror: ((error: unknown) => void) | null = null

      constructor(url: string) {
        this.url = url
        sockets.push(this)
      }

      send(): void {}
      close(): void { this.closeCalls += 1 }
      finishClose(): void {
        this.readyState = FixtureWebSocket.CLOSED
        this.onclose?.({ code: 1000, reason: 'fixture close' })
      }
    }
    const sockets: FixtureWebSocket[] = []
    vi.stubGlobal('WebSocket', FixtureWebSocket)
    const relay = new RelayClient(new ControlStore(ownHome()))

    relay.start()
    expect(sockets).toHaveLength(1)
    const first = sockets[0]!
    relay.stop()
    expect(first.closeCalls).toBe(1)
    expect(relay.getActiveCount()).toBe(1)
    const idle = relay.waitForIdle()
    await expect(
      Promise.race([idle.then(() => 'idle'), new Promise((resolve) => setTimeout(() => resolve('waiting'), 25))])
    ).resolves.toBe('waiting')

    relay.start()
    expect(sockets).toHaveLength(2)
    const second = sockets[1]!
    first.finishClose()
    await idle
    expect(relay.getStatus()).toBe('connecting')
    expect(second.closeCalls).toBe(0)

    relay.stop()
    expect(relay.getActiveCount()).toBe(1)
    second.finishClose()
    await relay.waitForIdle()
    expect(relay.getActiveCount()).toBe(0)
  })

  it('does not recreate a hosted pending pairing when registration settles after shutdown', async () => {
    const home = ownHome()
    const control = createControlService(home)
    control.store.saveCredentials({
      accountId: 'fixture-account',
      accessToken: 'fixture-access',
      deviceEnrollmentToken: 'fixture-device',
      updatedAt: new Date().toISOString()
    })
    const entered = deferred()
    const response = hold()
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      entered.resolve()
      await response.promise
      return new Response('{}', { status: 200 })
    })

    const creating = control.createPairing({ ttlMs: 5_000 })
    await entered.promise
    control.beginShutdown()
    await expect(control.shutdown({ timeoutMs: 25 })).rejects.toMatchObject({ code: 'profile_busy' })
    expect(control.getStatus().pendingPairing).toBeUndefined()

    response.resolve()
    await expect(creating).rejects.toMatchObject({ code: 'profile_draining' })
    await control.shutdown()
    expect(control.getStatus().pendingPairing).toBeUndefined()
    expect(control.getActiveCount()).toBe(0)
  })

  it('removes pending approval callbacks during shutdown', () => {
    const control = createControlService(ownHome())
    const baseline = control.pairing.listenerCount('pairing:approved')
    const internals = control as unknown as {
      onPeerClaimedForSession: (
        pairingId: string,
        mobileDeviceId: string,
        sendCipher: unknown,
        recvCipher: unknown
      ) => void
    }
    internals.onPeerClaimedForSession('pair-pending', 'mobile-pending', {}, {})
    expect(control.pairing.listenerCount('pairing:approved')).toBe(baseline + 1)

    control.beginShutdown()
    expect(control.pairing.listenerCount('pairing:approved')).toBe(baseline)
    expect(control.getActiveCount()).toBe(0)
  })

  it('waits for an admitted executor that ignores abort and skips a self-shutdown deadlock', async () => {
    const home = ownHome()
    const marker = join(home, 'control-final.txt')
    const entered = deferred()
    const work = hold()
    const control = createControlService(home, {
      execute: async () => {
        entered.resolve()
        await work.promise
        writeFileSync(marker, 'control-final')
        return { ok: true }
      }
    })

    const running = control.getAdmittedExecutor().execute('health', {})
    await entered.promise
    const first = control.shutdown({ timeoutMs: 25 })
    const second = control.shutdown({ timeoutMs: 25 })
    await expect(first).rejects.toMatchObject({ code: 'profile_busy' })
    await expect(second).rejects.toMatchObject({ code: 'profile_busy' })
    expect(control.getActiveCount()).toBeGreaterThan(0)
    expect(existsSync(marker)).toBe(false)

    work.resolve()
    await Promise.all([running, control.shutdown()])
    expect(existsSync(marker)).toBe(true)
    expect(control.getActiveCount()).toBe(0)

    const nestedHome = ownHome()
    const nested = createControlService(nestedHome, {
      execute: async () => {
        await nested.shutdown()
        return { nested: true }
      }
    })
    await expect(nested.getAdmittedExecutor().execute('health', {})).resolves.toEqual({ nested: true })
    await expect(nested.start()).rejects.toMatchObject({ code: 'profile_draining' })
  })

  it('registers synchronous and post-await executor work before nested shutdown', async () => {
    const control = createControlService(ownHome())
    const counts: number[] = []
    const nestedShutdowns: Promise<void>[] = []
    control.setExecutor({
      execute: (method) => {
        if (method === 'sync') {
          counts.push(control.getActiveCount())
          nestedShutdowns.push(control.shutdown())
          return Promise.resolve({ sync: true })
        }
        return Promise.resolve().then(() => {
          counts.push(control.getActiveCount())
          nestedShutdowns.push(control.shutdown())
          return { async: true }
        })
      }
    })

    await expect(control.getAdmittedExecutor().execute('sync', {})).resolves.toEqual({ sync: true })
    await Promise.all(nestedShutdowns.splice(0))
    expect(counts).toEqual([1])

    const other = createControlService(ownHome())
    const asyncCounts: number[] = []
    const asyncShutdowns: Promise<void>[] = []
    other.setExecutor({
      execute: async () => {
        await Promise.resolve()
        asyncCounts.push(other.getActiveCount())
        asyncShutdowns.push(other.shutdown())
        return { async: true }
      }
    })
    await expect(other.getAdmittedExecutor().execute('async', {})).resolves.toEqual({ async: true })
    await Promise.all(asyncShutdowns)
    expect(asyncCounts).toEqual([1])
  })

  it('keeps enrollment owned when the transport ignores abort and does not persist credentials', async () => {
    const home = ownHome()
    const control = createControlService(home)
    const entered = deferred()
    const response = hold()
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      entered.resolve()
      await response.promise
      return new Response(JSON.stringify({ device_token: 'fixture-token' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    })

    const enroll = control.enrollSelfHosted('http://127.0.0.1:9', 'pair-code')
    await entered.promise
    control.beginShutdown()
    await expect(control.shutdown({ timeoutMs: 25 })).rejects.toMatchObject({ code: 'profile_busy' })
    expect(control.store.getCredentials()).toBeNull()

    response.resolve()
    await Promise.all([enroll, control.shutdown()])
    expect(control.store.getCredentials()).toBeNull()
    expect((await enroll).ok).toBe(false)
    await expect(control.loginDesktop(async () => undefined)).rejects.toMatchObject({ code: 'profile_draining' })
    await expect(control.createPairing()).rejects.toMatchObject({ code: 'profile_draining' })
  })

  it('cancels a real local enrollment request and keeps ordinary stop reversible', async () => {
    const home = ownHome()
    const control = createControlService(home)
    await control.start()
    await control.stop()
    await control.start()

    const arrived = deferred()
    const finish = hold()
    const server = await listenLocal((req, res) => {
      arrived.resolve()
      void finish.promise.then(() => {
        if (res.writableEnded) return
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ device_token: 'too-late' }))
      })
    })
    closers.push(server.close)

    const enroll = control.enrollSelfHosted(server.url, 'pair-code')
    await arrived.promise
    await control.shutdown()
    expect((await enroll).ok).toBe(false)
    expect(control.store.getCredentials()).toBeNull()
    expect(control.getActiveCount()).toBe(0)
    await expect(control.start()).rejects.toMatchObject({ code: 'profile_draining' })
    await expect(control.setMode('self-hosted')).rejects.toMatchObject({ code: 'profile_draining' })
  })

  it('does not block a peer control service and ignores late relay frames', async () => {
    const homeA = ownHome()
    const homeB = ownHome()
    const entered = deferred()
    const work = hold()
    const a = createControlService(homeA, {
      execute: async () => {
        entered.resolve()
        await work.promise
        return { ok: true }
      }
    })
    const b = createControlService(homeB)
    await b.start()

    const running = a.getAdmittedExecutor().execute('health', {})
    await entered.promise
    a.beginShutdown()
    await expect(a.shutdown({ timeoutMs: 25 })).rejects.toMatchObject({ code: 'profile_busy' })
    const pairing = await b.createPairing({ ttlMs: 5_000 })
    expect(pairing.pairingId).toMatch(/^pair-/)
    expect(b.getStatus().pendingPairing?.pairingId).toBe(pairing.pairingId)

    work.resolve()
    await Promise.all([running, a.shutdown()])
    a.getRelayClient().emit('message', Buffer.from('{"kind":"handshake_init_xx","pairingId":"pair-late"}'))
    await new Promise((resolve) => setImmediate(resolve))
    expect(a.getActiveCount()).toBe(0)
    await b.stop()
  })

  it('awaits a closed dispatcher RPC and suppresses the late envelope send', async () => {
    const sent: ControlEnvelope[] = []
    const entered = deferred()
    const work = hold()
    const grant: PairingGrant = {
      pairingId: 'pair-lifecycle',
      mobileDeviceId: 'mobile-1',
      mobileDeviceName: 'Fixture Phone',
      mobileStaticPublicKey: randomBytes(32).toString('base64'),
      grantedScopes: ['mousse:read'],
      createdAt: new Date().toISOString(),
      status: 'active',
      receiptSignature: randomBytes(32).toString('base64')
    }
    const dispatcher = new RemoteSessionDispatcher({
      grant,
      executor: {
        execute: async () => {
          entered.resolve()
          await work.promise
          return { secretKey: 'do-not-send' }
        }
      },
      idempotencyStore: new IdempotencyStore(),
      instanceId: 'fixture-dispatcher',
      sendEnvelope: (envelope) => sent.push(envelope)
    })

    const request: ControlRequestEnvelope = {
      kind: 'request',
      id: 'req-lifecycle',
      method: 'threads.get',
      params: {}
    }
    const pending = dispatcher.handleEnvelope(request)
    await entered.promise
    dispatcher.close()
    expect(dispatcher.getActiveCount()).toBe(1)
    const idle = dispatcher.waitForIdle()
    await expect(
      Promise.race([idle.then(() => 'idle'), new Promise((resolve) => setTimeout(() => resolve('timeout'), 25))])
    ).resolves.toBe('timeout')
    expect(sent).toEqual([])

    work.resolve()
    await Promise.all([pending, idle])
    expect(sent).toEqual([])
    expect(dispatcher.getActiveCount()).toBe(0)
    await dispatcher.handleEnvelope(request)
    expect(sent).toEqual([])
  })

  it('unsubscribes a closed dispatcher from profile events', () => {
    const eventBus = new MmsEventBus()
    const dispatcher = new RemoteSessionDispatcher({
      grant: {
        pairingId: 'pair-events',
        mobileDeviceId: 'mobile-events',
        mobileStaticPublicKey: randomBytes(32).toString('base64'),
        grantedScopes: ['mousse:read'],
        createdAt: new Date().toISOString(),
        status: 'active',
        receiptSignature: randomBytes(32).toString('base64')
      },
      executor: { execute: async () => ({ ok: true }) },
      idempotencyStore: new IdempotencyStore(),
      eventBus,
      instanceId: 'fixture-events',
      sendEnvelope: () => undefined
    })
    const push = vi.fn(() => ({ sequence: 1 }))
    ;(dispatcher as unknown as { eventRing: { push: typeof push } }).eventRing = { push }

    eventBus.broadcast('projects:updated', { id: 'before-close' })
    expect(push).toHaveBeenCalledTimes(1)
    dispatcher.close()
    dispatcher.close()
    eventBus.broadcast('projects:updated', { id: 'after-close' })
    expect(push).toHaveBeenCalledTimes(1)
  })
})
