/**
 * A Send link's tries after the right code: the host takes a try when an attempt starts and shows the next code
 * before it knows the result, so the used link must give that try back and show no code.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { eventually, Fabric } from './checks/harness'

describe('a Send link used with the right code', () => {
  const fabric = new Fabric()
  afterAll(() => fabric.close(), 120_000)

  it('keeps its tries and shows no next code', async () => {
    const host = await fabric.computer('host'),
      joiner = await fabric.computer('joiner')
    const link = await host.dispatch('netEngine.invite', { kind: 'link' }, true)
    const shown = () =>
      host.mms.netEngine.status().links?.find((one) => one.invitation === link.invitation)
    const joined = joiner.dispatch('netEngine.join', { ticket: link.uri, arrival: 'link' }, true)
    await eventually(() =>
      expect(
        joiner.mms.netEngine.status().joins?.find((one) => one.invitation === link.invitation)
          ?.needsCode
      ).toBe(true)
    )
    await joiner.dispatch(
      'netEngine.join.code',
      { invitation: link.invitation, code: shown()!.code },
      true
    )
    await joined
    await eventually(() => {
      expect(shown()?.node).toBeTruthy()
      expect(shown()?.attemptsLeft).toBe(3)
      expect(shown()?.code).toBe('')
    })
  }, 60_000)
})
