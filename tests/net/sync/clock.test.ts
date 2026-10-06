import { afterEach, expect, it, vi } from 'vitest'
import type { WireMessage } from '../../../src/shared/net/wire'
import type { Mux } from '../../../src/mms/net/contracts'
import { NetSyncSession } from '../../../src/mms/net/sync/session'
import type { RoutesRecord, SpaceDescriptor } from '../../../src/shared/net/identity'
import { cleanup, profile } from '../spaces/discovery/profile'
import { FakeClock } from '../harness/FakeClock'
import { systemClock } from '../../../src/mms/net/clock'
import { SESSION_MAX_INFLIGHT_RPCS } from '../../../src/shared/net/limits'

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
async function connected(clock = systemClock, holdHostAck = false) {
  const host = profile(clock),
    member = profile(clock)
  for (const p of [host, member]) {
    await p.net.request('net.init', { listen: true })
    await p.net.request('net.protect', { passphrase: 'actual-clock-proof-test' })
  }
  const space = host.spaces.host.create({ name: 'Actual clock sample' })
  await member.spaces.client.join(
    member.spaces.client.prepareJoin(host.spaces.host.invite(space.space).text)
  )
  const descriptor = JSON.parse(
    Buffer.from(space.descriptor.payload, 'base64url').toString()
  ) as SpaceDescriptor
  const routes = JSON.parse(
    Buffer.from(host.net.signedRoutes().payload, 'base64url').toString()
  ) as RoutesRecord
  let releaseHostAck = () => {}
  const heldAck = new Promise<void>((resolve) => {
    releaseHostAck = resolve
  })
  const prototype = NetSyncSession.prototype as unknown as {
    send(header: WireMessage, parts?: Uint8Array[], signal?: AbortSignal): Promise<void>
    options: { identity: { self(): { node: string } | undefined } }
  }
  const send = prototype.send
  // Hold completion after delivering the ACK to reproduce the real ordering gap.
  const ackSend = holdHostAck
    ? vi.spyOn(prototype, 'send').mockImplementation(async function (header, parts, signal) {
        await send.call(this, header, parts, signal)
        if (header.t === 'helloAck' && this.options.identity.self()?.node === descriptor.hostNode)
          await heldAck
      })
    : undefined
  try {
    const session = await member.net.connectDomainSession(
      {
        user: descriptor.owner,
        node: descriptor.hostNode,
        transportKey: descriptor.hostTransportKey,
        routes: routes.routes
      },
      new AbortController().signal
    )
    return { host, member, space, session, releaseHostAck }
  } catch (error) {
    releaseHostAck()
    throw error
  } finally {
    ackSend?.mockRestore()
  }
}
it('has actual correlated clock evidence after initial and concurrent meta refreshes without waiting for the periodic ping', async () => {
  const { session, space } = await connected()
  expect(session.clockEstimate()).toBeUndefined()
  const clockSession = session as unknown as {
    pong(n: number, now: number): void
    probes: Map<number, unknown>
  }
  const pong = clockSession.pong.bind(session),
    correlations: boolean[] = []
  vi.spyOn(clockSession, 'pong').mockImplementation((n, now) => {
    correlations.push(clockSession.probes.has(n))
    pong(n, now)
  })
  const heads = await Promise.all(Array.from({ length: 4 }, () => session.metaHead(space.meta)))
  expect(heads.every((head) => head.epoch === 1 && head.seq > 0)).toBe(true)
  expect(correlations).toEqual([true, true, true, true])
  const estimate = session.clockEstimate()!
  expect(estimate).toBeDefined()
  expect(estimate.rttMs).toBeGreaterThanOrEqual(0)
  expect(estimate.rttMs).toBeLessThanOrEqual(5000)
  expect(Math.abs(estimate.wallDeltaMs)).toBeLessThanOrEqual(1000)
}, 10000)
it('keeps a periodic heartbeat slot when immediate meta probes overlap held pongs', async () => {
  const clock = new FakeClock(Date.now()),
    { host, session, space, releaseHostAck } = await connected(clock, true)
  const sources = [...(host.net as unknown as { sessions: Set<NetSyncSession> }).sessions]
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  for (const source of sources) {
    const mux = (source as unknown as { mux: Mux }).mux,
      send = mux.send.bind(mux)
    vi.spyOn(mux, 'send').mockImplementation(async (lane, message, signal) => {
      if (message.header.t === 'pong') await held
      return send(lane, message, signal)
    })
  }
  try {
    expect(sources.some((source) => source.state() === 'connecting')).toBe(true)
    // A delivered ACK opens the client before the Host send promise settles.
    // Wait for both endpoints before crossing the Host's preauth deadline.
    releaseHostAck()
    await Promise.all(sources.map((source) => source.opened))
    clock.advance(19999)
    let rejected = 0
    for (let n = 0; n <= SESSION_MAX_INFLIGHT_RPCS; n++)
      await Promise.resolve()
        .then(() => session.metaHead(space.meta))
        .catch((error) => {
          rejected++
          expect(n).toBe(SESSION_MAX_INFLIGHT_RPCS)
          expect(error).toMatchObject({ code: 'rate_limited' })
        })
    expect(rejected).toBe(1)
    expect(() => clock.advance(1)).not.toThrow()
    expect(
      (session as unknown as { probes: Map<number, unknown> }).probes.size
    ).toBeLessThanOrEqual(SESSION_MAX_INFLIGHT_RPCS + 1)
    expect(session.state()).toBe('open')
  } finally {
    releaseHostAck()
    release()
  }
}, 10000)
it('does not qualify a valid meta reply or a pong delayed beyond the actual RTT bound', async () => {
  const { host, session, space } = await connected()
  const sources = [...(host.net as unknown as { sessions: Set<NetSyncSession> }).sessions]
  let release!: () => void, entered!: () => void
  const held = new Promise<void>((resolve) => {
      release = resolve
    }),
    started = new Promise<void>((resolve) => {
      entered = resolve
    })
  for (const source of sources) {
    const mux = (source as unknown as { mux: Mux }).mux,
      send = mux.send.bind(mux)
    vi.spyOn(mux, 'send').mockImplementation(async (lane, message, signal) => {
      if (message.header.t === 'pong') {
        entered()
        await held
      }
      return send(lane, message, signal)
    })
  }
  const head = await session.metaHead(space.meta)
  try {
    await started
    expect(head.seq).toBeGreaterThan(0)
    expect(session.clockEstimate()).toBeUndefined()
    await new Promise((resolve) => setTimeout(resolve, 5100))
    release()
    await Promise.allSettled(sources.flatMap((source) => source.activeTasks()))
    await vi.waitFor(() =>
      expect((session as unknown as { probes: Map<number, unknown> }).probes.size).toBe(0)
    )
    expect(session.clockEstimate()).toBeUndefined()
  } finally {
    release()
  }
}, 10000)
