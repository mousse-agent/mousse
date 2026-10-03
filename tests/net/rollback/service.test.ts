import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { NetService } from '../../../src/mms/net/NetService'
import { newId } from '../../../src/shared/net'
import { DEFAULT_NET_FEATURE_FLAGS } from '../../../src/shared/featureFlags'
const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
function service() {
  const path = realpathSync(mkdtempSync(join(tmpdir(), 'net-rollback-'))),
    net = new NetService({ profileDir: path })
  cleanup.push(
    () => rmSync(path, { recursive: true, force: true }),
    () => net.shutdown()
  )
  return { path, net }
}
async function linked() {
  const a = service(),
    b = service()
  await a.net.request('net.init', { listen: true })
  await a.net.request('net.protect', { passphrase: 'owned-rollback-profile' })
  const { invite } = (await a.net.request('bridge.invite', {})) as { invite: string }
  await b.net.request('bridge.join', { invite })
  const self = a.net.runtime().identity.self()!
  await vi.waitFor(() => expect(b.net.session(self.node).state()).toBe('open'))
  return { a, b, self }
}
it('defaults off, persists rollback, keeps identity/data and requires restart before explicit re-enable', async () => {
  const { a, b, self } = await linked(),
    rt = a.net.runtime(),
    roster = rt.identity.roster()
  expect(DEFAULT_NET_FEATURE_FLAGS).toEqual({ netBridge: false, netSpaces: false })
  expect(a.net.status().features).toEqual({ netBridge: true, netSpaces: true })
  const disabled = a.net.request('net.disable', {})
  expect(a.net.status()).toMatchObject({
    enabled: false,
    restartRequired: true,
    features: DEFAULT_NET_FEATURE_FLAGS,
    self
  })
  expect(() => a.net.request('bridge.invite', {})).toThrow(expect.objectContaining({ code: 'disabled' }))
  expect(() => a.net.request('net.init', {})).toThrow(expect.objectContaining({ code: 'disabled' }))
  await expect(
    a.net.connectChannel(
      { node: self.node, user: self.user, transportKey: rt.keys.nodeKeys().transport, routes: [] },
      new AbortController().signal
    )
  ).rejects.toMatchObject({ code: 'disabled' })
  // The rejected asynchronous dial never creates a carrier.
  await expect(
    a.net.connectDomainSession(
      { node: self.node, user: self.user, transportKey: rt.keys.nodeKeys().transport, routes: [] },
      new AbortController().signal
    )
  ).rejects.toMatchObject({ code: 'disabled' })
  expect(await disabled).toMatchObject({ enabled: false, restartRequired: true, routes: [], peers: [] })
  expect(() => a.net.request('net.doctor', {})).toThrow(expect.objectContaining({ code: 'disabled' }))
  expect(rt.identity.roster()).toEqual(roster)
  await vi.waitFor(() => expect(b.net.status().peers.every((peer) => peer.state !== 'open')).toBe(true))
  await a.net.shutdown()
  const restarted = new NetService({ profileDir: a.path })
  cleanup.push(() => restarted.shutdown())
  await restarted.start()
  expect(restarted.status()).toMatchObject({
    enabled: false,
    features: DEFAULT_NET_FEATURE_FLAGS,
    routes: [],
    self: { node: self.node, user: self.user }
  })
  expect(() => restarted.request('net.unlock', { passphrase: 'owned-rollback-profile' })).toThrow(
    expect.objectContaining({ code: 'disabled' })
  )
  expect(restarted.status().routes).toEqual([])
  expect(() => restarted.request('bridge.invite', {})).toThrow(expect.objectContaining({ code: 'disabled' }))
  await restarted.request('net.init', { passphrase: 'owned-rollback-profile' })
  expect(restarted.status()).toMatchObject({ enabled: true, features: { netBridge: true, netSpaces: true }, self })
  expect(restarted.runtime().identity.roster()).toEqual(roster)
})
it('retains actual late RPC ownership and open SQL after bounded uncertain drain', async () => {
  const { a, b, self } = await linked(),
    rt = a.net.runtime()
  let release!: () => void, entered!: () => void
  const hold = new Promise<void>((resolve) => {
      release = resolve
    }),
    admitted = new Promise<void>((resolve) => {
      entered = resolve
    })
  let sawAbort = false
  rt.db.database.exec('CREATE TABLE rollback_late_effect(value TEXT NOT NULL)')
  rt.rpc.register({
    method: 'fixture.rollback.delayed',
    capability: 'read',
    mutating: false,
    handle: async (_params, context) => {
      context.signal.addEventListener(
        'abort',
        () => {
          sawAbort = true
        },
        { once: true }
      )
      entered()
      await hold
      rt.db.transaction(() => {
        rt.db.charge(1)
        rt.db.database.prepare('INSERT INTO rollback_late_effect VALUES(?)').run('settled after deadline')
      })
      return { settled: true }
    }
  })
  const rpc = b.net
    .session(self.node)
    .rpc('fixture.rollback.delayed', {}, { id: newId('rpc'), deadlineMs: 20000 })
    .catch((error) => error)
  await admitted
  try {
    await expect(a.net.request('net.disable', {})).rejects.toMatchObject({ code: 'outcome_uncertain' })
    expect(sawAbort).toBe(true)
    expect(a.net.getActiveCount()).toBeGreaterThan(0)
    expect(a.net.status()).toMatchObject({ enabled: false, restartRequired: true, error: 'outcome_uncertain', self })
    expect(rt.db.database.prepare('SELECT count(*) AS n FROM rollback_late_effect').get()!.n).toBe(0)
    expect(
      JSON.parse(rt.db.database.prepare('SELECT value FROM net_service_config').get()!.value as string)
    ).toMatchObject({ enabled: false, features: DEFAULT_NET_FEATURE_FLAGS })
  } finally {
    release()
    await rpc
  }
  await vi.waitFor(() =>
    expect(rt.db.database.prepare('SELECT count(*) AS n FROM rollback_late_effect').get()!.n).toBe(1)
  )
  await vi.waitFor(() => expect(a.net.getActiveCount()).toBe(0))
  expect(rt.db.database.prepare('SELECT value FROM rollback_late_effect').get()!.value).toBe('settled after deadline')
}, 15000)
it('does not silently grandfather previously enabled profiles lacking explicit rollout flags', async () => {
  const { path, net } = service()
  await net.request('net.init', { listen: true })
  const rt = net.runtime(),
    prior = JSON.parse(rt.db.database.prepare('SELECT value FROM net_service_config').get()!.value as string)
  delete prior.features
  rt.db.database.prepare('UPDATE net_service_config SET value=?').run(JSON.stringify(prior))
  await net.shutdown()
  const restarted = new NetService({ profileDir: path })
  cleanup.push(() => restarted.shutdown())
  await restarted.start()
  expect(restarted.status()).toMatchObject({ enabled: false, features: DEFAULT_NET_FEATURE_FLAGS, routes: [] })
  await restarted.request('net.init', {})
  expect(restarted.status()).toMatchObject({ enabled: true, features: { netBridge: true, netSpaces: true } })
})
