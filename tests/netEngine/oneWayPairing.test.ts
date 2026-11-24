/**
 * The pairing flow over a 1.2 helper: Connect with "Also let" unticked pairs one way, the level picked in Allow is
 * saved before the device is let in, each new operation is sent only when the helper lists its feature, and Remove
 * on one of a pairing's two rows ends only that direction.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { newId, type NodeId } from '../../src/shared/net'
import { accessPreset } from '../../src/shared/net/accessPresets'
import { Fabric, approveAll, connectedBothWays, eventually, rowFor, type Computer } from './checks/harness'

const ALL_FEATURES = ['invite-way', 'route-readiness', 'join-probe', 'grant-revoke-local', 'grant-roles', 'grant-add-connected']

let made = 0

/** A computer with a LAN address of its own, as a 1.1 or later helper needs to be dialled. */
function computer(fabric: Fabric, name: string): Promise<Computer> {
  const identity = Buffer.from(`endpoint-${name}`).toString('hex')
  fabric.network.routes.set(identity, [`tcp://192.168.62.${++made}:47100`])
  fabric.network.ports.set(identity, 47100)
  return fabric.computer(name)
}

function device(on: Computer, node: NodeId) {
  return on.mms.netEngine.status().devices.find((row) => row.node === node)
}

/** What `caller` may do on the computer it knows as `node`, as that computer answers it. */
function accessThere(caller: Computer, node: NodeId) {
  return caller.mms.netEngine.client(node).rpc('bridge.access.mine', {}, { id: newId('rpc'), deadlineMs: 10_000 }) as Promise<
    Record<string, unknown>
  >
}

/** The helper requests an app sent, by operation. */
function sent(computer: Computer, op: string): Array<Record<string, unknown>> {
  return (computer.fake?.requests ?? []).filter((message) => message.op === op)
}

async function joinOneWay(owner: Computer, caller: Computer, approve?: (request: string) => Promise<void>) {
  const invite = await owner.dispatch('netEngine.invite', {}, true)
  let stop = (): void => undefined
  if (approve) {
    const answered = new Set<string>()
    const timer = setInterval(() => {
      for (const { request } of owner.mms.netEngine.status().approvals)
        if (!answered.has(request)) {
          answered.add(request)
          void approve(request).catch(() => undefined)
        }
    }, 10)
    stop = () => clearInterval(timer)
  } else stop = approveAll(owner)
  try {
    return (await caller.dispatch('netEngine.join', { ticket: invite.uri, back: false }, true)) as { node: NodeId }
  } finally {
    stop()
  }
}

describe('pairing one way', () => {
  const fabric = new Fabric()
  fabric.network.minor = 2
  fabric.network.features = [...ALL_FEATURES]
  afterAll(() => fabric.close(), 60_000)

  it('finishes with no grant back and no pairback: the joiner uses the host, the host cannot use the joiner', async () => {
    const owner = await computer(fabric, 'one-way-owner'),
      caller = await computer(fabric, 'one-way-caller')
    const { node: ownerOnCaller } = await joinOneWay(owner, caller)
    await eventually(() => {
      expect(device(caller, ownerOnCaller)).toMatchObject({ state: 'connected', direction: 'out' })
      const onOwner = rowFor(owner, caller)!
      expect(device(owner, onOwner.localId)).toMatchObject({ state: 'connected', direction: 'in' })
    })
    // The host let the joiner in; the joiner let nothing back.
    expect(fabric.network.holds(owner.endpoint, caller.endpoint)).toBe(true)
    expect(fabric.network.holds(caller.endpoint, owner.endpoint)).toBe(false)
    expect(sent(caller, 'grant.add')).toEqual([])
    expect(sent(owner, 'peer.add')).toEqual([])
    expect(rowFor(caller, owner)).toMatchObject({ grant: '', ways: 'out', state: 'connected' })
    // The joiner works on the host.
    expect(await accessThere(caller, ownerOnCaller)).toMatchObject({ blocked: false })
    // The host has no client of the joiner, and nothing dials it.
    const onOwner = rowFor(owner, caller)!
    await owner.dispatch('netEngine.retry', { node: onOwner.localId }, true)
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(owner.mms.netEngine.online(onOwner.localId)).toBe(false)
    expect(sent(owner, 'dial').filter((message) => message.identity === caller.endpoint)).toEqual([])
  }, 60_000)

  it('saves the level picked in Allow before the grant, under the id the row takes', async () => {
    const owner = await computer(fabric, 'level-owner'),
      caller = await computer(fabric, 'level-caller')
    const view = accessPreset('view').fields
    const policies = () =>
      (
        owner.mms.netEngine as unknown as { started: { rt: { policy: { list(): Array<Record<string, unknown>> } } } }
      ).started.rt.policy.list()
    // What the policy table held when the helper was told Yes.
    let atAnswer: Array<Record<string, unknown>> | undefined
    const request = owner.engine.request.bind(owner.engine)
    owner.engine.request = ((op: string, ...rest: unknown[]) => {
      if (op === 'approval.answer') atAnswer = policies()
      return (request as (...args: unknown[]) => Promise<Record<string, unknown>>)(op, ...rest)
    }) as typeof owner.engine.request
    const { node: ownerOnCaller } = await joinOneWay(owner, caller, (answer) =>
      owner.dispatch('netEngine.approve', { request: answer, yes: true, access: view }, true)
    )
    const onOwner = await eventually(() => {
      const row = rowFor(owner, caller)
      expect(row?.state).toBe('connected')
      return row!
    })
    const saved = atAnswer?.find((policy) => policy.node === onOwner.localId)
    expect(saved).toMatchObject(view)
    // The joiner is served under that level from its first call.
    await eventually(() => expect(caller.mms.netEngine.online(ownerOnCaller)).toBe(true))
    expect(await accessThere(caller, ownerOnCaller)).toMatchObject({ work: false })
  }, 60_000)

  it('pairs both ways when "Also let" is ticked, as before', async () => {
    const owner = await computer(fabric, 'ticked-owner'),
      caller = await computer(fabric, 'ticked-caller')
    const invite = await owner.dispatch('netEngine.invite', {}, true)
    const stop = approveAll(owner)
    try {
      await caller.dispatch('netEngine.join', { ticket: invite.uri, back: true }, true)
    } finally {
      stop()
    }
    await connectedBothWays(owner, caller)
    expect(fabric.network.holds(caller.endpoint, owner.endpoint)).toBe(true)
    expect(rowFor(owner, caller)?.ways).toBeUndefined()
    expect(rowFor(caller, owner)?.ways).toBeUndefined()
  }, 60_000)

  it('removes one direction of a two-way pairing and keeps the other', async () => {
    const owner = await computer(fabric, 'split-owner'),
      caller = await computer(fabric, 'split-caller')
    const { callerOnOwner, ownerOnCaller } = await fabric.pair(owner, caller)

    // On the owner, "Can use this computer": the caller's grant goes; the owner still uses the caller.
    await owner.dispatch('netEngine.remove', { node: callerOnOwner, direction: 'in' }, true)
    expect(fabric.network.holds(owner.endpoint, caller.endpoint)).toBe(false)
    expect(sent(owner, 'grant.revoke_local')).toHaveLength(1)
    expect(sent(owner, 'grant.remove')).toEqual([])
    expect(rowFor(owner, caller)).toMatchObject({ state: 'connected', grant: '', ways: 'out' })
    expect(device(owner, callerOnOwner)?.direction).toBe('out')
    await fabric.connect(owner, callerOnOwner)
    expect(await accessThere(owner, callerOnOwner)).toMatchObject({ blocked: false })

    // On the caller, "Computers I use from here": its peer record goes; the owner still uses it.
    await caller.dispatch('netEngine.remove', { node: ownerOnCaller, direction: 'out' }, true)
    expect(fabric.network.peersOf(caller.endpoint)).not.toContain(owner.endpoint)
    expect(fabric.network.holds(caller.endpoint, owner.endpoint)).toBe(true)
    expect(rowFor(caller, owner)).toMatchObject({ state: 'connected', ways: 'in' })
    expect(device(caller, ownerOnCaller)?.direction).toBe('in')
  }, 60_000)

  it('removes a one-way pairing whole', async () => {
    const owner = await computer(fabric, 'whole-owner'),
      caller = await computer(fabric, 'whole-caller')
    const { node: ownerOnCaller } = await joinOneWay(owner, caller)
    await eventually(() => expect(device(caller, ownerOnCaller)?.state).toBe('connected'))
    await caller.dispatch('netEngine.remove', { node: ownerOnCaller, direction: 'out' }, true)
    expect(rowFor(caller, owner)).toBeUndefined()
  }, 60_000)
})

describe('a 1.2 operation is sent only when the helper lists its feature', () => {
  const fabric = new Fabric()
  fabric.network.minor = 2
  fabric.network.features = []
  afterAll(() => fabric.close(), 60_000)

  it('refuses the way picker, the link check and removing one direction, and sends the helper nothing new', async () => {
    const owner = await computer(fabric, 'old-owner'),
      caller = await computer(fabric, 'old-caller')
    expect(owner.mms.netEngine.status().features).toBeUndefined()
    await expect(owner.dispatch('netEngine.routes.available', {}, true)).rejects.toMatchObject({
      details: { reason: 'not_supported' }
    })
    await expect(owner.dispatch('netEngine.invite', { way: 'lan' }, true)).rejects.toMatchObject({
      details: { reason: 'not_supported' }
    })
    const invite = await owner.dispatch('netEngine.invite', {}, true)
    await expect(caller.dispatch('netEngine.join.check', { ticket: invite.uri }, true)).rejects.toMatchObject({
      details: { reason: 'not_supported' }
    })
    await expect(caller.dispatch('netEngine.join.probe', { ticket: invite.uri }, true)).rejects.toMatchObject({
      details: { reason: 'not_supported' }
    })
    expect(sent(owner, 'invite.create').some((message) => 'way' in message)).toBe(false)
    for (const op of ['routes.available', 'join.check', 'join.probe'])
      expect([...sent(owner, op), ...sent(caller, op)]).toEqual([])

    const { callerOnOwner } = await fabric.pair(owner, caller)
    await expect(owner.dispatch('netEngine.remove', { node: callerOnOwner, direction: 'in' }, true)).rejects.toMatchObject({
      details: { reason: 'not_supported' }
    })
    expect(sent(owner, 'grant.revoke_local')).toEqual([])
    // Nothing changed: still both ways.
    expect(rowFor(owner, caller)?.ways).toBeUndefined()
    expect(fabric.network.holds(owner.endpoint, caller.endpoint)).toBe(true)
  }, 60_000)

  it('with the features listed, sends the way and reads the readiness and the check', async () => {
    fabric.network.features = [...ALL_FEATURES]
    const owner = await computer(fabric, 'new-owner'),
      caller = await computer(fabric, 'new-caller')
    expect(owner.mms.netEngine.status().features).toEqual(ALL_FEATURES)
    const { ways } = await owner.dispatch('netEngine.routes.available', {}, true)
    expect(ways.find((way: { way: string }) => way.way === 'lan')).toMatchObject({ state: 'ready' })
    expect(ways.find((way: { way: string }) => way.way === 'tailnet')).toMatchObject({ state: 'off', reason: 'disabled' })
    const invite = await owner.dispatch('netEngine.invite', { way: 'lan' }, true)
    expect(invite.ways).toEqual(['lan'])
    expect(sent(owner, 'invite.create').at(-1)).toMatchObject({ way: 'lan' })
    const check = await caller.dispatch('netEngine.join.check', { ticket: invite.uri }, true)
    expect(check).toMatchObject({ kind: 1 })
    const probe = await caller.dispatch('netEngine.join.probe', { ticket: invite.uri }, true)
    // Nothing was approved before Connect: the probe sends no `approved`.
    expect(sent(caller, 'join.probe').at(-1)).not.toHaveProperty('approved')
    expect(['boolean', 'object']).toContain(typeof probe.reachable)
  }, 60_000)
})
