/**
 * Devices cut off for their version (pair-with-IP design §5), through the Settings window's daemon calls over the
 * fake helper: the helper's recorded refusal shows on the device's row and is read again without an event, Check
 * again dials it even while an old session is up, nothing of it is used meanwhile, one window is given its notice,
 * which is remembered on disk, and all of it clears once a connection agrees a version. Also how a refusal on the
 * helper's list rows maps to the row (who updates, when).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { NodeId } from '../../src/shared/net'
import { accessPreset } from '../../src/shared/net/accessPresets'
import { needsUpdate, readVersionRefusals } from '../../src/mms/netEngine/versionRefusals'
import { eventually, Fabric, REAL_HELPER, type Computer } from './checks/harness'

vi.hoisted(() => {
  // A window's read of the status reads the refusals again once the last read is this old.
  process.env.MOUSSE_NET_ENGINE_REFUSAL_FRESH_MS = '200'
})

describe('version_refusal on the helper’s list rows', () => {
  const row = (identity: string, refusal: unknown) => ({ identity, version_refusal: refusal })
  // Inputs: null, either computer older, malformed fields, a device on both lists, upper-case identities.
  const cases: Array<[string, Record<string, unknown>[], Record<string, unknown>[], Record<string, unknown>]> = [
    ['no refusal', [row('AA', null)], [], {}],
    ['the device is older', [row('AA', { peer_minor: 2, local_minor: 4, since: 100 })], [], { aa: { who: 'there', since: 100_000 } }],
    ['this computer is older', [], [row('aa', { peer_minor: 5, local_minor: 4, since: 7 })], { aa: { who: 'here', since: 7_000 } }],
    ['a minor that is not a number', [row('aa', { peer_minor: '2', local_minor: 4, since: 1 })], [], {}],
    ['no since', [row('aa', { peer_minor: 2, local_minor: 4 })], [], {}],
    [
      'on both lists, the later one',
      [row('aa', { peer_minor: 2, local_minor: 4, since: 5 })],
      [row('AA', { peer_minor: 1, local_minor: 4, since: 9 })],
      { aa: { who: 'there', since: 9_000 } }
    ]
  ]
  it.each(cases)('%s', (_label, peers, grants, expected) => {
    const read = readVersionRefusals({ peers }, { grants })
    expect(Object.fromEntries([...read].map(([identity, refusal]) => [identity, needsUpdate(refusal, false)]))).toEqual(expected)
  })
})

describe.skipIf(REAL_HELPER)('a device cut off for its version', () => {
  const fabric = new Fabric()
  fabric.network.minor = 2
  fabric.network.features = ['grant-roles', 'version-refusals']
  let a: Computer, b: Computer
  let bOnA: NodeId
  beforeAll(async () => {
    for (const [name, last] of [['vr-a', 1], ['vr-b', 2]] as const) {
      const identity = Buffer.from(`endpoint-${name}`).toString('hex')
      fabric.network.routes.set(identity, [`tcp://192.168.64.${last}:47100`])
      fabric.network.ports.set(identity, 47100)
    }
    a = await fabric.computer('vr-a')
    b = await fabric.computer('vr-b')
    ;({ callerOnOwner: bOnA } = await fabric.pair(a, b))
  }, 120_000)
  afterAll(() => fabric.close(), 120_000)

  const device = () => a.mms.netEngine.status().devices.find((row) => row.node === bOnA)
  const refusalsOnA = () => {
    const map = fabric.network.versionRefusals.get(a.endpoint) ?? new Map()
    fabric.network.versionRefusals.set(a.endpoint, map)
    return map
  }
  const dials = () => (a.fake?.requests ?? []).filter((request) => request.op === 'dial' && request.identity === b.endpoint).length
  const claim = (since: number) => a.dispatch('netEngine.versionNotice.claim', { node: bOnA, since }, true)
  /** B stays on an older Mousse; A's connection to it drops and Check again dials it. */
  const cutOff = async () => {
    fabric.network.outdated.set(b.endpoint, 2)
    await fabric.restartHelper(a)
    await a.dispatch('netEngine.retry', { node: bOnA }, true)
  }
  /** B is updated: Check again connects, and the refusal clears. */
  const updated = async () => {
    fabric.network.outdated.delete(b.endpoint)
    await a.dispatch('netEngine.retry', { node: bOnA }, true)
    await eventually(() => expect(device()?.needsUpdate).toBeUndefined())
  }

  it('shows Needs update after Check again is refused, gives its notice to one window, keeps that on disk, and clears once B updates', async () => {
    expect(device()?.needsUpdate).toBeUndefined()
    await cutOff()
    await eventually(() => expect(device()?.needsUpdate).toMatchObject({ who: 'there' }))
    const since = device()!.needsUpdate!.since
    expect(device()?.needsUpdate?.told).toBeUndefined()

    // Two windows ask: the first is given the notice, the second is not; an ask for another refusal never is.
    await expect(claim(since + 1)).resolves.toEqual({ show: false })
    await expect(claim(since)).resolves.toEqual({ show: true })
    await expect(claim(since)).resolves.toEqual({ show: false })
    expect(device()?.needsUpdate?.told).toBe(true)

    // Kept on disk: with what the service held in memory dropped, the restarted engine reads it back.
    ;(a.mms.netEngine as unknown as { versionTold?: unknown }).versionTold = undefined
    await fabric.restartEngine(a)
    await eventually(() => expect(device()?.needsUpdate).toMatchObject({ who: 'there', told: true }))
    await expect(claim(since)).resolves.toEqual({ show: false })

    await updated()
    // Cut off again later: a new refusal, told again.
    await cutOff()
    await eventually(() => expect(device()?.needsUpdate).toMatchObject({ who: 'there' }))
    expect(device()?.needsUpdate?.told).toBeUndefined()
    await updated()
    // A window's ask that comes late, for a refusal that cleared since, takes nothing from the one recorded after it.
    const later = since / 1000 + 100
    refusalsOnA().set(b.endpoint, { peer_minor: 2, local_minor: 4, since: later })
    a.fake!.emit({ ev: 'peer.incompatible', identity: b.endpoint, peer_minor: 2 })
    await eventually(() => expect(device()?.needsUpdate?.since).toBe(later * 1000))
    await expect(claim(since)).resolves.toEqual({ show: false })
    expect(device()?.needsUpdate?.told).toBeUndefined()
    await expect(claim(later * 1000)).resolves.toEqual({ show: true })
    await updated()
  }, 120_000)

  it('uses nothing of a device refused coming in while its old session is up, and Check again dials it at once', async () => {
    await eventually(() => expect(a.mms.netEngine.online(bOnA)).toBe(true))
    // As the helper: an incoming connection from B refused for version is recorded, then told.
    refusalsOnA().set(b.endpoint, { peer_minor: 5, local_minor: 4, since: 1 })
    a.fake!.emit({ ev: 'peer.incompatible', identity: b.endpoint, peer_minor: 5 })
    await eventually(() => expect(device()?.needsUpdate).toEqual({ who: 'here', since: 1000 }))
    // The session from before is still up, but no thread or call goes over it.
    expect(a.mms.netEngine.online(bOnA)).toBe(false)
    let refused: unknown
    try {
      a.mms.netEngine.client(bOnA)
    } catch (error) {
      refused = error
    }
    expect(refused).toMatchObject({ code: 'incompatible_peer' })
    // Disabled here too: a Limits dialog opened before the refusal saves nothing, and no route or other-direction
    // change goes through.
    const policyOf = async () =>
      ((await a.dispatch('bridge.nodes', {}, true)) as { nodes: Array<{ node: string; policy: unknown }> }).nodes.find(
        (row) => row.node === bOnA
      )?.policy
    const policyBefore = await policyOf()
    expect(policyBefore).toBeTruthy()
    await expect(a.dispatch('bridge.policy', { node: bOnA, terminal: true }, true)).rejects.toMatchObject({
      code: 'incompatible_peer'
    })
    await expect(
      a.dispatch('netEngine.address.add', { node: bOnA, address: '192.168.64.9:47100' }, true)
    ).rejects.toMatchObject({ code: 'incompatible_peer' })
    await expect(
      a.dispatch('netEngine.access.let', { node: bOnA, access: accessPreset('work').fields }, true)
    ).rejects.toMatchObject({
      code: 'incompatible_peer'
    })
    expect(await policyOf()).toEqual(policyBefore)
    const before = dials()
    await a.dispatch('netEngine.retry', { node: bOnA }, true)
    expect(dials()).toBe(before + 1)
    refusalsOnA().delete(b.endpoint)
    await updated()
    expect(a.mms.netEngine.online(bOnA)).toBe(true)
  }, 60_000)

  it('reads a refusal the helper recorded without an event when a window reads the status', async () => {
    // As the helper within its hour between notices: B is refused coming in again, and no event says so.
    refusalsOnA().set(b.endpoint, { peer_minor: 2, local_minor: 4, since: 50 })
    await eventually(() => expect(device()?.needsUpdate).toEqual({ who: 'there', since: 50_000 }), 5_000)
    refusalsOnA().delete(b.endpoint)
    await updated()
  }, 60_000)
})
