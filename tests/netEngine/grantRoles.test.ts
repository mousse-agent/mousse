/**
 * A grant's role follows its device's level (pairing flow §8): only Full control is `owner` at the helper, so only a
 * Full control device gets this computer's device list and may remove another device here. The level stays the
 * truth: Allow and Send link make the grant at the level picked, a change of level moves the role in the same step,
 * and each start moves a role left behind (a stop between the two, or an `owner` grant an older build made).
 */
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { NodeId } from '../../src/shared/net'
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

/** `host`'s level table, written directly, as a stop between saving a level and moving the role leaves it. */
function writeLevel(host: Computer, node: NodeId, level: AccessPresetId): void {
  const started = (host.mms.netEngine as unknown as { started: { rt: { policy: { set(node: NodeId, change: object): void } } } })
    .started
  started.rt.policy.set(node, accessPreset(level).fields)
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

  it('each start moves a role left behind by its level', async () => {
    const host = await computer(fabric, 'start-host'),
      caller = await computer(fabric, 'start-caller')
    const node = await pairAt(host, caller, 'full')
    expect(await roleOn(host, caller)).toBe('owner')
    // The level was saved and the app stopped before the role moved (or an older build made every grant `owner`).
    writeLevel(host, node, 'view')
    expect(await roleOn(host, caller)).toBe('owner')
    await fabric.restartEngine(host)
    await eventually(async () => expect(await roleOn(host, caller)).toBe('view'))
    // And back, after a helper restart alone.
    writeLevel(host, node, 'full')
    await fabric.restartHelper(host)
    await eventually(async () => expect(await roleOn(host, caller)).toBe('owner'))
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

/**
 * Remove on all my hosts, with the real helper: a host sends its device list only to an owner and applies only an
 * owner's signed removal. A View and chat device gets no list; a Full control device gets one and its removal
 * applies; once narrowed, its removal is refused.
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

    // Narrowed, the admin's removal (planned from the list it had) is refused, and the phone stays.
    await setLevel(host, adminOnHost, 'view')
    expect(await result(await confirm(phone, phoneGrant))).toBe('refused')
    expect((await grantOf(host, phone)).grant).toBe(phoneGrant)

    // Full control again: its removal of the viewer applies and the viewer's grant is gone.
    await setLevel(host, adminOnHost, 'full')
    expect(await result(await confirm(viewer, viewerGrant))).toBe('applied')
    await expect(grantOf(host, viewer)).rejects.toThrow(/holds no grant/)
  }, 240_000)
})
