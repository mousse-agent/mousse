import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NetService } from '../../../../src/mms/net/NetService'
import { forbiddenReason, newId, type NodeId } from '../../../../src/shared/net'
import { routedVersions } from '../../../../src/shared/bridge/routed'

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function directory(prefix: string): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  cleanups.push(() => rmSync(path, { recursive: true, force: true }))
  return path
}
function service(profileDir = directory('net-routed-')): NetService {
  const net = new NetService({ profileDir })
  cleanups.push(() => net.shutdown())
  return net
}
const inviteText = async (a: NetService, params: Record<string, unknown> = {}) =>
  ((await a.request('bridge.invite', params)) as { invite: string }).invite

/** An authority that listens, and a way to bring other devices into its set. */
async function authority() {
  const a = service()
  await a.request('net.init', { name: 'owner', listen: true, port: 0 })
  await a.request('net.protect', { passphrase: 'test-authority-protection' })
  const self = a.runtime().identity.self()!
  const join = async (invite: string, name: string) => {
    const device = service()
    const joined = (await device.request('bridge.join', { invite, name })) as { node: NodeId }
    await vi.waitFor(
      () => expect(a.status().peers).toContainEqual({ node: joined.node, state: 'open' }),
      { timeout: 10_000 }
    )
    await vi.waitFor(
      () => expect(device.status().peers).toContainEqual({ node: self.node, state: 'open' }),
      { timeout: 10_000 }
    )
    return { net: device, node: joined.node }
  }
  return { a, self, join }
}

/** A routed row of every shape the checks tell apart, each answering with its own name. */
function registerRows(a: NetService) {
  const rpc = a.runtime().rpc
  for (const [name, extra] of [
    ['read', {}],
    ['terminal', { needsTerminal: true }]
  ] as const)
    rpc.register({
      method: `routed.test.${name}`,
      family: 'routed',
      capability: 'read',
      requires: ['settings'],
      ...extra,
      mutating: false,
      ephemeral: true,
      handle: async () => ({ row: name })
    })
  let writes = 0
  rpc.register({
    method: 'routed.test.write',
    family: 'routed',
    capability: 'write',
    requires: ['settings'],
    mutating: true,
    handle: async () => ({ writes: ++writes })
  })
}

const call = (
  from: NetService,
  owner: NetService,
  method: string,
  idem?: string,
  id = newId('rpc')
) =>
  from
    .session(owner.runtime().identity.self()!.node)
    .rpc(method, {}, { id, ...(idem ? { idem } : {}), deadlineMs: 5000 })

/** The reason a refused call carries across the wire. */
async function refusedWith(promise: Promise<unknown>) {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown as { code?: string; details?: unknown }
  )
  expect(error?.code).toBe('forbidden')
  return forbiddenReason(error?.details)
}

describe('who may call a routed method', () => {
  it('is refused to a device without Works on threads, and says so', async () => {
    const { a, join } = await authority()
    registerRows(a)
    await a.request('bridge.workOnThreads', { enabled: true })
    const computer = await join(await inviteText(a), 'laptop')
    const phone = await join(await inviteText(a, { caps: ['read', 'chat', 'write'] }), 'pocket')
    expect(await call(computer.net, a, 'routed.test.read')).toEqual({ row: 'read' })
    expect(await refusedWith(call(phone.net, a, 'routed.test.read'))).toBe('capability')
    // Neither the phone's reads nor its writes get through, and no write ran.
    expect(await refusedWith(call(phone.net, a, 'routed.test.write', 'w-1'))).toBe('capability')
  }, 60_000)

  it('is allowed while the owner switch is on, which is the default, and refused once it is off', async () => {
    const { a, join } = await authority()
    registerRows(a)
    const laptop = await join(await inviteText(a), 'laptop')
    expect(a.status().workOnThreads).toBe(true)
    expect(await call(laptop.net, a, 'routed.test.read')).toBeDefined()
    // Off, then on again: the choice is kept, and nothing else changes it.
    await a.request('bridge.workOnThreads', { enabled: false })
    expect(await refusedWith(call(laptop.net, a, 'routed.test.read'))).toBe('setting_off')
    expect(await a.request('bridge.workOnThreads', { enabled: true })).toEqual({ enabled: true })
    expect(a.status().workOnThreads).toBe(true)
    const written = newId('rpc')
    expect(await call(laptop.net, a, 'routed.test.write', 'w-1', written)).toEqual({ writes: 1 })

    // Turning it off is a kill switch: the next call, and the result of an earlier one, are refused.
    await a.request('bridge.workOnThreads', { enabled: false })
    expect(await refusedWith(call(laptop.net, a, 'routed.test.read'))).toBe('setting_off')
    expect(
      await refusedWith(
        laptop.net
          .session(a.runtime().identity.self()!.node)
          .rpcResult(written, { deadlineMs: 5000 })
      )
    ).toBe('setting_off')
    expect(await a.request('bridge.workOnThreads', {})).toEqual({ enabled: false })
  }, 60_000)

  it('is refused to a blocked device, and allowed again once unblocked', async () => {
    const { a, join } = await authority()
    registerRows(a)
    await a.request('bridge.workOnThreads', { enabled: true })
    const laptop = await join(await inviteText(a), 'laptop')
    expect(await call(laptop.net, a, 'routed.test.read')).toEqual({ row: 'read' })
    await a.request('bridge.policy', { node: laptop.node, blocked: true })
    expect(await refusedWith(call(laptop.net, a, 'routed.test.read'))).toBe('blocked')
    expect(await refusedWith(call(laptop.net, a, 'routed.test.write', 'w-2'))).toBe('blocked')
    await a.request('bridge.policy', { node: laptop.node, blocked: false })
    expect(await call(laptop.net, a, 'routed.test.read')).toEqual({ row: 'read' })
  }, 60_000)

  it("needs the device's terminal switch for a terminal row, and the switch is off by default", async () => {
    const { a, join } = await authority()
    registerRows(a)
    await a.request('bridge.workOnThreads', { enabled: true })
    const laptop = await join(await inviteText(a), 'laptop')
    expect(await call(laptop.net, a, 'routed.test.read')).toEqual({ row: 'read' })
    expect(await refusedWith(call(laptop.net, a, 'routed.test.terminal'))).toBe('terminal_off')
    await a.request('bridge.policy', { node: laptop.node, terminal: true })
    expect(await call(laptop.net, a, 'routed.test.terminal')).toEqual({ row: 'terminal' })
    await a.request('bridge.policy', { node: laptop.node, terminal: false })
    expect(await refusedWith(call(laptop.net, a, 'routed.test.terminal'))).toBe('terminal_off')
  }, 60_000)

  it('keeps the setting across a restart', async () => {
    const dir = directory('net-routed-restart-')
    const first = new NetService({ profileDir: dir })
    await first.request('net.init', { name: 'owner', listen: true, port: 0 })
    await first.request('bridge.workOnThreads', { enabled: true })
    await first.shutdown()
    const second = new NetService({ profileDir: dir })
    cleanups.push(() => second.shutdown())
    second.runtime()
    expect(second.status().workOnThreads).toBe(true)
  }, 60_000)

  it('advertises the version of every routed method in net.info', async () => {
    const { a, join } = await authority()
    const laptop = await join(await inviteText(a), 'laptop')
    const info = (await call(laptop.net, a, 'net.info')) as { routed?: Record<string, number> }
    expect(info.routed).toEqual(routedVersions())
    expect(Object.keys(info.routed!)).toContain('queue.reorder')
    expect(Object.keys(info.routed!)).not.toContain('threads.purge')
  }, 60_000)

  it('runs a numbered change outside the ledger, behind the same checks, and refuses one that is not routed', async () => {
    const { a, join } = await authority()
    const applied: number[] = []
    a.runtime().rpc.register({
      method: 'routed.test.numbered',
      family: 'routed',
      capability: 'write',
      requires: ['settings'],
      needsTerminal: true,
      mutating: true,
      sequenced: true,
      handle: async (params) => {
        applied.push((params as { seq: number }).seq)
        return { ok: true }
      }
    })
    await a.request('bridge.workOnThreads', { enabled: true })
    const laptop = await join(await inviteText(a), 'laptop')
    const send = (seq: number, idem?: string) =>
      laptop.net
        .session(a.runtime().identity.self()!.node)
        .rpc(
          'routed.test.numbered',
          { seq },
          { id: newId('rpc'), ...(idem ? { idem } : {}), deadlineMs: 5000 }
        )
    // The same checks as any routed method: the device's terminal switch is off by default.
    expect(await refusedWith(send(1))).toBe('terminal_off')
    await a.request('bridge.policy', { node: laptop.node, terminal: true })
    const ledger = () =>
      Number(
        a.runtime().db.database.prepare('SELECT count(*) AS n FROM net_executions').get()!.n
      )
    const before = ledger()
    for (const seq of [1, 2, 3]) expect(await send(seq)).toEqual({ ok: true })
    expect(applied).toEqual([1, 2, 3])
    // Nothing is recorded: no execution, so a retry of a lost reply is the caller's to send again.
    expect(ledger()).toBe(before)
    // A key would suggest a ledger that is not there.
    await expect(send(4, 'a-key')).rejects.toMatchObject({ code: 'bad_request' })
    // A block, and the owner's switch going off, refuse it like any other.
    await a.request('bridge.policy', { node: laptop.node, blocked: true })
    expect(await refusedWith(send(5))).toBe('blocked')
    await a.request('bridge.policy', { node: laptop.node, blocked: false })
    await a.request('bridge.workOnThreads', { enabled: false })
    expect(await refusedWith(send(6))).toBe('setting_off')
    expect(applied).toEqual([1, 2, 3])

    // Only a routed change without uploads can be numbered instead of recorded.
    const rpc = a.runtime().rpc
    const base = { capability: 'write' as const, handle: async () => ({}) }
    for (const method of [
      { ...base, method: 'test.numbered.plain', mutating: true, sequenced: true },
      { ...base, method: 'routed.test.numbered.read', family: 'routed' as const, mutating: false, sequenced: true },
      { ...base, method: 'routed.test.numbered.ephemeral', family: 'routed' as const, mutating: true, ephemeral: true, sequenced: true },
      { ...base, method: 'routed.test.numbered.upload', family: 'routed' as const, mutating: true, uploadEnabled: true, sequenced: true }
    ])
      expect(() => rpc.register(method), method.method).toThrow(
        expect.objectContaining({ code: 'bad_request' })
      )
  }, 60_000)

  it('does not change the phone API: a bridge method needs no grant and no switch', async () => {
    const { a, join } = await authority()
    a.runtime().rpc.register({
      method: 'test.phone',
      family: 'bridge',
      capability: 'read',
      mutating: false,
      ephemeral: true,
      handle: async () => ({ ok: true })
    })
    const phone = await join(await inviteText(a, { caps: ['read', 'chat', 'write'] }), 'pocket')
    expect(await call(phone.net, a, 'test.phone')).toEqual({ ok: true })
  }, 60_000)
})
