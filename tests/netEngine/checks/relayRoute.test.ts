/**
 * The relay route case of the app checks (`scripts/net-engine-check.mjs <1a check> --route relay`, Phase 3): each
 * computer adds one relay of `MOUSSE_RELAY_TEST_LINKS` as its own; pairing setup runs direct; after `settle`, every
 * `conn.up` is written to `<out>/conn-up.jsonl` and must be of kind `relay` through one of those relays, else the run
 * records `route_mismatch`.
 *
 * Over the fake helper (hand-authored: once a computer adds a relay, every dial to it comes up through it). The real
 * helper and a real `mousse-relay` run in the check itself (`MOUSSE_NET_HELPER`, the kit's `--route relay`).
 */
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const links = vi.hoisted(() => {
  const code = 'C'.repeat(22)
  const list = [
    `mousse-relay://127.0.0.1:47501/#${'A'.repeat(43)}.${code}`,
    `mousse-relay://127.0.0.1:47502/#${'B'.repeat(43)}.${code}`
  ]
  // Read when the harness loads.
  process.env.MOUSSE_NET_ENGINE_CHECK_ROUTE = 'relay'
  process.env.MOUSSE_RELAY_TEST_LINKS = `${list[0]}, ${list[1]}`
  return list
})

import { Fabric, relayTestLinks, routeMatches, type Computer } from './harness'

const RELAYS = ['relay://127.0.0.1:47501', 'relay://127.0.0.1:47502']
// Where the run writes; read when a Fabric is made.
const out = mkdtempSync(join(tmpdir(), 'relay-route-check-'))
process.env.MOUSSE_NET_ENGINE_CHECK_OUT = out
const lines = (): Array<Record<string, any>> =>
  existsSync(join(out, 'conn-up.jsonl'))
    ? readFileSync(join(out, 'conn-up.jsonl'), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : []
const reason = () => (existsSync(join(out, 'reason')) ? readFileSync(join(out, 'reason'), 'utf8') : '')

describe('the links and routes a relay run takes', () => {
  it('reads each enrollment link and the relay it names', () => {
    expect(relayTestLinks(`${links[0]}\n${links[1]} not-a-link`)).toEqual([
      { link: links[0], destination: RELAYS[0] },
      { link: links[1], destination: RELAYS[1] }
    ])
    expect(relayTestLinks('mousse-relay://Relay.Example:443/#a.b')[0]?.destination).toBe(
      'relay://relay.example:443'
    )
    expect(relayTestLinks(undefined)).toEqual([])
  })

  const expected = { kind: 'relay', class: 'relay' }
  it.each([
    ['a relay connection through a run relay', { kind: 'relay', class: 'relay', destination: RELAYS[0] }, true],
    ['its bulk companion', { kind: 'relay', class: 'relay_bulk', destination: RELAYS[1] }, true],
    ['one that names no destination', { kind: 'relay', class: 'relay' }, false],
    ['another relay', { kind: 'relay', class: 'relay', destination: 'relay://127.0.0.1:9' }, false],
    ['a direct tcp connection', { kind: 'tcp', class: 'lan' }, false],
    ['no route', undefined, false]
  ])('%s matches: %s', (_name, route, matches) => {
    expect(routeMatches(route, expected, RELAYS)).toBe(matches)
  })
})

describe('a relay run', () => {
  const fabric = new Fabric()
  let owner: Computer, caller: Computer
  beforeAll(async () => {
    owner = await fabric.computer('owner')
    caller = await fabric.computer('caller')
    await fabric.pair(owner, caller)
  }, 120_000)
  afterAll(() => fabric.close(), 120_000)

  it('adds one relay per computer, judges nothing during setup, then every connection goes through a relay', async () => {
    expect(owner.fake!.requests.filter((request) => request.op === 'relay.enroll').map((request) => request.link)).toEqual([links[0]])
    expect(caller.fake!.requests.filter((request) => request.op === 'relay.enroll').map((request) => request.link)).toEqual([links[1]])
    // Setup is not judged: nothing written yet.
    expect(lines()).toEqual([])

    await fabric.settle()
    const ups = lines()
    expect(ups.length).toBeGreaterThanOrEqual(4)
    for (const up of ups) {
      expect(up.ev).toBe('conn.up')
      expect(up.route.kind).toBe('relay')
      expect(RELAYS).toContain(up.route.destination)
    }
    expect(reason()).toBe('')
  }, 180_000)

  it('records route_mismatch for a connection after setup that is not through a relay', async () => {
    // The caller's relay is gone: the owner's redial after its restart reaches it some other way.
    fabric.network.relayed.delete(caller.endpoint)
    await fabric.restartHelper(owner)
    await vi.waitFor(() => expect(reason()).toBe('route_mismatch'), { timeout: 60_000 })
    expect(lines().some((up) => up.route?.kind !== 'relay')).toBe(true)
  }, 120_000)
})
