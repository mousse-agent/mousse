/**
 * The other direction of a one-way pairing, asked for later over the connection the pairing already has (pairing
 * flow §7): the computer only let in asks, the other computer's owner answers with Allow (at a level) or Not now,
 * and only that Allow grants anything. Its owner may also let it in from its own row.
 */
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { Channel } from '../../src/mms/netEngine/session/transport'
import { newId, type NodeId } from '../../src/shared/net'
import { accessPreset } from '../../src/shared/net/accessPresets'
import { Fabric, REAL_HELPER, approveAll, eventually, rowFor, type Computer } from './checks/harness'

const limits = vi.hoisted(() => {
  const set = {
    MOUSSE_NET_ENGINE_ACCESS_ASK_MS: '2500',
    MOUSSE_NET_ENGINE_ACCESS_ASK_GAP_MS: '600',
    MOUSSE_NET_ENGINE_ACCESS_PROMPT_GAP_MS: '600',
    MOUSSE_NET_ENGINE_ACCESS_SEEN_MS: '4000',
    MOUSSE_NET_ENGINE_ACCESS_SEEN_IDS: '8'
  }
  Object.assign(process.env, set)
  return { askMs: 2500, gapMs: 600, seenMs: 4000, seenIds: 8 }
})

const ALL_FEATURES = ['invite-way', 'route-readiness', 'join-probe', 'grant-revoke-local', 'grant-roles', 'grant-add-connected']

let made = 0

function computer(fabric: Fabric, name: string): Promise<Computer> {
  const identity = Buffer.from(`endpoint-${name}`).toString('hex')
  fabric.network.routes.set(identity, [`tcp://192.168.63.${++made}:47100`])
  fabric.network.ports.set(identity, 47100)
  return fabric.computer(name)
}

const device = (on: Computer, node: NodeId) => on.mms.netEngine.status().devices.find((row) => row.node === node)

const sent = (on: Computer, op: string): Array<Record<string, unknown>> =>
  (on.fake?.requests ?? []).filter((message) => message.op === op)

const accessThere = (caller: Computer, node: NodeId) =>
  caller.mms.netEngine.client(node).rpc('bridge.access.mine', {}, { id: newId('rpc'), deadlineMs: 10_000 }) as Promise<
    Record<string, unknown>
  >

const policyOf = (on: Computer, node: NodeId): Record<string, unknown> | undefined =>
  (on.mms.netEngine as unknown as { started: { rt: { policy: { list(): Array<Record<string, unknown>> } } } }).started.rt.policy
    .list()
    .find((policy) => policy.node === node)

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** The open `access.*` exchange `on` holds with `node` (to write on it as that computer's app could). */
function exchange(on: Computer, node: NodeId): Channel {
  const access = on.mms.netEngine.access() as unknown as {
    clients: Map<NodeId, { channel: Channel }>
    hosts: Map<NodeId, { channel: Channel }>
  }
  const link = [access.clients.get(node), access.hosts.get(node)].find((one) => one?.channel.isOpen())
  if (!link) throw new Error('no exchange')
  return link.channel
}

function crashOnce(on: Computer, step: string): () => boolean {
  let hit = false
  on.mms.netEngine.pairingCrash = (at) => at === step && !hit && (hit = true)
  return () => hit
}

/**
 * `owner` shows a code and `caller` joins one way: `owner` lets `caller` in and does not use it. Answers each one's
 * id for the other once the exchange is up (the owner's row offers "Use <caller> from here…").
 */
async function oneWay(fabric: Fabric, owner: Computer, caller: Computer) {
  const invite = await owner.dispatch('netEngine.invite', {}, true)
  const stop = approveAll(owner)
  let joined: { node: NodeId }
  try {
    joined = await caller.dispatch('netEngine.join', { ticket: invite.uri, back: false }, true)
  } finally {
    stop()
  }
  const callerOnOwner = await eventually(() => {
    const row = rowFor(owner, caller)
    expect(row?.state).toBe('connected')
    return row!.localId
  })
  await fabric.connect(caller, joined.node)
  return { callerOnOwner, ownerOnCaller: joined.node }
}

describe('asking for the other direction of a one-way pairing', () => {
  const fabric = new Fabric()
  fabric.network.minor = 2
  fabric.network.features = [...ALL_FEATURES]
  fabric.network.bothWays = true
  afterAll(() => fabric.close(), 60_000)

  it('asks, and Allow at a level lets the asker in over the live connection', async () => {
    const owner = await computer(fabric, 'ask-owner'),
      caller = await computer(fabric, 'ask-caller')
    const { callerOnOwner, ownerOnCaller } = await oneWay(fabric, owner, caller)
    await eventually(() => expect(device(owner, callerOnOwner)?.other).toEqual({ offer: 'ask' }))
    expect(device(caller, ownerOnCaller)?.other).toEqual({ offer: 'let' })

    await owner.dispatch('netEngine.access.ask', { node: callerOnOwner }, true)
    expect(device(owner, callerOnOwner)?.other).toEqual({ offer: 'ask', asked: 'waiting' })
    const ask = await eventually(() => {
      const asks = caller.mms.netEngine.status().accessAsks ?? []
      expect(asks).toHaveLength(1)
      return asks[0]!
    })
    const ownerName = rowFor(caller, owner)!.name
    expect(ask).toMatchObject({ node: ownerOnCaller, name: ownerName })
    // Nothing is granted by the request itself.
    if (!REAL_HELPER) expect(fabric.network.holds(caller.endpoint, owner.endpoint)).toBe(false)

    // What the policy table held when the helper was asked to grant.
    let atGrant: Record<string, unknown> | undefined
    const request = caller.engine.request.bind(caller.engine)
    caller.engine.request = ((op: string, ...rest: unknown[]) => {
      if (op === 'grant.add_connected') atGrant = policyOf(caller, ownerOnCaller)
      return (request as (...args: unknown[]) => Promise<Record<string, unknown>>)(op, ...rest)
    }) as typeof caller.engine.request
    const view = accessPreset('view').fields
    await caller.dispatch(
      'netEngine.access.answer',
      { node: ownerOnCaller, request: ask.request, yes: true, access: view },
      true
    )
    expect(atGrant).toMatchObject(view)
    if (!REAL_HELPER) {
      const [granted] = sent(caller, 'grant.add_connected')
      expect(Object.keys(granted!).sort()).toEqual(['conn', 'id', 'name', 'op', 'role'])
      // View and chat: not an owner here, so no device list and no removals.
      expect(granted).toMatchObject({ name: ownerName, role: 'view' })
      expect(fabric.network.holds(caller.endpoint, owner.endpoint)).toBe(true)
      // No peer record: the caller is used over its own connection.
      expect(fabric.network.peersOf(owner.endpoint)).not.toContain(caller.endpoint)
    }
    expect(rowFor(caller, owner)?.state).toBe('connected')
    expect(rowFor(caller, owner)?.ways).toBeUndefined()
    expect(caller.mms.netEngine.status().accessAsks).toBeUndefined()

    // Both lists on both computers, and the owner works on the caller at the level picked there.
    await eventually(() => {
      expect(rowFor(owner, caller)?.ways).toBeUndefined()
      expect(device(owner, callerOnOwner)?.direction).toBeUndefined()
      expect(device(caller, ownerOnCaller)?.direction).toBeUndefined()
      expect(device(owner, callerOnOwner)?.other).toBeUndefined()
      expect(owner.mms.netEngine.online(callerOnOwner)).toBe(true)
    })
    expect(await accessThere(owner, callerOnOwner)).toMatchObject({ work: false })
    expect(await accessThere(caller, ownerOnCaller)).toMatchObject({ blocked: false })

    // Either direction is still removed on its own: the owner stops using the caller, the caller still uses it.
    await owner.dispatch('netEngine.remove', { node: callerOnOwner, direction: 'out' }, true)
    expect(rowFor(owner, caller)).toMatchObject({ ways: 'in' })
    if (!REAL_HELPER) expect(fabric.network.holds(owner.endpoint, caller.endpoint)).toBe(true)
    expect(await accessThere(caller, ownerOnCaller)).toMatchObject({ blocked: false })
  }, 60_000)

  it('Not now grants nothing, says Declined, and repeats are limited', async () => {
    const owner = await computer(fabric, 'nn-owner'),
      caller = await computer(fabric, 'nn-caller')
    const { callerOnOwner, ownerOnCaller } = await oneWay(fabric, owner, caller)
    await eventually(() => expect(device(owner, callerOnOwner)?.other).toEqual({ offer: 'ask' }))
    await owner.dispatch('netEngine.access.ask', { node: callerOnOwner }, true)
    const ask = await eventually(() => caller.mms.netEngine.status().accessAsks![0]!)
    await caller.dispatch('netEngine.access.answer', { node: ownerOnCaller, request: ask.request, yes: false }, true)
    await eventually(() => expect(device(owner, callerOnOwner)?.other?.asked).toBe('declined'))
    expect(sent(caller, 'grant.add_connected')).toEqual([])
    expect(fabric.network.holds(caller.endpoint, owner.endpoint)).toBe(false)
    expect(rowFor(owner, caller)?.ways).toBe('in')
    expect(rowFor(caller, owner)?.ways).toBe('out')
    expect(policyOf(caller, ownerOnCaller)).toBeUndefined()

    // Asking again at once is refused here; a request sent anyway raises no prompt there.
    await expect(owner.dispatch('netEngine.access.ask', { node: callerOnOwner }, true)).rejects.toThrow(/just now/)
    exchange(owner, callerOnOwner).send({ t: 'access.request', id: 'sent-again-at-once' })
    await sleep(200)
    expect(caller.mms.netEngine.status().accessAsks).toBeUndefined()
    // After the gap the owner may ask again, and is asked again.
    await sleep(limits.gapMs)
    await owner.dispatch('netEngine.access.ask', { node: callerOnOwner }, true)
    await eventually(() => expect(caller.mms.netEngine.status().accessAsks).toHaveLength(1))
  }, 60_000)

  it('Cancel and expiry close the prompt, and a late answer changes nothing', async () => {
    const owner = await computer(fabric, 'end-owner'),
      caller = await computer(fabric, 'end-caller')
    const { callerOnOwner, ownerOnCaller } = await oneWay(fabric, owner, caller)
    await eventually(() => expect(device(owner, callerOnOwner)?.other).toEqual({ offer: 'ask' }))

    await owner.dispatch('netEngine.access.ask', { node: callerOnOwner }, true)
    const cancelled = await eventually(() => caller.mms.netEngine.status().accessAsks![0]!)
    await owner.dispatch('netEngine.access.cancel', { node: callerOnOwner }, true)
    expect(device(owner, callerOnOwner)?.other).toEqual({ offer: 'ask' })
    await eventually(() => expect(caller.mms.netEngine.status().accessAsks).toBeUndefined())
    await expect(
      caller.dispatch(
        'netEngine.access.answer',
        { node: ownerOnCaller, request: cancelled.request, yes: true, access: accessPreset('work').fields },
        true
      )
    ).rejects.toThrow(/ended/)
    // An answer its app sends anyway is not taken.
    exchange(caller, ownerOnCaller).send({ t: 'access.answer', id: cancelled.request, decision: 'allow' })
    await sleep(200)
    expect(rowFor(owner, caller)?.ways).toBe('in')

    await sleep(limits.gapMs)
    await owner.dispatch('netEngine.access.ask', { node: callerOnOwner }, true)
    const expiring = await eventually(() => caller.mms.netEngine.status().accessAsks![0]!)
    await eventually(() => expect(device(owner, callerOnOwner)?.other?.asked).toBe('expired'), limits.askMs + 5_000)
    await eventually(() => expect(caller.mms.netEngine.status().accessAsks).toBeUndefined())
    exchange(caller, ownerOnCaller).send({ t: 'access.answer', id: expiring.request, decision: 'allow' })
    await sleep(200)
    expect(rowFor(owner, caller)?.ways).toBe('in')
    expect(device(owner, callerOnOwner)?.other?.asked).toBe('expired')
    expect(fabric.network.holds(caller.endpoint, owner.endpoint)).toBe(false)
  }, 60_000)

  it('takes nothing from a message alone: extra fields, repeated ids and unasked answers', async () => {
    const owner = await computer(fabric, 'msg-owner'),
      caller = await computer(fabric, 'msg-caller'),
      other = await computer(fabric, 'msg-other')
    const { callerOnOwner, ownerOnCaller } = await oneWay(fabric, owner, caller)
    await eventually(() => expect(device(owner, callerOnOwner)?.other).toEqual({ offer: 'ask' }))
    const toCaller = exchange(owner, callerOnOwner)

    // A request naming another computer is not a request.
    toCaller.send({ t: 'access.request', id: 'named', identity: other.endpoint })
    await sleep(200)
    expect(caller.mms.netEngine.status().accessAsks).toBeUndefined()

    // A request is for the connection's own peer, and an id is taken once.
    toCaller.send({ t: 'access.request', id: 'once' })
    const ask = await eventually(() => caller.mms.netEngine.status().accessAsks![0]!)
    expect(ask).toMatchObject({ node: ownerOnCaller, request: 'once' })
    await caller.dispatch('netEngine.access.answer', { node: ownerOnCaller, request: 'once', yes: false }, true)
    await sleep(limits.gapMs + 100)
    toCaller.send({ t: 'access.request', id: 'once' })
    await sleep(200)
    expect(caller.mms.netEngine.status().accessAsks).toBeUndefined()

    // An answer to a request the owner never sent, and a state that says granted, grant nothing on the owner.
    exchange(caller, ownerOnCaller).send({ t: 'access.answer', id: 'never-asked', decision: 'allow' })
    exchange(caller, ownerOnCaller).send({ t: 'access.state', granted: true, role: 'owner' })
    await sleep(200)
    expect(rowFor(owner, caller)?.ways).toBe('in')
    expect(sent(owner, 'grant.add_connected')).toEqual([])
    expect(sent(caller, 'grant.add_connected')).toEqual([])
    expect(fabric.network.holds(caller.endpoint, owner.endpoint)).toBe(false)

    // While the owner waits, an answer carrying another id is not the answer.
    await owner.dispatch('netEngine.access.ask', { node: callerOnOwner }, true)
    expect(device(owner, callerOnOwner)?.other?.asked).toBe('waiting')
    exchange(caller, ownerOnCaller).send({ t: 'access.answer', id: 'not-this-one', decision: 'allow' })
    await sleep(200)
    expect(device(owner, callerOnOwner)?.other?.asked).toBe('waiting')
    expect(rowFor(owner, caller)?.ways).toBe('in')
  }, 60_000)

  it('never prompts twice for one request id, however many others come after it', async () => {
    const owner = await computer(fabric, 'ids-owner'),
      caller = await computer(fabric, 'ids-caller')
    const { callerOnOwner, ownerOnCaller } = await oneWay(fabric, owner, caller)
    await eventually(() => expect(device(owner, callerOnOwner)?.other).toEqual({ offer: 'ask' }))
    const toCaller = exchange(owner, callerOnOwner)
    toCaller.send({ t: 'access.request', id: 'first' })
    await eventually(() => expect(caller.mms.netEngine.status().accessAsks![0]).toMatchObject({ request: 'first' }))
    await caller.dispatch('netEngine.access.answer', { node: ownerOnCaller, request: 'first', yes: false }, true)
    const flooded = Date.now()

    // Far more new ids than are remembered, then the first again and a new one, each after the prompt gap.
    for (let n = 0; n < 100; n++) toCaller.send({ t: 'access.request', id: `flood-${n}` })
    await sleep(limits.gapMs + 100)
    toCaller.send({ t: 'access.request', id: 'first' })
    await sleep(200)
    expect(caller.mms.netEngine.status().accessAsks).toBeUndefined()
    toCaller.send({ t: 'access.request', id: 'while-full' })
    await sleep(200)
    expect(caller.mms.netEngine.status().accessAsks).toBeUndefined()

    // Once the remembered ids' time is up, a new request prompts again.
    await sleep(Math.max(0, flooded + limits.seenMs + 100 - Date.now()))
    toCaller.send({ t: 'access.request', id: 'later' })
    await eventually(() => expect(caller.mms.netEngine.status().accessAsks![0]).toMatchObject({ request: 'later' }))
  }, 60_000)

  it('is not used on a message saying it grants, and a direction removed here stays removed until asked again', async () => {
    const owner = await computer(fabric, 'say-owner'),
      caller = await computer(fabric, 'say-caller')
    const { callerOnOwner, ownerOnCaller } = await oneWay(fabric, owner, caller)
    await eventually(() => expect(device(owner, callerOnOwner)?.other).toEqual({ offer: 'ask' }))
    const toOwner = exchange(caller, ownerOnCaller)
    const sayGranted = async () => {
      toOwner.send({ t: 'access.state', granted: false })
      toOwner.send({ t: 'access.state', granted: true })
      await sleep(500)
    }

    // The caller says it grants the owner, but holds no grant: the owner's row stays one way and nothing is dialled.
    await sayGranted()
    expect(fabric.network.holds(caller.endpoint, owner.endpoint)).toBe(false)
    expect(rowFor(owner, caller)?.ways).toBe('in')
    expect(device(owner, callerOnOwner)?.direction).toBe('in')
    expect(owner.mms.netEngine.online(callerOnOwner)).toBe(false)

    // Its owner then lets the owner in from its row: a call it serves adds the direction.
    await caller.dispatch('netEngine.access.let', { node: ownerOnCaller, access: accessPreset('view').fields }, true)
    await eventually(() => {
      expect(rowFor(owner, caller)?.ways).toBeUndefined()
      expect(owner.mms.netEngine.online(callerOnOwner)).toBe(true)
    })

    // The owner stops using the caller, which still lets it in: the same messages do not put that direction back.
    await owner.dispatch('netEngine.remove', { node: callerOnOwner, direction: 'out' }, true)
    expect(rowFor(owner, caller)).toMatchObject({ ways: 'in', stoppedUsing: true })
    await sayGranted()
    expect(fabric.network.holds(caller.endpoint, owner.endpoint)).toBe(true)
    expect(rowFor(owner, caller)?.ways).toBe('in')
    expect(owner.mms.netEngine.online(callerOnOwner)).toBe(false)

    // Asking again is the owner adding it back: the caller still grants it, so the direction returns.
    await eventually(() => expect(device(owner, callerOnOwner)?.other?.offer).toBe('ask'))
    await owner.dispatch('netEngine.access.ask', { node: callerOnOwner }, true)
    await eventually(() => {
      expect(rowFor(owner, caller)?.ways).toBeUndefined()
      expect(owner.mms.netEngine.online(callerOnOwner)).toBe(true)
    })
    expect(rowFor(owner, caller)?.stoppedUsing).toBeUndefined()
  }, 60_000)

  it('lets the other computer in from its own row, and both rows follow', async () => {
    const owner = await computer(fabric, 'let-owner'),
      caller = await computer(fabric, 'let-caller')
    const { callerOnOwner, ownerOnCaller } = await oneWay(fabric, owner, caller)
    await eventually(() => expect(device(caller, ownerOnCaller)?.other).toEqual({ offer: 'let' }))
    const view = accessPreset('view').fields
    await caller.dispatch('netEngine.access.let', { node: ownerOnCaller, access: view }, true)
    expect(policyOf(caller, ownerOnCaller)).toMatchObject(view)
    expect(rowFor(caller, owner)?.ways).toBeUndefined()
    await eventually(() => {
      expect(rowFor(owner, caller)?.ways).toBeUndefined()
      expect(owner.mms.netEngine.online(callerOnOwner)).toBe(true)
    })
    expect(await accessThere(owner, callerOnOwner)).toMatchObject({ work: false })
  }, 60_000)

  it('saves the level before the grant and writes the row after a stop in between', async () => {
    const owner = await computer(fabric, 'stop-owner'),
      caller = await computer(fabric, 'stop-caller')
    const { callerOnOwner, ownerOnCaller } = await oneWay(fabric, owner, caller)
    await eventually(() => expect(device(caller, ownerOnCaller)?.other).toEqual({ offer: 'let' }))
    const view = accessPreset('view').fields
    // The helper's first save fails: the grant is in effect and the repeat saves it.
    fabric.network.storeFailing.set(caller.endpoint, 1)
    const stopped = crashOnce(caller, 'let-in')
    await expect(caller.dispatch('netEngine.access.let', { node: ownerOnCaller, access: view }, true)).rejects.toBeDefined()
    expect(stopped()).toBe(true)
    expect(sent(caller, 'grant.add_connected')).toHaveLength(2)
    expect(fabric.network.holds(caller.endpoint, owner.endpoint)).toBe(true)
    // The grant is not served without its row: nothing is written past the stop.
    expect(rowFor(caller, owner)).toMatchObject({ grant: '', ways: 'out' })
    caller.mms.netEngine.pairingCrash = undefined
    await fabric.restartEngine(caller)
    await eventually(() => expect(rowFor(caller, owner)?.grant).not.toBe(''))
    expect(rowFor(caller, owner)?.ways).toBeUndefined()
    expect(policyOf(caller, ownerOnCaller)).toMatchObject(view)
    await fabric.connect(caller, ownerOnCaller)
    await eventually(() => expect(owner.mms.netEngine.status().devices.find((row) => row.node === callerOnOwner)).toBeDefined())
    // The owner hears it was let in, and is served under the level saved first.
    await eventually(() => expect(rowFor(owner, caller)?.ways).toBeUndefined())
    await eventually(() => expect(owner.mms.netEngine.online(callerOnOwner)).toBe(true))
    expect(await accessThere(owner, callerOnOwner)).toMatchObject({ work: false })
  }, 60_000)

  it('offers nothing to, and sends nothing to, an app without the feature', async () => {
    const owner = await computer(fabric, 'old-owner'),
      caller = await computer(fabric, 'old-caller')
    // The owner's app is older: it says only one-way pairing.
    const ownerAccess = owner.mms.netEngine.access() as unknown as { features(): string[] }
    ownerAccess.features = () => ['one-way']
    const { callerOnOwner, ownerOnCaller } = await oneWay(fabric, owner, caller)
    await sleep(300)
    expect(device(caller, ownerOnCaller)?.other).toBeUndefined()
    expect(() => exchange(caller, ownerOnCaller)).toThrow()
    expect(() => exchange(owner, callerOnOwner)).toThrow()
    await expect(
      caller.dispatch('netEngine.access.let', { node: ownerOnCaller, access: accessPreset('work').fields }, true)
    ).rejects.toThrow()
    expect(sent(caller, 'grant.add_connected')).toEqual([])

    // The other way round: the caller's app is older, so the owner's row offers no ask.
    const owner2 = await computer(fabric, 'old-owner2'),
      caller2 = await computer(fabric, 'old-caller2')
    const callerAccess = caller2.mms.netEngine.access() as unknown as { features(): string[] }
    callerAccess.features = () => ['one-way']
    const pair = await oneWay(fabric, owner2, caller2)
    await sleep(300)
    expect(device(owner2, pair.callerOnOwner)?.other).toBeUndefined()
    await expect(owner2.dispatch('netEngine.access.ask', { node: pair.callerOnOwner }, true)).rejects.toThrow()
  }, 60_000)
})

describe('asking when the connection was announced before its HELLO', () => {
  const fabric = new Fabric()
  fabric.network.minor = 2
  fabric.network.features = [...ALL_FEATURES]
  fabric.network.bothWays = true
  // The owner's helper says `both: false` for the caller's connection, as it can on a real network.
  fabric.network.lateHello = true
  afterAll(() => fabric.close(), 60_000)

  it('still lets the asker in over that connection after Allow', async () => {
    const owner = await computer(fabric, 'late-owner'),
      caller = await computer(fabric, 'late-caller')
    const { callerOnOwner, ownerOnCaller } = await oneWay(fabric, owner, caller)
    await eventually(() => expect(device(owner, callerOnOwner)?.other).toEqual({ offer: 'ask' }))
    await owner.dispatch('netEngine.access.ask', { node: callerOnOwner }, true)
    const ask = await eventually(() => {
      const asks = caller.mms.netEngine.status().accessAsks ?? []
      expect(asks).toHaveLength(1)
      return asks[0]!
    })
    await caller.dispatch(
      'netEngine.access.answer',
      { node: ownerOnCaller, request: ask.request, yes: true, access: accessPreset('view').fields },
      true
    )
    await eventually(() => expect(owner.mms.netEngine.online(callerOnOwner)).toBe(true))
    expect(await accessThere(owner, callerOnOwner)).toMatchObject({ work: false })
  }, 60_000)
})
