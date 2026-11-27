/**
 * The update list's computers (`computerUpdateRows`) and the computers a restart of this one drops
 * (`computersUsingThis`), for every input that decides them. Inputs: this computer behind, current or unable to
 * install; another computer in the service's plan (updated from here over requests or SSH, or skipped), not in it yet,
 * paired one way, current, on another channel, a development build, a phone, revoked, listed twice, or known only to the
 * plan; and the order rows come in.
 */
import { describe, expect, it } from 'vitest'
import { computerUpdateRows, computersUsingThis, oneWayNodes, skippedText } from '../../src/renderer/lib/updateEverywhere'
import type { Device } from '../../src/renderer/lib/netDevices'
import type { NetEngineDevice } from '../../src/shared/netEngine/local'
import type { RolloutRow } from '../../src/shared/updateRollout'

const takes = { channel: 'stable' as const, self: true, requests: true as const }
const selfOnly = { channel: 'stable' as const, self: true }
const cannot = { channel: 'stable' as const, self: false, reason: 'Updates on macOS need a signed build.' }
const device = (node: string, extra: Partial<Device> = {}): Device => ({
  node: node as Device['node'], name: node, caps: [], keyEpoch: 1, expiresAt: 0, kind: 'computer', self: false, revoked: false, state: 'open', ...extra
})
const engine = (node: string, extra: Partial<NetEngineDevice> = {}): NetEngineDevice =>
  ({ node, name: node, shortId: node, state: 'connected', online: true, ...extra }) as NetEngineDevice

const behind = { version: '0.9.0', olderThanThis: true }
const run = (devices: Device[], plan?: RolloutRow[], oneWay: string[] = [], current = '0.9.2', target = '0.9.4') =>
  computerUpdateRows({ devices, oneWay: new Set(oneWay), plan, current, target })
const line = (row: { name: string; updates: boolean; how: string; plan: string; current?: true }) =>
  `${row.name}|${row.updates ? 'updates' : row.current ? 'current' : 'skipped'}|${row.how}|${row.plan}`

type Case = [string, Device[], RolloutRow[] | undefined, string[], string | undefined]
const cases: Case[] = [
  ['updates from here (plan: request)', [device('a', { ...behind, update: takes })], [{ node: 'a', name: 'a', via: 'request', phase: 'ready' }], [], 'a|updates|Updates from here|10-second countdown there'],
  ['updates over SSH (plan: ssh)', [device('a', { ...behind, update: cannot })], [{ node: 'a', name: 'a', via: 'ssh', phase: 'ready' }], [], 'a|updates|Updates over SSH|Installs over SSH'],
  ["Mousse isn't open there (plan: manual)", [device('a', { ...behind, update: selfOnly })], [{ node: 'a', name: 'a', via: 'manual', phase: 'manual', error: "Mousse isn't open there" }], [], "a|skipped|Mousse isn't open there|Skipped · Mousse isn't open there"],
  ['offline (plan: offline)', [device('a', { ...behind, state: 'closed', update: selfOnly })], [{ node: 'a', name: 'a', via: 'request', phase: 'offline', error: 'Offline' }], [], 'a|skipped|Offline|Skipped · offline'],
  ['its own reason (plan: manual)', [device('a', { ...behind, update: cannot })], [{ node: 'a', name: 'a', via: 'manual', phase: 'manual', error: 'x' }], [], 'a|skipped|Updates on macOS need a signed build|Skipped · updates on macOS need a signed build'],
  ['too old to report its update', [device('a', behind)], [{ node: 'a', name: 'a', via: 'manual', phase: 'manual', error: 'Too old to update from here' }], [], 'a|skipped|Too old to update from here|Skipped · too old to update from here'],
  ['before the plan is read: the way its Devices row offers', [device('a', { ...behind, update: takes })], undefined, [], 'a|updates|Updates from here|10-second countdown there'],
  ['paired one way, behind', [device('a', { ...behind, update: takes })], [], ['a'], 'a|skipped|Paired one way|Skipped · paired one way'],
  ['paired one way, never said its version', [device('a')], [], ['a'], 'a|skipped|Paired one way|Skipped · paired one way'],
  ['already on the version', [device('a', { version: '0.9.4', newerThanThis: true })], [], [], 'a|current|Up to date|Up to date'],
  ['another channel', [device('a', { version: '0.9.5-nightly.20261120.1', otherChannel: true })], [], [], 'a|skipped|Other update channel|Skipped · other update channel'],
  ['a development build', [device('a', { version: '0.0.0-dev' })], [], [], 'a|skipped|Development build|Skipped · development build'],
  ['a phone', [device('a', { ...behind, kind: 'phone' })], [], [], undefined],
  ['revoked', [device('a', { ...behind, revoked: true })], [], [], undefined],
  ['known only to the plan', [], [{ node: 'z', name: 'Server', via: 'ssh', phase: 'ready', from: '0.9.1' }], [], 'Server|updates|Updates over SSH|Installs over SSH']
]

describe('computerUpdateRows', () => {
  it.each(cases)('%s', (_label, devices, plan, oneWay, expected) => {
    const rows = run(devices, plan, oneWay).slice(1)
    expect(rows.map(line)[0]).toBe(expected)
    expect(rows.length).toBe(expected ? 1 : 0)
  })

  it('this computer: downloads then restarts last when behind, up to date when not, and says why when this app cannot install', () => {
    expect(line(run([])[0])).toBe('This computer|updates|Downloads, then restarts|Restarts last')
    expect(line(run([], undefined, [], '0.9.4', '0.9.4')[0])).toBe('This computer|current|Up to date|Up to date')
    const manual: RolloutRow = { node: 'self', name: 'Studio', via: 'manual', phase: 'manual', error: "This app can't install updates" }
    expect(line(run([], [manual])[0])).toBe("This computer|skipped|This app can't install updates|Skipped · this app can't install updates")
  })

  it('lists each computer once: this one, then the ones updated, the skipped ones and the current ones, in list order', () => {
    const rows = run(
      [
        device('current', { version: '0.9.4' }),
        device('closed', { ...behind, update: selfOnly }),
        device('takes', { ...behind, update: takes }),
        device('takes', { ...behind, update: takes }),
        device('ssh', behind)
      ],
      [
        { node: 'self', name: 'Studio', via: 'self', phase: 'ready' },
        { node: 'closed', name: 'closed', via: 'manual', phase: 'manual', error: "Mousse isn't open there" },
        { node: 'takes', name: 'takes', via: 'request', phase: 'ready' },
        { node: 'ssh', name: 'ssh', via: 'ssh', phase: 'ready' }
      ]
    )
    expect(rows.map((row) => row.node)).toEqual(['self', 'takes', 'ssh', 'closed', 'current'])
  })

  it('keeps a name as written after "Skipped ·"', () => {
    expect(skippedText("Mousse isn't open there")).toBe("Skipped · Mousse isn't open there")
    expect(skippedText('SSH login failed')).toBe('Skipped · SSH login failed')
  })
})

describe('the computers using this one', () => {
  it('are the connected pairings that use this computer, and connected devices of the older networking', () => {
    const devices = [
      device('self', { self: true }),
      device('both', { source: 'engine' }),
      device('usesMe', { source: 'engine' }),
      device('iUseIt', { source: 'engine' }),
      device('away', { source: 'engine', state: 'closed' }),
      device('v1', { connection: 'connected' }),
      device('v1off', { state: 'closed', connection: 'connected' }),
      device('gone', { revoked: true, connection: 'connected' })
    ]
    const status = {
      devices: [
        engine('both'),
        engine('usesMe', { direction: 'in' }),
        engine('iUseIt', { direction: 'out' }),
        engine('away', { state: 'offline', online: false })
      ]
    }
    expect(computersUsingThis(devices, status).map((row) => row.node)).toEqual(['both', 'usesMe', 'v1'])
    expect([...oneWayNodes(status)]).toEqual(['usesMe'])
  })
})
