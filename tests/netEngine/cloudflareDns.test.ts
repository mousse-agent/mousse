import { expect, it, vi } from 'vitest'
import { waitForCloudflareDns } from '../../src/mms/netEngine/cloudflare/dns'

const fixture = vi.hoisted(() => ({
  resolveNs: vi.fn(), resolve4: vi.fn(), resolve6: vi.fn(), setServers: vi.fn(), cancel: vi.fn()
}))

vi.mock('node:dns/promises', () => ({
  Resolver: class {
    resolveNs = fixture.resolveNs
    resolve4 = fixture.resolve4
    resolve6 = fixture.resolve6
    setServers = fixture.setServers
    cancel = fixture.cancel
  }
}))

it('waits at the authority while the new name is missing', async () => {
  const hostname = 'mousse-abc.example.net'
  const authority = 'test.ns.cloudflare.com'
  const missing = Object.assign(new Error('not found'), { code: 'ENOTFOUND' })
  let usingAuthority = false
  let lookups = 0
  fixture.resolveNs.mockResolvedValue([authority])
  fixture.setServers.mockImplementation((addresses) => {
    usingAuthority = addresses[0] === '192.0.2.53'
  })
  fixture.resolve4.mockImplementation(async (name: string) => {
    if (name === authority) return ['192.0.2.53']
    expect(name).toBe(hostname)
    expect(usingAuthority).toBe(true)
    if (++lookups === 1) throw missing
    return ['192.0.2.1']
  })
  fixture.resolve6.mockRejectedValue(missing)

  await waitForCloudflareDns(hostname, new AbortController().signal)
  expect(lookups).toBe(2)
})
