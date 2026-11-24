/**
 * One connection carries calls both ways (wire minor 3, `conn.up {both}`): a computer that only dials out pairs,
 * both rows read Connected over its one connection, and the computer it dialled works on its threads over it.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { Fabric, deviceState } from './checks/harness'

describe.each([
  ['', false],
  [', announced before its HELLO', true]
])('a pairing whose joiner only dials out%s', (_, lateHello) => {
  const fabric = new Fabric()
  fabric.network.bothWays = true
  // The Mac's helper says `both: false` for the PC's connection, as it can on a real network.
  fabric.network.lateHello = lateHello
  fabric.network.outboundOnly.add(Buffer.from('endpoint-pc').toString('hex'))
  afterAll(() => fabric.close(), 60_000)

  it('finishes pairing, reads Connected on both, and the Mac opens a thread on the PC', async () => {
    const mac = await fabric.computer('mac')
    const pc = await fabric.computer('pc')
    const { callerOnOwner, ownerOnCaller } = await fabric.pair(mac, pc)
    expect(deviceState(mac, callerOnOwner)).toBe('connected')
    expect(deviceState(pc, ownerOnCaller)).toBe('connected')
    // Mac → PC over the PC's own connection.
    const path = fabric.folder()
    const project = await mac.dispatch('projects.open', { node: callerOnOwner, path })
    const created = await mac.dispatch('threads.create', {
      node: callerOnOwner,
      name: 'From the Mac',
      projectId: (project.project ?? project).id
    })
    expect((created.thread ?? created).id).toBeTruthy()
  }, 60_000)
})
