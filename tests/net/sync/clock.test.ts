import { afterEach, expect, it, vi } from 'vitest'
import type { Mux } from '../../../src/mms/net/contracts'
import { NetSyncSession } from '../../../src/mms/net/sync/session'
import type { RoutesRecord, SpaceDescriptor } from '../../../src/shared/net/identity'
import { cleanup, profile } from '../spaces/discovery/profile'

afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
async function connected() {
  const host = profile(), member = profile()
  for (const p of [host, member]) { await p.net.request('net.init', { listen: true }); await p.net.request('net.protect', { passphrase: 'actual-clock-proof-test' }) }
  const space = host.spaces.host.create({ name: 'Actual clock sample' })
  await member.spaces.client.join(member.spaces.client.prepareJoin(host.spaces.host.invite(space.space).text))
  const descriptor = JSON.parse(Buffer.from(space.descriptor.payload, 'base64url').toString()) as SpaceDescriptor
  const routes = JSON.parse(Buffer.from(host.net.signedRoutes().payload, 'base64url').toString()) as RoutesRecord
  const session = await member.net.connectDomainSession({ user: descriptor.owner, node: descriptor.hostNode, transportKey: descriptor.hostTransportKey, routes: routes.routes }, new AbortController().signal)
  return { host, member, space, session }
}
it('has actual correlated clock evidence after initial and concurrent meta refreshes without waiting for the periodic ping', async () => {
  const { session, space } = await connected()
  expect(session.clockEstimate()).toBeUndefined()
  const clockSession = session as unknown as { pong(n: number, now: number): void; probes: Map<number, unknown> }
  const pong = clockSession.pong.bind(session), correlations: boolean[] = []
  vi.spyOn(clockSession, 'pong').mockImplementation((n, now) => {
    correlations.push(clockSession.probes.has(n)); pong(n, now)
  })
  const heads = await Promise.all(Array.from({ length: 4 }, () => session.metaHead(space.meta)))
  expect(heads.every(head => head.epoch === 1 && head.seq > 0)).toBe(true)
  expect(correlations).toEqual([true, true, true, true])
  const estimate = session.clockEstimate()!
  expect(estimate).toBeDefined()
  expect(estimate.rttMs).toBeGreaterThanOrEqual(0); expect(estimate.rttMs).toBeLessThanOrEqual(5000)
  expect(Math.abs(estimate.wallDeltaMs)).toBeLessThanOrEqual(1000)
}, 10000)
it('does not qualify a valid meta reply or a pong delayed beyond the actual RTT bound', async () => {
  const { host, session, space } = await connected()
  const sources = [...(host.net as unknown as { sessions: Set<NetSyncSession> }).sessions]
  let release!: () => void, entered!: () => void
  const held = new Promise<void>(resolve => { release = resolve }), started = new Promise<void>(resolve => { entered = resolve })
  for (const source of sources) {
    const mux = (source as unknown as { mux: Mux }).mux, send = mux.send.bind(mux)
    vi.spyOn(mux, 'send').mockImplementation(async (lane, message, signal) => {
      if (message.header.t === 'pong') { entered(); await held }
      return send(lane, message, signal)
    })
  }
  const head = await session.metaHead(space.meta)
  try {
    await started
    expect(head.seq).toBeGreaterThan(0)
    expect(session.clockEstimate()).toBeUndefined()
    await new Promise(resolve => setTimeout(resolve, 5100))
    release()
    await Promise.allSettled(sources.flatMap(source => source.activeTasks()))
    await vi.waitFor(() => expect((session as unknown as { probes: Map<number, unknown> }).probes.size).toBe(0))
    expect(session.clockEstimate()).toBeUndefined()
  } finally { release() }
}, 10000)
