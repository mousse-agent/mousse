import { randomBytes } from 'node:crypto'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebhookAdapter } from '../src/mms/channels/adapters/WebhookAdapter'
import { IdempotencyStore } from '../src/mms/control/storage/idempotencyStore'
import { RemoteSessionDispatcher } from '../src/mms/control/relay/remoteDispatcher'
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
  for (const gate of releases.splice(0)) gate.resolve()
  await new Promise((resolve) => setImmediate(resolve))
  for (const close of closers.splice(0)) await close().catch(() => undefined)
  for (const home of homes.splice(0)) removeOwnedHome(home)
})

describe('channel shutdown ownership', () => {
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
    const adapter = new WebhookAdapter({ enabled: true, webhookPort: 0, allowAllUsers: true })
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
      headers: { 'Content-Type': 'application/json' },
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
})
