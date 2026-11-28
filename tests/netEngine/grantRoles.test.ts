/**
 * A grant's role follows its device's level (pairing flow §8): only Full control is `owner` at the helper, so only a
 * Full control device gets this computer's device list and may remove another device here. The level stays the
 * truth: Allow and Send link make the grant at the level picked, a change of level moves the role in the same step,
 * and each start moves a role left behind (a stop between the two, or an `owner` grant an older build made).
 */
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { NodeId } from '../../src/shared/net'
import { roleForLevel, type EngineLevel } from '../../src/mms/netEngine/roles'
import { accessPreset, type AccessPresetId } from '../../src/shared/net/accessPresets'
import { Fabric, REAL_HELPER, codeOf, connectedBothWays, eventually, rowFor, type Computer } from './checks/harness'

vi.hoisted(() => {
  process.env.MOUSSE_NET_ENGINE_ROLE_RETRY_MS = '400'
})

const ALL_FEATURES = ['invite-way', 'route-readiness', 'join-probe', 'grant-revoke-local', 'grant-roles', 'grant-add-connected']

/** The role and revision of the grant `caller` holds on `host`, as `host`'s helper lists it. */
async function grantOf(host: Computer, caller: Computer): Promise<{ grant: number; role: string; revision: number }> {
  const answer = await host.engine.request('grants.list')
  const found = (answer.grants as Array<Record<string, unknown>>).find((one) => one.identity === caller.endpoint)
  if (!found) throw new Error(`${caller.name} holds no grant on ${host.name}`)
  return {
    grant: Number(found.grant),
    role: typeof found.role === 'string' ? found.role : 'owner',
    revision: typeof found.revision === 'number' ? found.revision : 1
  }
}

let made = 0

/** A new computer; on the fake network it answers on its own address. */
function computer(fabric: Fabric, name: string): Promise<Computer> {
  if (!REAL_HELPER) {
    const identity = Buffer.from(`endpoint-${name}`).toString('hex')
    fabric.network.routes.set(identity, [`tcp://192.168.64.${++made}:47100`])
    fabric.network.ports.set(identity, 47100)
  }
  return fabric.computer(name)
}

const roleOn = async (host: Computer, caller: Computer) => (await grantOf(host, caller)).role

/** The role `caller`'s helper records it holds at `host` (its peer record, which "Remove on all my hosts" reads). */
async function recordedAt(caller: Computer, host: Computer): Promise<string | undefined> {
  const answer = await caller.engine.request('peers.list')
  const found = (answer.peers as Array<Record<string, unknown>>).find((one) => one.identity === host.endpoint)
  return typeof found?.role === 'string' ? found.role : undefined
}

const device = (on: Computer, node: NodeId) => on.mms.netEngine.status().devices.find((row) => row.node === node)

/** `host`'s window changes `node`'s level, as the level picker does. */
const setLevel = (host: Computer, node: NodeId, level: AccessPresetId) =>
  host.dispatch('bridge.policy', { node, ...accessPreset(level).fields }, true)

/** `caller` joins `host` both ways; `host`'s window says Allow at `level`. Answers `caller`'s row on `host`. */
async function pairAt(host: Computer, caller: Computer, level: AccessPresetId): Promise<NodeId> {
  const invite = await host.dispatch('netEngine.invite', {}, true)
  const access = accessPreset(level).fields
  const answered = new Set<string>()
  const timer = setInterval(() => {
    for (const approval of host.mms.netEngine.status().approvals)
      if (!answered.has(approval.request)) {
        answered.add(approval.request)
        void host
          .dispatch('netEngine.approve', { request: approval.request, yes: true, access }, true)
          .catch(() => undefined)
      }
  }, 25)
  try {
    await caller.dispatch('netEngine.join', { ticket: invite.uri }, true)
  } finally {
    clearInterval(timer)
  }
  return connectedBothWays(host, caller)
}

interface Internals {
  rt: { policy: { set(node: NodeId, change: object): unknown; get(node: NodeId): EngineLevel } }
  roles: { stop(): void }
}
const internals = (on: Computer) => (on.mms.netEngine as unknown as { started: Internals }).started

/** `host`'s level table, written directly, as an older build that made every grant `owner` left it. */
function writeLevel(host: Computer, node: NodeId, level: AccessPresetId): void {
  internals(host).rt.policy.set(node, accessPreset(level).fields)
}

const WIDTH: Record<string, number> = { view: 1, work: 2, owner: 3 }

/** The grant `caller` holds on `host` is no wider than the role `host`'s saved level for it needs. */
async function neverWider(host: Computer, caller: Computer, node: NodeId): Promise<void> {
  const held = await roleOn(host, caller)
  const level = roleForLevel(internals(host).rt.policy.get(node))
  expect(WIDTH[held], `${held} held under a level that needs ${level}`).toBeLessThanOrEqual(WIDTH[level]!)
}

/**
 * `host`'s window changes `node`'s level to `level`, and the app stops after `writes` of the change's two writes
 * (the role edit at the helper, the saved level): nothing after that is written, as when it stops there.
 */
async function changeStoppingAfter(host: Computer, node: NodeId, level: AccessPresetId, writes: number): Promise<void> {
  const started = internals(host)
  const helper = host.mms.netEngine.currentHelper()!
  const request = helper.request.bind(helper)
  const policy = started.rt.policy
  const save = policy.set.bind(policy)
  let wrote = 0
  const write = <T>(work: () => T): T => {
    if (wrote++ < writes) return work()
    started.roles.stop()
    throw new Error('stopped')
  }
  helper.request = ((op: string, ...rest: unknown[]) =>
    op === 'grant.set_role'
      ? write(() => (request as (...args: unknown[]) => unknown)(op, ...rest))
      : (request as (...args: unknown[]) => unknown)(op, ...rest)) as typeof helper.request
  policy.set = (target, change) => write(() => save(target, change))
  try {
    await setLevel(host, node, level).catch(() => undefined)
  } finally {
    helper.request = request
    policy.set = save
  }
}

const HOST = 'roles-b.test'

/** `a` adds `b` over SSH through its window, as Settings does (`b` answers at `HOST`). */
async function addOverSsh(a: Computer, b: Computer): Promise<void> {
  const resolved = await a.dispatch('netEngine.ssh.resolve', { target: `me@${HOST}` }, true)
  const probe = await a.dispatch('netEngine.ssh.probe', { routeId: resolved.routeId, host: HOST }, true)
  await a.dispatch('netEngine.ssh.trust', { routeId: resolved.routeId, sha256: probe.sha256, host: HOST }, true)
  await a.dispatch('netEngine.ssh.profiles', { routeId: resolved.routeId, host: HOST, user: 'me' }, true)
  const selector = b.mms.sshRemote()!.selectorOf(b.mms.netEngine.profileDir)
  await a.dispatch(
    'netEngine.ssh.connect',
    { routeId: resolved.routeId, target: `me@${HOST}`, host: HOST, user: 'me', selector },
    true
  )
}

describe("a grant's role follows the device's level", () => {
  const fabric = new Fabric()
  if (!REAL_HELPER) {
    fabric.network.minor = 2
    fabric.network.features = [...ALL_FEATURES]
  }
  afterAll(() => fabric.close(), 60_000)

  it('Allow makes the grant at the level picked: only Full control is owner', async () => {
    const host = await computer(fabric, 'roles-host')
    const viewer = await computer(fabric, 'roles-viewer'),
      worker = await computer(fabric, 'roles-worker'),
      admin = await computer(fabric, 'roles-admin')
    await pairAt(host, viewer, 'view')
    await pairAt(host, worker, 'work')
    await pairAt(host, admin, 'full')
    expect(await roleOn(host, viewer)).toBe('view')
    expect(await roleOn(host, worker)).toBe('work')
    expect(await roleOn(host, admin)).toBe('owner')
    // A device below Full control still works here: the app is told its traffic (the hello lists `grant-roles`).
    const viewerOnHost = rowFor(host, viewer)!.localId
    expect(device(host, viewerOnHost)?.accessPending).toBeUndefined()
    const hostOnViewer = rowFor(viewer, host)!.localId
    await fabric.connect(viewer, hostOnViewer)
    await expect(viewer.dispatch('threads.list', { node: hostOnViewer })).resolves.toBeDefined()
  }, 120_000)

  it('a change of level moves the role both ways, and an unchanged level leaves the grant alone', async () => {
    const host = await computer(fabric, 'change-host'),
      caller = await computer(fabric, 'change-caller')
    const node = await pairAt(host, caller, 'full')
    const before = await grantOf(host, caller)
    expect(before.role).toBe('owner')

    const answer = await setLevel(host, node, 'view')
    expect(answer.policy).toMatchObject(accessPreset('view').fields)
    // Done means the helper holds the narrower role already.
    const narrowed = await grantOf(host, caller)
    expect(narrowed).toMatchObject({ grant: before.grant, role: 'view' })
    expect(narrowed.revision).toBeGreaterThan(before.revision)

    await setLevel(host, node, 'work')
    expect(await roleOn(host, caller)).toBe('work')
    // A change that keeps the role (Work on threads with one more right is not Full control) edits nothing.
    const kept = await grantOf(host, caller)
    await host.dispatch('bridge.policy', { node, terminal: true }, true)
    expect(await grantOf(host, caller)).toEqual(kept)

    await setLevel(host, node, 'full')
    expect(await roleOn(host, caller)).toBe('owner')
    // The bot level alone is not part of Full control: lowering it leaves the grant as it is.
    const owner = await grantOf(host, caller)
    for (const bots of ['use', 'off', 'full']) {
      await host.dispatch('bridge.policy', { node, bots }, true)
      expect(await grantOf(host, caller), bots).toEqual(owner)
    }
    // Blocked is not an owner, whatever its rights.
    await host.dispatch('bridge.policy', { node, blocked: true }, true)
    expect(await roleOn(host, caller)).not.toBe('owner')
    await host.dispatch('bridge.policy', { node, blocked: false }, true)
    expect(await roleOn(host, caller)).toBe('owner')

    // The caller connects again under its new role and keeps working.
    await setLevel(host, node, 'work')
    const hostOnCaller = rowFor(caller, host)!.localId
    await eventually(async () => {
      await fabric.connect(caller, hostOnCaller)
      await expect(caller.dispatch('threads.list', { node: hostOnCaller })).resolves.toBeDefined()
    }, 30_000)
  }, 120_000)

  it('a stop at any point of a change leaves the grant no wider than the saved level; the next start makes it follow', async () => {
    const host = await computer(fabric, 'start-host'),
      caller = await computer(fabric, 'start-caller')
    const node = await pairAt(host, caller, 'full')
    for (const [from, to] of [
      ['full', 'view'],
      ['view', 'full'],
      ['work', 'view']
    ] as const)
      for (const writes of [0, 1]) {
        await setLevel(host, node, from)
        expect(await roleOn(host, caller)).toBe(roleForLevel(accessPreset(from).fields))
        await changeStoppingAfter(host, node, to, writes)
        await neverWider(host, caller, node)
        // The start pass runs straight after the helper's hello, before the service reads as running.
        await fabric.restartEngine(host)
        expect(await roleOn(host, caller)).toBe(roleForLevel(internals(host).rt.policy.get(node)))
      }
  }, 180_000)

  it('each start moves a role an older build left wider than its level, and keeps trying while that fails', async () => {
    const host = await computer(fabric, 'old-build-host'),
      caller = await computer(fabric, 'old-build-caller')
    const node = await pairAt(host, caller, 'full')
    // An older build made every grant `owner`, whatever the level.
    writeLevel(host, node, 'view')
    await fabric.restartEngine(host)
    expect(await roleOn(host, caller)).toBe('view')
    // And back, after a helper restart alone.
    writeLevel(host, node, 'full')
    await fabric.restartHelper(host)
    await eventually(async () => expect(await roleOn(host, caller)).toBe('owner'))
    if (REAL_HELPER) return
    // The start's edit fails: the row shows it, and it is tried again until it is applied.
    writeLevel(host, node, 'view')
    fabric.network.setRoleFailing.set(host.endpoint, 1)
    await fabric.restartEngine(host)
    expect(await roleOn(host, caller)).toBe('owner')
    expect(device(host, node)?.accessPending).toBe(true)
    await eventually(async () => {
      expect(await roleOn(host, caller)).toBe('view')
      expect(device(host, node)?.accessPending).toBeUndefined()
    }, 10_000)
  }, 120_000)

  it('every narrowing ends what this computer serves the device before the edit, Work to View too', async () => {
    const host = await computer(fabric, 'serve-host'),
      caller = await computer(fabric, 'serve-caller')
    const node = await pairAt(host, caller, 'work')
    const stop = vi.spyOn(host.mms.netEngine as unknown as { stopServing(node: NodeId): void }, 'stopServing')
    const helper = host.mms.netEngine.currentHelper()!
    const request = helper.request.bind(helper)
    /** How many times serving had stopped when each role edit was sent. */
    const stoppedAtEdit: number[] = []
    helper.request = ((op: string, ...rest: unknown[]) => {
      if (op === 'grant.set_role') stoppedAtEdit.push(stop.mock.calls.length)
      return (request as (...args: unknown[]) => unknown)(op, ...rest)
    }) as typeof helper.request
    try {
      await setLevel(host, node, 'view')
      expect(stop.mock.calls).toEqual([[node]])
      expect(stoppedAtEdit).toEqual([1])
      // A widening ends nothing.
      await setLevel(host, node, 'work')
      expect(stop).toHaveBeenCalledTimes(1)
      expect(stoppedAtEdit).toEqual([1, 1])
      // Blocking Full control narrows too.
      await setLevel(host, node, 'full')
      expect(stoppedAtEdit).toEqual([1, 1, 1])
      await host.dispatch('bridge.policy', { node, blocked: true }, true)
      expect(stop).toHaveBeenCalledTimes(2)
      expect(stoppedAtEdit).toEqual([1, 1, 1, 2])
    } finally {
      helper.request = request
      stop.mockRestore()
    }
  }, 120_000)

  it.skipIf(REAL_HELPER)('joining back is done only once a grant the host held here already takes its level', async () => {
    const host = await computer(fabric, 'back-host'),
      caller = await computer(fabric, 'back-caller')
    // An earlier join's grant, its row lost: the helper answers it as it is, `owner`.
    fabric.network.heldAlready(caller.endpoint, host.endpoint)
    const roleThere = () => fabric.network.grantsAt(caller.endpoint).find((one) => one.caller === host.endpoint)?.role
    fabric.network.setRoleFailing.set(caller.endpoint, 1)
    let doneAsOwner = false,
      shownPending = false
    const watch = setInterval(() => {
      const row = rowFor(caller, host)
      if (row?.state === 'connected' && roleThere() === 'owner') doneAsOwner = true
      if (row && device(caller, row.localId)?.accessPending) shownPending = true
    }, 2)
    try {
      await pairAt(host, caller, 'view')
      await eventually(() => expect(rowFor(caller, host)?.state).toBe('connected'), 30_000)
    } finally {
      clearInterval(watch)
    }
    // The level the joiner gave the host (Work on threads, by default), never `owner` while it was done.
    expect(roleThere()).toBe('work')
    expect(doneAsOwner).toBe(false)
    expect(shownPending).toBe(true)
  }, 120_000)

  it.skipIf(REAL_HELPER)('with no helper running, a change of level is saved and shown not applied until one takes it', async () => {
    const host = await computer(fabric, 'down-host'),
      caller = await computer(fabric, 'down-caller')
    const node = await pairAt(host, caller, 'full')
    const roleHere = () => fabric.network.grantsAt(host.endpoint).find((one) => one.caller === caller.endpoint)?.role
    const launch = host.mms.netEngine.launcher!
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    host.mms.netEngine.launcher = async () => {
      await held
      return launch()
    }
    host.kill()
    await eventually(() => expect(host.mms.netEngine.currentHelper()).toBeUndefined())
    const error = await setLevel(host, node, 'view').catch((caught: unknown) => caught)
    expect(codeOf(error)).toBe('role_pending')
    expect(internals(host).rt.policy.get(node)).toMatchObject(accessPreset('view').fields)
    expect(device(host, node)?.accessPending).toBe(true)
    expect(roleHere()).toBe('owner')
    host.mms.netEngine.launcher = launch
    release()
    await eventually(() => {
      expect(roleHere()).toBe('view')
      expect(device(host, node)?.accessPending).toBeUndefined()
    })
    host.engine = host.mms.netEngine.currentHelper()!
  }, 120_000)

  it.skipIf(REAL_HELPER)('a computer added over SSH starts at Full control, and a later change moves its role', async () => {
    const b = await computer(fabric, 'ssh-b'),
      a = await computer(fabric, 'ssh-a')
    await fabric.sshServer(HOST, b)
    await addOverSsh(a, b)
    const node = await eventually(() => {
      const row = rowFor(b, a)
      expect(row?.state).toBe('connected')
      return row!.localId
    }, 30_000)
    expect(rowFor(b, a)?.source).toBe('ssh')
    expect(roleForLevel(internals(b).rt.policy.get(node))).toBe('owner')
    expect(await roleOn(b, a)).toBe('owner')
    await setLevel(b, node, 'view')
    expect(await roleOn(b, a)).toBe('view')
    await setLevel(b, node, 'full')
    expect(await roleOn(b, a)).toBe('owner')
    await b.dispatch('bridge.policy', { node, blocked: true }, true)
    expect(await roleOn(b, a)).not.toBe('owner')
  }, 120_000)

  it('the device records the role its host says, after the reconnect each level change causes', async () => {
    const host = await computer(fabric, 'told-host'),
      caller = await computer(fabric, 'told-caller')
    const node = await pairAt(host, caller, 'view')
    const hostOnCaller = rowFor(caller, host)!.localId
    expect(await recordedAt(caller, host)).toBe('view')

    // Promoted: the host's edit cuts the device's connection, and the hello of the next one says `owner`.
    await setLevel(host, node, 'full')
    await eventually(async () => {
      await fabric.connect(caller, hostOnCaller)
      expect(await recordedAt(caller, host)).toBe('owner')
    }, 30_000)
    // Narrowed: the next hello says `view`.
    await setLevel(host, node, 'view')
    await eventually(async () => {
      await fabric.connect(caller, hostOnCaller)
      expect(await recordedAt(caller, host)).toBe('view')
    }, 30_000)
  }, 120_000)

  it.skipIf(REAL_HELPER)('a host whose hello says no role leaves the recorded role as it is', async () => {
    const host = await computer(fabric, 'quiet-host'),
      caller = await computer(fabric, 'quiet-caller')
    const node = await pairAt(host, caller, 'view')
    const hostOnCaller = rowFor(caller, host)!.localId
    fabric.network.streamRoles = false
    try {
      await setLevel(host, node, 'full')
      await eventually(async () => {
        await fabric.connect(caller, hostOnCaller)
        expect(await roleOn(host, caller)).toBe('owner')
      }, 30_000)
      // Its hello answered over the new connection, without a role.
      expect(caller.mms.netEngine.online(hostOnCaller)).toBe(true)
      expect(await recordedAt(caller, host)).toBe('view')
    } finally {
      fabric.network.streamRoles = true
    }
  }, 120_000)

  it('Send link fixes the role of the level picked with the link', async () => {
    const host = await computer(fabric, 'link-host'),
      caller = await computer(fabric, 'link-caller')
    const link = await host.dispatch('netEngine.invite', { kind: 'link', access: accessPreset('view').fields }, true)
    // The link's code, typed on the joining computer as its person reads it from the host.
    const joined = caller.dispatch('netEngine.join', { ticket: link.uri, arrival: 'link', back: false }, true)
    await eventually(() =>
      expect(caller.mms.netEngine.status().joins?.find((one) => one.invitation === link.invitation)?.needsCode).toBe(true)
    )
    const code = host.mms.netEngine.status().links?.find((one) => one.invitation === link.invitation)?.code
    await caller.dispatch('netEngine.join.code', { invitation: link.invitation, code }, true)
    await joined
    await eventually(() => expect(rowFor(host, caller)?.state).toBe('connected'))
    expect(await roleOn(host, caller)).toBe('view')
  }, 120_000)

  it.skipIf(REAL_HELPER)('a narrowing the helper could not save is not done, shows on the row and is retried', async () => {
    const host = await computer(fabric, 'fail-host'),
      caller = await computer(fabric, 'fail-caller')
    const node = await pairAt(host, caller, 'full')
    fabric.network.setRoleFailing.set(host.endpoint, 1)
    const error = await setLevel(host, node, 'view').catch((caught: unknown) => caught)
    expect(codeOf(error)).toBe('role_pending')
    expect((error as Error).message).toMatch(/^Saved, but networking hasn't applied it yet/)
    // The level is saved; the row says the change is not applied yet.
    expect(device(host, node)?.accessPending).toBe(true)
    await eventually(async () => {
      expect(await roleOn(host, caller)).toBe('view')
      expect(device(host, node)?.accessPending).toBeUndefined()
    }, 10_000)
  }, 120_000)
})

/** A helper without roles makes every grant `owner`: right only for Full control. */
describe.skipIf(REAL_HELPER)('a helper that cannot take roles', () => {
  const fabric = new Fabric()
  fabric.network.minor = 2
  fabric.network.features = ALL_FEATURES.filter((one) => one !== 'grant-roles')
  afterAll(() => fabric.close(), 60_000)

  it('lets a device in at Full control only; a change below that is saved but not reported applied', async () => {
    const host = await computer(fabric, 'plain-host'),
      caller = await computer(fabric, 'plain-caller')
    const invite = await host.dispatch('netEngine.invite', {}, true)
    const joining = caller.dispatch('netEngine.join', { ticket: invite.uri, back: false }, true)
    const approval = await eventually(() => {
      const first = host.mms.netEngine.status().approvals[0]
      expect(first).toBeDefined()
      return first!
    })
    const allow = (level: AccessPresetId) =>
      host.dispatch('netEngine.approve', { request: approval.request, yes: true, access: accessPreset(level).fields }, true)
    // Allow below Full control is refused, and nothing is granted.
    expect(codeOf(await allow('work').catch((caught: unknown) => caught))).toBe('role_unsupported')
    expect(fabric.network.holds(host.endpoint, caller.endpoint)).toBe(false)
    await allow('full')
    await joining
    const node = await eventually(() => {
      const row = rowFor(host, caller)
      expect(row?.state).toBe('connected')
      return row!.localId
    })
    expect(device(host, node)?.accessPending).toBeUndefined()
    // A change below Full control: saved, said not applied, and shown on the row.
    const error = await setLevel(host, node, 'work').catch((caught: unknown) => caught)
    expect(codeOf(error)).toBe('role_unsupported')
    expect((error as Error).message).toBe('Saved, but networking needs an update to apply it.')
    expect(internals(host).rt.policy.get(node)).toMatchObject(accessPreset('work').fields)
    expect(device(host, node)?.accessPending).toBe(true)
    // Full control again is applied: it is what the grant holds.
    await setLevel(host, node, 'full')
    expect(device(host, node)?.accessPending).toBeUndefined()
  }, 120_000)
})

/**
 * Remove on all my hosts, with the real helper: a host sends its device list only to an owner and applies only an
 * owner's signed removal. A View and chat device gets no list; a Full control device gets one and its removal
 * applies. Each device learns its role from the host's hello after the reconnect an edit causes: narrowed, it no
 * longer lists the host; made Full control, it does.
 */
describe.runIf(REAL_HELPER)('removals follow the role', () => {
  const fabric = new Fabric()
  afterAll(() => fabric.close(), 60_000)

  it("a View and chat device gets no device list; a Full control device's removal applies only while it is Full", async () => {
    const host = await computer(fabric, 'rm-host')
    const admin = await computer(fabric, 'rm-admin'),
      viewer = await computer(fabric, 'rm-viewer'),
      phone = await computer(fabric, 'rm-phone')
    const adminOnHost = await pairAt(host, admin, 'full')
    await pairAt(host, viewer, 'view')
    await pairAt(host, phone, 'work')
    const hostOnAdmin = rowFor(admin, host)!.localId,
      hostOnViewer = rowFor(viewer, host)!.localId
    await fabric.connect(admin, hostOnAdmin)
    await fabric.connect(viewer, hostOnViewer)

    const planned = async (on: Computer, removed: Computer) =>
      (
        (await on.engine.request('removal.plan', { identity: removed.endpoint })).hosts as Array<Record<string, unknown>>
      ).find((one) => one.host === host.endpoint)
    // The owner's list names each device's grant.
    const listed = (removed: Computer) =>
      eventually(async () => {
        const entry = await planned(admin, removed)
        expect(typeof entry?.grant).toBe('number')
        return entry!.grant as number
      }, 30_000)
    const phoneGrant = await listed(phone),
      viewerGrant = await listed(viewer)
    expect(phoneGrant).toBe((await grantOf(host, phone)).grant)
    expect(viewerGrant).toBe((await grantOf(host, viewer)).grant)
    // The viewer is not an owner of the host: nothing to plan, and its helper signs no removal for it.
    expect(await planned(viewer, phone)).toBeUndefined()
    await expect(
      viewer.engine.request('removal.confirm', {
        identity: phone.endpoint,
        name: 'phone',
        hosts: [{ host: host.endpoint, grant: phoneGrant }]
      })
    ).rejects.toThrow()

    const confirm = async (removed: Computer, grant: number) => {
      const answer = await admin.engine.request('removal.confirm', {
        identity: removed.endpoint,
        name: removed.name,
        hosts: [{ host: host.endpoint, grant }]
      })
      return String((answer.removals as Array<{ id: string; removed: string }>).find((one) => one.removed === removed.endpoint)!.id)
    }
    const result = (id: string) =>
      eventually(async () => {
        await fabric.connect(admin, hostOnAdmin)
        const removals = await admin.engine.request('removal.list')
        const item = (removals.removals as Array<Record<string, unknown>>).find((one) => one.id === id)
        expect(item?.state).toBe('done')
        return item!.result
      }, 60_000)

    // Narrowed: after the reconnect the edit causes, the admin no longer lists the host, its own helper signs no
    // removal for it, and the phone stays.
    await setLevel(host, adminOnHost, 'view')
    await eventually(async () => {
      await fabric.connect(admin, hostOnAdmin)
      expect(await planned(admin, phone)).toBeUndefined()
    }, 30_000)
    await expect(confirm(phone, phoneGrant)).rejects.toThrow(/did not make this device an owner/)
    expect((await grantOf(host, phone)).grant).toBe(phoneGrant)

    // The viewer made Full control: after its reconnect it lists the host. (The host's first list on that
    // connection arrives before the hello that says `owner`, so the grant is named from the host's next list.)
    const viewerOnHost = rowFor(host, viewer)!.localId
    await setLevel(host, viewerOnHost, 'full')
    await eventually(async () => {
      await fabric.connect(viewer, hostOnViewer)
      expect(await planned(viewer, phone)).toBeDefined()
    }, 30_000)

    // Full control again: the edit changes the host's list, which now names the phone's grant to the viewer too.
    await setLevel(host, adminOnHost, 'full')
    await eventually(async () => {
      await fabric.connect(admin, hostOnAdmin)
      expect(await planned(admin, viewer)).toBeDefined()
    }, 30_000)
    await eventually(async () => expect((await planned(viewer, phone))?.grant).toBe(phoneGrant), 30_000)
    // Its removal of the viewer applies and the viewer's grant is gone.
    expect(await result(await confirm(viewer, viewerGrant))).toBe('applied')
    await expect(grantOf(host, viewer)).rejects.toThrow(/holds no grant/)
  }, 240_000)
})
