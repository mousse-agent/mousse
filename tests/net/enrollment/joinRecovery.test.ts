import { afterEach, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NetService } from '../../../src/mms/net/NetService'
import { systemClock } from '../../../src/mms/net/clock'
import type { Clock } from '../../../src/mms/net/contracts'
import { NetError, type NodeId, type NetStatus } from '../../../src/shared/net'

/**
 * What a computer is left with after a join fails, by where it failed:
 * - never sent (no request left the durable boundary): dropped at once, also after a restart
 * - sent, answer lost: kept for Retry (same node, also after a restart and after the link expired) or Give up
 * - sent, refused by the other computer: dropped, with the reason
 */
const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/** Both computers share one clock, moved forward to let a link expire without a clock gap between them. */
const shift = { ms: 0 }
const clock: Clock = { ...systemClock, now: () => Date.now() + shift.ms }
afterEach(() => {
  shift.ms = 0
})

function directory(): string {
  const path = mkdtempSync(join(tmpdir(), 'mousse-join-recovery-'))
  cleanups.push(() => rmSync(path, { recursive: true, force: true }))
  return path
}
function service(path: string): NetService {
  const net = new NetService({ profileDir: path, clock })
  cleanups.push(() => net.shutdown())
  return net
}
async function authority(name = 'Studio Mac') {
  const path = directory(),
    net = service(path)
  await net.request('net.init', { name, listen: true, port: 0 })
  await net.request('net.protect', { passphrase: 'test authority protection' })
  return { path, net }
}
async function invitation(net: NetService): Promise<{ invite: string; inviteId: string }> {
  return (await net.request('bridge.invite', {})) as { invite: string; inviteId: string }
}
const asides = (path: string) => readdirSync(path).filter((entry) => entry.startsWith('net.'))
const rejection = (promise: Promise<unknown>) =>
  promise.then(
    () => {
      throw new Error('expected a rejection')
    },
    (error: NetError) => error
  )
/** The joiner never sees the other computer's answer once, though the other computer committed it. */
function loseNextAnswer(net: NetService): void {
  const enrollment = net.runtime().enrollment,
    accept = enrollment.acceptNodeJoin.bind(enrollment)
  let lost = false
  enrollment.acceptNodeJoin = (...args) => {
    if (lost) return accept(...args)
    lost = true
    throw new NetError('peer_offline')
  }
}

it('a join that never sent its request leaves nothing: Networking on and a new join work, also after a restart', async () => {
  const a = await authority()
  const dead = await invitation(a.net)
  // The listener named in the link stops, so the dial is refused and no request leaves the joiner.
  await a.net.request('net.transport.configure', { id: 'direct', enabled: false })
  const path = directory(),
    net = service(path)
  const error = await rejection(net.request('bridge.join', { invite: dead.invite, name: 'Laptop' }))
  expect(error).toMatchObject({ code: 'route_unreachable', details: { reason: 'unreachable', label: 'Studio Mac' } })
  expect(net.status().unfinishedJoin).toBeUndefined()
  expect(existsSync(join(path, 'net', 'keys.json'))).toBe(false)
  expect(asides(path)).toHaveLength(1)
  await net.shutdown()

  const restarted = service(path)
  await restarted.start()
  expect(restarted.status().unfinishedJoin).toBeUndefined()
  // A fresh link from the same computer joins.
  await a.net.request('net.transport.configure', { id: 'direct', enabled: true, settings: { host: '127.0.0.1', port: 0 } })
  const good = await invitation(a.net)
  const joined = (await restarted.request('bridge.join', { invite: good.invite, name: 'Laptop' })) as { connected: boolean }
  expect(joined.connected).toBe(true)
  expect(restarted.status().self?.isAuthority).toBe(false)
}, 30_000)

it('Networking on after a restart drops keys and a journal that no request ever left', async () => {
  const a = await authority()
  await a.net.request('net.transport.configure', {
    id: 'direct',
    enabled: true,
    settings: { host: '127.0.0.1', advertiseHost: '192.0.2.1', port: 0 }
  })
  const dead = await invitation(a.net)
  const path = directory(),
    first = service(path)
  const pending = first.request('bridge.join', { invite: dead.invite, name: 'Laptop' }) as Promise<unknown>
  pending.catch(() => {})
  // The journal exists and the dial is under way when this computer stops.
  await vi.waitFor(() => expect(first.runtime().enrollment.joinAttempt()?.phase).toBe('unsent'))
  await first.shutdown()
  expect(existsSync(join(path, 'net', 'keys.json'))).toBe(true)

  const restarted = service(path)
  await restarted.start()
  expect(restarted.status().unfinishedJoin).toBeUndefined()
  const status = (await restarted.request('net.init', { name: 'Laptop' })) as NetStatus
  expect(status.self?.isAuthority).toBe(true)
  expect(asides(path).some((entry) => entry.startsWith('net.unfinished-join-'))).toBe(true)
}, 30_000)

it('a join whose answer was lost is kept, refuses other starts, and Retry collects the same result after a restart and after the link expired', async () => {
  const a = await authority()
  const link = await invitation(a.net)
  const path = directory(),
    first = service(path)
  loseNextAnswer(first)
  const lost = await rejection(first.request('bridge.join', { invite: link.invite, name: 'Laptop' }))
  expect(lost.code).toBe('outcome_uncertain')
  expect(lost.details).toEqual({ reason: 'join_unfinished', label: 'Studio Mac' })
  // The other computer admitted it; this computer still holds the keys and claims it sent.
  const admitted = a.net.runtime().enrollment.consumedInvite(link.inviteId as never)
  expect(admitted?.name).toBe('Laptop')
  expect(first.status().unfinishedJoin).toMatchObject({ name: 'Studio Mac' })
  // Neither Networking on nor another link replaces it.
  const init = await rejection(first.request('net.init', { name: 'Laptop' }))
  expect(init).toMatchObject({ code: 'conflict', details: { reason: 'join_unfinished', label: 'Studio Mac' } })
  const other = await invitation(a.net)
  const replaced = await rejection(first.request('bridge.join', { invite: other.invite, name: 'Laptop' }))
  expect(replaced).toMatchObject({ code: 'conflict', details: { reason: 'join_unfinished' } })
  await first.shutdown()

  const restarted = service(path)
  await restarted.start()
  expect(restarted.status().unfinishedJoin).toMatchObject({ name: 'Studio Mac' })
  // The link has expired on both computers; the consumed result is still collected.
  shift.ms = 11 * 60_000
  const joined = (await restarted.request('net.join.retry', {})) as { node: NodeId; connected: boolean }
  expect(joined.node).toBe(admitted!.node)
  expect(joined.connected).toBe(true)
  expect(restarted.status()).toMatchObject({ self: { node: admitted!.node }, enabled: true })
  expect(restarted.status().unfinishedJoin).toBeUndefined()
}, 30_000)

it('the other computer refusing a sent join ends it, with the reason and its name', async () => {
  const a = await authority()
  const link = await invitation(a.net)
  // The first request reaches the other computer, which fails before it admits anything.
  const enrollment = a.net.runtime().enrollment,
    redeem = enrollment.redeemNode.bind(enrollment)
  let failOnce = true
  enrollment.redeemNode = (...args) => {
    if (!failOnce) return redeem(...args)
    failOnce = false
    throw new NetError('internal')
  }
  const path = directory(),
    b = service(path)
  // A failure on the other computer's side leaves the outcome unknown here, like a lost answer.
  const failed = await rejection(b.request('bridge.join', { invite: link.invite, name: 'Laptop' }))
  expect(failed).toMatchObject({ code: 'outcome_uncertain', details: { reason: 'join_unfinished', label: 'Studio Mac' } })
  expect(b.status().unfinishedJoin).toMatchObject({ name: 'Studio Mac' })
  // The owner cancels the link there; the retry gets a definite refusal.
  enrollment.revokeInvite(link.inviteId as never)
  const refused = await rejection(b.request('net.join.retry', {}))
  expect(refused).toMatchObject({ code: 'invite_invalid', details: { reason: 'cancelled', label: 'Studio Mac' } })
  expect(b.status().unfinishedJoin).toBeUndefined()
  expect(((await b.request('net.init', { name: 'Laptop' })) as NetStatus).self?.isAuthority).toBe(true)
}, 30_000)

it('Give up sets a sent join aside and this computer can start its own devices', async () => {
  const a = await authority()
  const link = await invitation(a.net)
  const path = directory(),
    b = service(path)
  loseNextAnswer(b)
  await rejection(b.request('bridge.join', { invite: link.invite, name: 'Laptop' }))
  expect(b.status().unfinishedJoin).toBeDefined()
  const status = (await b.request('net.join.abandon', {})) as NetStatus
  expect(status.unfinishedJoin).toBeUndefined()
  expect(asides(path).some((entry) => entry.startsWith('net.unfinished-join-'))).toBe(true)
  expect(((await b.request('net.init', { name: 'Laptop' })) as NetStatus).self?.isAuthority).toBe(true)
}, 30_000)

it('the wait for the first session after joining does not hold the queue', async () => {
  const a = await authority()
  const link = await invitation(a.net)
  // The other computer admits the join and then stops answering.
  const enrollment = a.net.runtime().enrollment,
    redeem = enrollment.redeemNode.bind(enrollment)
  enrollment.redeemNode = (...args) => {
    const result = redeem(...args)
    setTimeout(() => void a.net.shutdown(), 0)
    return result
  }
  const b = service(directory())
  const joining = b.request('bridge.join', { invite: link.invite, name: 'Laptop' }) as Promise<{
    connected: boolean
  }>
  await vi.waitFor(() => expect(b.status()).toMatchObject({ enabled: true, self: {} }), { timeout: 10_000 })
  // Another queued request is answered while the join still waits for a session.
  // (The join's own wait lasts 20 seconds; a queue held by it would answer after that.)
  const answered = await Promise.race([
    b.request('bridge.workOnThreads', {}),
    new Promise((resolve) => setTimeout(() => resolve('still queued'), 5000))
  ])
  expect(answered).toEqual({ enabled: true })
  await b.shutdown()
  await expect(joining).resolves.toMatchObject({ connected: false })
}, 30_000)
