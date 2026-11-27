/**
 * The pairing flow over a 1.2 helper: Connect with "Also let" unticked pairs one way, the level picked in Allow is
 * saved before the device is let in, each new operation is sent only when the helper lists its feature, and Remove
 * on one of a pairing's two rows ends only that direction.
 */
import { afterAll, describe, expect, it, vi } from 'vitest'
import { fingerprintOf } from '../../src/mms/netEngine/pairing'
import { EngineClient } from '../../src/mms/netEngine/session/client'
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

/** The access `on` saved for `node`, if it saved one. */
function policyOf(on: Computer, node: NodeId): Record<string, unknown> | undefined {
  return (
    on.mms.netEngine as unknown as { started: { rt: { policy: { list(): Array<Record<string, unknown>> } } } }
  ).started.rt.policy
    .list()
    .find((policy) => policy.node === node)
}

/** `caller` opens `owner`'s Send link and types the code `owner` shows; `back` is Connect's "Also let". */
async function joinLink(
  owner: Computer,
  caller: Computer,
  link: { invitation: string; uri: string },
  back: boolean
): Promise<{ node: NodeId }> {
  const joined = caller.dispatch('netEngine.join', { ticket: link.uri, arrival: 'link', back }, true)
  await eventually(() =>
    expect(caller.mms.netEngine.status().joins?.find((join) => join.invitation === link.invitation)?.needsCode).toBe(
      true
    )
  )
  const code = owner.mms.netEngine.status().links?.find((one) => one.invitation === link.invitation)?.code
  await caller.dispatch('netEngine.join.code', { invitation: link.invitation, code }, true)
  return joined
}

/** Stops `on` once at `step`, as a crash would; answers whether it stopped there. */
function crashOnce(on: Computer, step: string): () => boolean {
  let hit = false
  on.mms.netEngine.pairingCrash = (at) => at === step && !hit && (hit = true)
  return () => hit
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

    // On the owner, the caller stops using it: the caller's grant goes; the owner still uses the caller.
    await owner.dispatch('netEngine.remove', { node: callerOnOwner, direction: 'in' }, true)
    expect(fabric.network.holds(owner.endpoint, caller.endpoint)).toBe(false)
    expect(sent(owner, 'grant.revoke_local')).toHaveLength(1)
    expect(sent(owner, 'grant.remove')).toEqual([])
    expect(rowFor(owner, caller)).toMatchObject({ state: 'connected', grant: '', ways: 'out' })
    expect(device(owner, callerOnOwner)?.direction).toBe('out')
    await fabric.connect(owner, callerOnOwner)
    expect(await accessThere(owner, callerOnOwner)).toMatchObject({ blocked: false })

    // On the caller, it stops using the owner: its peer record goes; the owner still uses it.
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

  it('keeps a Send link joined one way one way when the joiner restarts mid-join', async () => {
    const owner = await computer(fabric, 'link-stop-owner'),
      caller = await computer(fabric, 'link-stop-caller')
    const link = await owner.dispatch('netEngine.invite', { kind: 'link' }, true)
    // The join answered PAIRED and the app stopped before writing it: the restart reads the saved link back.
    const stopped = crashOnce(caller, 'join-replied')
    await joinLink(owner, caller, link, false).catch(() => undefined)
    expect(stopped()).toBe(true)
    caller.mms.netEngine.pairingCrash = undefined
    await fabric.restartEngine(caller)
    await eventually(() => expect(rowFor(caller, owner)).toMatchObject({ state: 'connected', grant: '', ways: 'out' }))
    expect(fabric.network.holds(caller.endpoint, owner.endpoint)).toBe(false)
    expect(sent(caller, 'grant.add')).toEqual([])
  }, 60_000)

  it('sends no grant and no pairback when joining one way a computer this one lets in already', async () => {
    const owner = await computer(fabric, 'let-in-owner'),
      caller = await computer(fabric, 'let-in-caller')
    // The owner joined the caller first, one way: the caller lets the owner in.
    await joinOneWay(caller, owner)
    await eventually(() => expect(rowFor(caller, owner)).toMatchObject({ state: 'connected', ways: 'in' }))
    const pairbacks = vi.spyOn(EngineClient.prototype, 'pairback')
    try {
      await joinOneWay(owner, caller)
      // Both ways now: the access it had stays, and Connect added only this computer using it.
      await eventually(() => {
        const row = rowFor(caller, owner)
        expect(row).toMatchObject({ state: 'connected' })
        expect(row?.ways).toBeUndefined()
        expect(row?.oneWay).toBeUndefined()
      })
      expect(sent(caller, 'grant.add')).toEqual([])
      expect(pairbacks).not.toHaveBeenCalled()
    } finally {
      pairbacks.mockRestore()
    }
  }, 60_000)

  it('keeps the level picked at Allow when writing the row fails, for the next start to use', async () => {
    const owner = await computer(fabric, 'insert-owner'),
      caller = await computer(fabric, 'insert-caller')
    const view = accessPreset('view').fields
    const peers = (owner.mms.netEngine as unknown as { started: { peers: { add: (...args: any[]) => unknown } } })
      .started.peers
    const add = peers.add.bind(peers)
    let failed = false
    peers.add = (row: { ways?: string }, ...rest: unknown[]) => {
      if (!failed && row.ways === 'in') {
        failed = true
        throw new Error('disk full')
      }
      return add(row, ...rest)
    }
    const { node: ownerOnCaller } = await joinOneWay(owner, caller, (request) =>
      owner.dispatch('netEngine.approve', { request, yes: true, access: view }, true)
    )
    await eventually(() => expect(failed).toBe(true))
    expect(rowFor(owner, caller)).toBeUndefined()
    await fabric.restartEngine(owner)
    const onOwner = await eventually(() => {
      const row = rowFor(owner, caller)
      expect(row?.state).toBe('connected')
      return row!
    })
    expect(policyOf(owner, onOwner.localId)).toMatchObject(view)
    await fabric.connect(caller, ownerOnCaller)
    expect(await accessThere(caller, ownerOnCaller)).toMatchObject({ work: false })
  }, 60_000)

  it('keeps the level picked at Allow while the owed row cannot be written yet', async () => {
    const owner = await computer(fabric, 'owed-owner'),
      caller = await computer(fabric, 'owed-caller')
    const view = accessPreset('view').fields
    // The app stops after the helper let the caller in, before its row is written.
    const stopped = crashOnce(owner, 'enrolled')
    const { node: ownerOnCaller } = await joinOneWay(owner, caller, (request) =>
      owner.dispatch('netEngine.approve', { request, yes: true, access: view }, true)
    )
    await eventually(() => expect(stopped()).toBe(true))
    owner.mms.netEngine.pairingCrash = undefined
    // At the next start the helper can't list its grants: the owed row waits.
    const failing = { 'grants.list': 1_000 }
    fabric.network.failing.set(owner.endpoint, failing)
    await fabric.restartEngine(owner)
    await eventually(() => expect(sent(owner, 'grants.list').length).toBeGreaterThanOrEqual(1))
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(rowFor(owner, caller)).toBeUndefined()
    // The helper starts again and lists them: the row is written under the level picked.
    failing['grants.list'] = 0
    await fabric.restartHelper(owner)
    const onOwner = await eventually(() => {
      const row = rowFor(owner, caller)
      expect(row?.state).toBe('connected')
      return row!
    })
    expect(policyOf(owner, onOwner.localId)).toMatchObject(view)
    await fabric.connect(caller, ownerOnCaller)
    expect(await accessThere(caller, ownerOnCaller)).toMatchObject({ work: false })
  }, 60_000)

  it('finishes removing one direction after the app stops between the row and the helper', async () => {
    const owner = await computer(fabric, 'revoke-owner'),
      caller = await computer(fabric, 'revoke-caller')
    const { callerOnOwner } = await fabric.pair(owner, caller)
    const stopped = crashOnce(owner, 'revoking')
    await expect(owner.dispatch('netEngine.remove', { node: callerOnOwner, direction: 'in' }, true)).rejects.toBeDefined()
    expect(stopped()).toBe(true)
    // The helper still holds the grant.
    expect(fabric.network.holds(owner.endpoint, caller.endpoint)).toBe(true)
    owner.mms.netEngine.pairingCrash = undefined
    await fabric.restartEngine(owner)
    await eventually(() => expect(fabric.network.holds(owner.endpoint, caller.endpoint)).toBe(false))
    const row = rowFor(owner, caller)
    expect(row).toMatchObject({ state: 'connected', grant: '', ways: 'out' })
    expect(row?.revoking).toBeUndefined()
  }, 60_000)

  it('keeps using a computer it added over SSH when that computer joins its Send link one way', async () => {
    const owner = await computer(fabric, 'ssh-used-owner'),
      caller = await computer(fabric, 'ssh-used-caller')
    // The owner added the caller over SSH: it uses the caller through that route.
    owner.mms.netEngine.pair({
      endpoint: caller.endpoint,
      fingerprint: fingerprintOf(caller.endpoint),
      grant: '',
      name: caller.name,
      state: 'connected',
      source: 'ssh',
      ssh: { requestId: 'ab'.repeat(16), routeId: 'route-ssh-used' }
    })
    const link = await owner.dispatch('netEngine.invite', { kind: 'link' }, true)
    await joinLink(owner, caller, link, false)
    const onOwner = await eventually(() => {
      const row = rowFor(owner, caller)
      expect(row?.grant).not.toBe('')
      return row!
    })
    // Both ways: it uses this computer now, and this computer still uses it.
    expect(onOwner.ways).toBeUndefined()
    expect(device(owner, onOwner.localId)?.direction).toBeUndefined()
    await fabric.restartEngine(owner)
    await eventually(() =>
      expect(sent(owner, 'dial').some((message) => message.identity === caller.endpoint)).toBe(true)
    )
  }, 60_000)

  it('answers an older Mousse’s pairback without using it from here', async () => {
    const owner = await computer(fabric, 'older-owner'),
      caller = await computer(fabric, 'older-caller')
    // An app from before one-way pairing: its hello says no features, and it always pairs back.
    const hello = vi.spyOn(EngineClient.prototype, 'hello').mockImplementation(async function (
      this: EngineClient,
      name: string
    ) {
      const reply = await (this as unknown as { exchange: (...args: unknown[]) => Promise<{ header: { name?: unknown } }> }).exchange(
        'mousse.hello',
        { t: 'hello', proto: 1, name },
        [],
        { deadlineMs: 10_000, until: 'hello', keepOpen: true }
      )
      return { name: String(reply.header.name ?? ''), features: [] }
    })
    try {
      const invite = await owner.dispatch('netEngine.invite', {}, true)
      const stop = approveAll(owner)
      try {
        await caller.dispatch('netEngine.join', { ticket: invite.uri, back: true }, true)
      } finally {
        stop()
      }
      // Its pairback was answered: its ceremony ends.
      await eventually(() => expect(rowFor(caller, owner)?.state).toBe('connected'))
      const onOwner = rowFor(owner, caller)!
      expect(onOwner).toMatchObject({ state: 'connected', ways: 'in' })
      expect(sent(owner, 'peer.add')).toEqual([])
      expect(sent(owner, 'dial').filter((message) => message.identity === caller.endpoint)).toEqual([])
      expect(device(owner, onOwner.localId)).toMatchObject({ direction: 'in', olderApp: true })
    } finally {
      hello.mockRestore()
    }
  }, 60_000)

  it('serves a device that joined a Send link under the level picked with the link, also after a stop', async () => {
    const view = accessPreset('view').fields
    // As it is: served under the level from its first call.
    const owner = await computer(fabric, 'link-level-owner'),
      caller = await computer(fabric, 'link-level-caller')
    let link = await owner.dispatch('netEngine.invite', { kind: 'link', access: view }, true)
    let joined = await joinLink(owner, caller, link, false)
    await fabric.connect(caller, joined.node)
    expect(await accessThere(caller, joined.node)).toMatchObject({ work: false })

    // The app stops after the helper let the device in, before its row is written.
    const owner2 = await computer(fabric, 'link-level-owner2'),
      caller2 = await computer(fabric, 'link-level-caller2')
    link = await owner2.dispatch('netEngine.invite', { kind: 'link', access: view }, true)
    const stopped = crashOnce(owner2, 'enrolled')
    joined = await joinLink(owner2, caller2, link, false)
    await eventually(() => expect(stopped()).toBe(true))
    owner2.mms.netEngine.pairingCrash = undefined
    await fabric.restartEngine(owner2)
    const onOwner = await eventually(() => {
      const row = rowFor(owner2, caller2)
      expect(row?.state).toBe('connected')
      return row!
    })
    expect(policyOf(owner2, onOwner.localId)).toMatchObject(view)
    await fabric.connect(caller2, joined.node)
    expect(await accessThere(caller2, joined.node)).toMatchObject({ work: false })
  }, 60_000)
})

describe('a 1.2 operation is sent only when the helper lists its feature', () => {
  const fabric = new Fabric()
  fabric.network.minor = 2
  // Roles only, so its devices can be let in below Full control.
  fabric.network.features = ['grant-roles']
  afterAll(() => fabric.close(), 60_000)

  it('refuses the way picker, the link check and removing one direction, and sends the helper nothing new', async () => {
    const owner = await computer(fabric, 'old-owner'),
      caller = await computer(fabric, 'old-caller')
    expect(owner.mms.netEngine.status().features).toEqual(['grant-roles'])
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
