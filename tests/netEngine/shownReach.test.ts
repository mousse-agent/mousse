/**
 * A helper that never saved its routes offers every address it has, tailnet ones too, whatever Reach shows. Its
 * invitations must offer only routes whose switch is on: the app saves what Reach shows.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { eventually, Fabric } from './checks/harness'

describe('routes whose switch is off', () => {
  const fabric = new Fabric()
  fabric.network.minor = 1
  afterAll(() => fabric.close(), 60_000)

  it('saves Reach as shown when the helper offers a tailnet address with Tailnet off', async () => {
    const identity = Buffer.from('endpoint-b').toString('hex')
    fabric.network.routes.set(identity, ['tcp://100.101.0.9:47100', 'tcp://192.168.1.9:47100'])
    await fabric.computer('b')
    await eventually(() =>
      expect(fabric.network.reach.get(identity)).toMatchObject({ lan: true, tailnet: false })
    )
  })
})
