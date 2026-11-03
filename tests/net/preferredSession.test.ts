import { expect, it } from 'vitest'
import { preferredSession } from '../../src/mms/net/NetService'

const session = (node: string, transport: string | undefined, state = 'open') => ({
  state: () => state as 'open',
  peer: { node } as never,
  transport
})
const pick = (rows: ReturnType<typeof session>[], node = 'nod_mac') =>
  preferredSession(rows, node as never, (row) => row.transport)

it('uses a direct session with a computer over a relayed one, whichever side dialed first', () => {
  const relayed = session('nod_mac', 'plus-relay'),
    direct = session('nod_mac', 'direct')
  expect(pick([relayed, direct])).toBe(direct)
  expect(pick([direct, relayed])).toBe(direct)
  expect(pick([session('nod_mac', 'relay'), session('nod_mac', 'tailscale')])?.transport).toBe('tailscale')
})

it('falls back to the relay, and ignores sessions that are not open or are with another device', () => {
  const relayed = session('nod_mac', 'plus-relay')
  expect(pick([session('nod_mac', 'direct', 'closed'), session('nod_other', 'direct'), relayed])).toBe(relayed)
  expect(pick([session('nod_other', 'direct')])).toBeUndefined()
})
