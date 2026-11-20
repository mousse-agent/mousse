/**
 * Mousse Plus through the engine (Phase 4, M16 and M17), over the fake helper: the Plus state and the removals are
 * read once the helper said hello, again a bounded number of times while it is starting; the outage line, a
 * finished sign-in and Sign out reach `netEngine.status`; and a new helper starts from nothing the last one said.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FakePlus } from './fakeHelper'
import { eventually, Fabric, type Computer } from './checks/harness'

const identity = (name: string) => Buffer.from(`endpoint-${name}`).toString('hex')
const URL = 'https://plus.test'
const LINKED = {
  configured: true,
  linked: true,
  url: URL,
  account: { plan: 'active', period_ends_at: 1_800_000_000 },
  usage: { bulk: { allowance: 100, available: 40 } }
}
const SIGNED_OUT = { configured: true, linked: false, url: URL, link_result: 'unlinked' }

describe('Plus through the engine (Phase 4)', () => {
  const fabric = new Fabric()
  let a: Computer
  const plus: FakePlus = {
    answers: {
      'plus.status': LINKED,
      'removal.list': {
        removals: [{ id: 'r1', host: 'h1', removed: 'x1', name: 'Phone', grant: 4, state: 'sent' }],
        asks: []
      },
      'plus.unlink': {}
    },
    // A helper still starting: the first two reads of the Plus state fail.
    failures: { 'plus.status': 2 }
  }
  beforeAll(async () => {
    fabric.network.plus.set(identity('a'), plus)
    a = await fabric.computer('a')
  }, 120_000)
  afterAll(() => fabric.close(), 120_000)

  const status = () => a.mms.netEngine.status()
  const asked = (op: string) => a.fake!.requests.filter((request) => request.op === op)

  it('reads Plus and the removals once the helper said hello, asking again while it is starting', async () => {
    await eventually(() => expect(status().plus).toMatchObject({ linked: true, plan: 'active' }), 15_000)
    expect(asked('plus.status')).toHaveLength(3)
    const ops = a.fake!.requests.map((request) => request.op)
    expect(ops.indexOf('hello')).toBeLessThan(ops.indexOf('plus.status'))
    expect(status().removals).toEqual([expect.objectContaining({ id: 'r1', state: 'sent' })])
  }, 60_000)

  it('shows an outage and its end, as the helper says them', async () => {
    a.fake!.emit({ ev: 'plus.reach', reachable: false, since: 1_700_000_000 })
    await eventually(() => expect(status().plus?.unreachableSince).toBe(1_700_000_000))
    a.fake!.emit({ ev: 'plus.reach', reachable: true })
    await eventually(() => expect(status().plus?.unreachableSince).toBeUndefined())
  })

  it('signs out, and reads the state again when a sign-in ends', async () => {
    plus.answers['plus.status'] = SIGNED_OUT
    await a.dispatch('netEngine.plus.signOut', {}, true)
    expect(asked('plus.unlink')).toHaveLength(1)
    expect(status().plus).toMatchObject({ linked: false, linkResult: 'unlinked' })

    plus.answers['plus.status'] = LINKED
    a.fake!.emit({ ev: 'plus.link', state: 'approved' })
    await eventually(() => expect(status().plus?.linked).toBe(true))
  })

  it('starts from nothing when a new helper says hello, and stops asking a helper that keeps failing', async () => {
    expect(status().removals).toHaveLength(1)
    plus.failures = { 'plus.status': 1_000, 'removal.list': 1_000 }
    await fabric.restartHelper(a)
    // Nothing the last helper said stands while the new one is not answering.
    await eventually(() => expect(asked('plus.status').length).toBeGreaterThan(0))
    expect(status().plus).toBeUndefined()
    expect(status().removals).toBeUndefined()
    // plusReadTries (5) asks, then none until an event.
    await eventually(() => expect(asked('plus.status')).toHaveLength(5), 15_000)
    await new Promise((resolve) => setTimeout(resolve, 1_500))
    expect(asked('plus.status')).toHaveLength(5)
    expect(asked('removal.list')).toHaveLength(5)
  }, 60_000)
})
