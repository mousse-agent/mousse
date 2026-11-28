/**
 * How Settings → Devices offers to update a computer that is behind (`computerUpdateWay`), for every input that
 * decides it: whether it is behind, an SSH install from here, whether it can be asked (a computer this one uses),
 * online or not, what it said about updating itself, whether this computer has a release to send, and whether its
 * connection was refused for its version.
 */
import { describe, expect, it } from 'vitest'
import { computerUpdateWay } from '../../src/renderer/components/netEngine/computerUpdate'
import type { SshRecordView } from '../../src/shared/net/local'

const takes = { channel: 'stable' as const, self: true, requests: true as const }
const selfOnly = { channel: 'stable' as const, self: true }
const cannot = { channel: 'stable' as const, self: false, reason: 'Updates on macOS need a signed build.' }
const managed = { id: 'ssh1', owner: 'managed' } as SshRecordView
const base = { name: 'Laptop', state: 'open' as const, version: '0.9.0', olderThanThis: true }

type Row = [string, Partial<typeof base> & { update?: unknown; otherChannel?: boolean } | undefined, { record?: SshRecordView; canAsk?: boolean; current?: string; refused?: boolean }, string]
const cutOff = "there:Update Mousse on Laptop to use it from here."
const rows: Row[] = [
  ['not behind', { ...base, olderThanThis: false, update: takes }, { canAsk: true }, 'none'],
  ['no device', undefined, { canAsk: true }, 'none'],
  ['installed over SSH from here', { ...base, update: cannot }, { record: managed, canAsk: true }, 'ssh'],
  ['takes requests', { ...base, update: takes }, { canAsk: true }, 'request'],
  ['takes requests, but only uses this computer', { ...base, update: takes }, { canAsk: false }, 'there:Update Mousse on Laptop.'],
  ['takes requests, this build has no release', { ...base, update: takes }, { canAsk: true, current: '' }, 'there:Update Mousse on Laptop.'],
  ['offline', { ...base, state: 'closed' as never, update: takes }, { canAsk: true }, "there:Offline. Update it here once it's back, or on Laptop."],
  ["offline, said it can't update itself", { ...base, state: 'closed' as never, update: cannot }, { canAsk: true }, "there:It can't update itself: Updates on macOS need a signed build. Update it on Laptop."],
  ['offline, too old to report', { ...base, state: 'closed' as never }, { canAsk: true }, 'there:Its Mousse is too old to update from here. Update it on Laptop once.'],
  ['too old to report', { ...base }, { canAsk: true }, 'there+check:Its Mousse is too old to update from here. Update it on Laptop once.'],
  ["can't update itself", { ...base, update: cannot }, { canAsk: true }, "there:It can't update itself: Updates on macOS need a signed build. Update it on Laptop."],
  ['app not open', { ...base, update: selfOnly }, { canAsk: true }, 'there+check:Open Mousse on Laptop to update it from here.'],
  // Refused for its version (pair-with-IP design §5): the refusal selects the way, whatever the version says. Nothing
  // reaches its app from here, so it is never asked.
  ['refused, a nightly on another channel', { ...base, olderThanThis: false, otherChannel: true, state: 'closed' as never }, { refused: true, canAsk: true }, cutOff],
  ['refused, on another channel, installed over SSH from here', { ...base, olderThanThis: false, otherChannel: true }, { refused: true, record: managed }, 'ssh'],
  ['refused, no version known', undefined, { refused: true, canAsk: true }, cutOff],
  ['refused, takes requests', { ...base, update: takes }, { refused: true, canAsk: true }, cutOff],
  ['refused, installed over SSH by someone else', { ...base }, { refused: true, record: { id: 'ssh2', owner: 'external' } as SshRecordView }, cutOff]
]

describe('computerUpdateWay', () => {
  it.each(rows)('%s', (_label, device, options, expected) => {
    const way = computerUpdateWay(device as never, { name: 'Laptop', current: '0.9.2', ...options })
    const got = !way
      ? 'none'
      : way.kind === 'there'
        ? `there${way.check ? '+check' : ''}:${way.hint}`
        : way.kind
    expect(got).toBe(expected)
  })

  // The few words the update list shows for each way it can't update from here.
  const reasons: Array<[string, string]> = [
    ['takes requests, but only uses this computer', 'Paired one way'],
    ['takes requests, this build has no release', 'Update it there'],
    ['offline', 'Offline'],
    ["offline, said it can't update itself", 'Updates on macOS need a signed build'],
    ['too old to report', 'Too old to update from here'],
    ['app not open', "Mousse isn't open there"],
    ['refused, a nightly on another channel', 'Needs update']
  ]
  it.each(reasons)('%s: %s', (label, reason) => {
    const [, device, options] = rows.find(([name]) => name === label)!
    const way = computerUpdateWay(device as never, { name: 'Laptop', current: '0.9.2', ...options })
    expect(way?.kind === 'there' ? way.reason : way?.kind).toBe(reason)
  })
})
