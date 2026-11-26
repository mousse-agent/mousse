/**
 * Turning networking off when v1 was enabled runs `netEngine.disable` followed by `net.disable`
 * (see `EngineDevicesSection`), which closes the shared Bridge domain. Turning networking back on
 * (`netEngine.enable`, leaving v1 disabled) must compose a fresh Bridge domain so `bridge.editorAsks`,
 * `threadRouter`, and routed calls on qualified remote ids keep working without restarting the daemon,
 * and qualified remote ids asked while networking is off must fail with `computer_offline`, never `ambiguous`.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { qualifyId } from '../../src/shared/threadRef'
import { Fabric, codeOf, deviceState, eventually } from './checks/harness'

describe('toggling networking off (with v1 disable) and back on', () => {
  const fabric = new Fabric()
  fabric.network.bothWays = true
  afterAll(() => fabric.close(), 60_000)

  it('keeps qualified remote ids off local stores while off and restores Bridge routing when re-enabled', async () => {
    const mac = await fabric.computer('mac')
    const pc = await fabric.computer('pc')
    const { ownerOnCaller } = await fabric.pair(mac, pc)
    expect(deviceState(pc, ownerOnCaller)).toBe('connected')

    // Create a thread on Mac and confirm PC can read it via its qualified id.
    const remoteThread = mac.mms.threads.createThread('Remote on Mac')
    const qualifiedId = qualifyId(ownerOnCaller, remoteThread.id)
    const before = await pc.dispatch('threads.get', { threadId: qualifiedId })
    expect(before.thread).toMatchObject({ id: qualifiedId, name: 'Remote on Mac' })

    // Enable v1 on PC so toggling networking off runs both `netEngine.disable` and `net.disable`.
    await pc.mms.net.request('net.init', { listen: false })
    expect(pc.mms.net.status().enabled).toBe(true)

    // Toggle networking OFF (exact sequence from EngineDevicesSection).
    await pc.dispatch('netEngine.disable', {}, true)
    await pc.mms.net.request('net.disable', {})
    expect(pc.mms.net.status().enabled).toBe(false)

    // While off (and Bridge domain closed), qualified remote ids must fail with `computer_offline`, never `ambiguous`.
    for (const [method, params] of [
      ['threads.markSeen', { threadId: qualifiedId }],
      ['thread.snapshot', { threadId: qualifiedId }],
      ['threads.get', { threadId: qualifiedId }]
    ] as const) {
      const error = await pc.dispatch(method, params).then(
        () => undefined,
        (err) => err
      )
      expect(codeOf(error), method).toBe('computer_offline')
    }

    // Toggle networking BACK ON (`netEngine.enable` only; v1 remains disabled).
    await pc.dispatch('netEngine.enable', {}, true)
    expect(pc.mms.net.status().enabled).toBe(false)
    await eventually(() => expect(deviceState(pc, ownerOnCaller)).toBe('connected'))

    // `bridge.editorAsks` must work (not throw `cancelled`), and qualified remote thread routing must work again.
    await expect(pc.dispatch('bridge.editorAsks', {}, true)).resolves.toEqual({ asks: [] })
    const after = await pc.dispatch('threads.get', { threadId: qualifiedId })
    expect(after.thread).toMatchObject({ id: qualifiedId, name: 'Remote on Mac' })
    const renamed = await pc.dispatch('threads.rename', { threadId: qualifiedId, name: 'Renamed after toggle' })
    expect(renamed.thread).toMatchObject({ id: qualifiedId, name: 'Renamed after toggle' })
    expect(mac.mms.threads.getThread(remoteThread.id)?.name).toBe('Renamed after toggle')
  }, 90_000)
})
