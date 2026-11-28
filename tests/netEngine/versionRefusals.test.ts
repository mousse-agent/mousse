/**
 * Devices cut off for their version (pair-with-IP design §5), through the Settings window's daemon calls over the
 * fake helper: the helper's recorded refusal shows on the device's row, Check again dials it, its one notice is
 * remembered across an app restart, and both clear once a connection agrees a version. Also how a refusal on the
 * helper's list rows maps to the row (who updates, when).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { NodeId } from '../../src/shared/net'
import { needsUpdate, readVersionRefusals } from '../../src/mms/netEngine/versionRefusals'
import { eventually, Fabric, REAL_HELPER, type Computer } from './checks/harness'

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
  /** B stays on an older Mousse; A's connection to it drops and Check again dials it. */
  const cutOff = async () => {
    fabric.network.outdated.set(b.endpoint, 2)
    await fabric.restartHelper(a)
    await a.dispatch('netEngine.retry', { node: bOnA }, true)
  }

  it('shows Needs update after Check again is refused, keeps its notice across a restart, and clears once B updates', async () => {
    expect(device()?.needsUpdate).toBeUndefined()
    await cutOff()
    await eventually(() => expect(device()?.needsUpdate).toMatchObject({ who: 'there' }))
    expect(device()?.needsUpdate?.told).toBeUndefined()

    await a.dispatch('netEngine.versionNotice.shown', { node: bOnA }, true)
    expect(device()?.needsUpdate?.told).toBe(true)
    // Remembered by the app, not only this run: after a restart the refusal is still told.
    await fabric.restartEngine(a)
    await eventually(() => expect(device()?.needsUpdate).toMatchObject({ who: 'there', told: true }))

    // B updates: Check again connects, and the row and its notice clear.
    fabric.network.outdated.delete(b.endpoint)
    await a.dispatch('netEngine.retry', { node: bOnA }, true)
    await eventually(() => expect(device()?.needsUpdate).toBeUndefined())

    // Cut off again later: told again.
    await cutOff()
    await eventually(() => expect(device()?.needsUpdate).toMatchObject({ who: 'there' }))
    expect(device()?.needsUpdate?.told).toBeUndefined()
  }, 120_000)

  it('reads the refusal again when the helper says a device was refused coming in', async () => {
    fabric.network.versionRefusals.get(a.endpoint)?.delete(b.endpoint)
    fabric.network.outdated.delete(b.endpoint)
    await a.dispatch('netEngine.retry', { node: bOnA }, true)
    await eventually(() => expect(device()?.needsUpdate).toBeUndefined())
    // As the helper: an incoming connection from B refused for version is recorded, then told.
    fabric.network.versionRefusals.get(a.endpoint)!.set(b.endpoint, { peer_minor: 5, local_minor: 4, since: 1 })
    a.fake!.emit({ ev: 'peer.incompatible', identity: b.endpoint, peer_minor: 5 })
    await eventually(() => expect(device()?.needsUpdate).toEqual({ who: 'here', since: 1000 }))
  }, 60_000)
})
