import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_MOUSSE_ID_ORIGIN } from '../../src/renderer/lib/plusSignIn'
import { mousseIdAvailable } from '../../src/renderer/stores/mousseIdStore'
import { readDevices } from '../../src/renderer/lib/netDevices'

describe('Mousse ID switch', () => {
  it('has no service address unless the build sets one', () => {
    // Vitest builds without MOUSSE_ID_ORIGIN, like an open-source build.
    expect(DEFAULT_MOUSSE_ID_ORIGIN).toBe('')
    expect(mousseIdAvailable({ runtimeOrigin: '' })).toBe(false)
  })

  it('turns on with a usable launch-time address only', () => {
    expect(mousseIdAvailable({ runtimeOrigin: 'https://id.example' })).toBe(true)
    expect(mousseIdAvailable({ runtimeOrigin: 'http://127.0.0.1:8787' })).toBe(true)
    expect(mousseIdAvailable({ runtimeOrigin: 'http://id.example' })).toBe(false)
    expect(mousseIdAvailable({ runtimeOrigin: 'https://id.example/path' })).toBe(false)
    expect(mousseIdAvailable({ runtimeOrigin: '   ' })).toBe(false)
  })
})

describe('Devices loading', () => {
  const original = (globalThis as { window?: unknown }).window
  afterEach(() => {
    ;(globalThis as { window?: unknown }).window = original
  })

  function stub(responses: Record<string, () => Promise<unknown>>) {
    const request = vi.fn((method: string) => {
      const respond = responses[method]
      return respond ? respond() : Promise.reject(new Error(`unexpected ${method}`))
    })
    ;(globalThis as { window?: unknown }).window = { mousse: { platformRequest: { request } } }
    return request
  }
  const ready = {
    'net.status': async () => ({ enabled: true, self: { node: 'n' }, keystore: 'unlocked', routes: [], peers: [] }),
    'net.transport.list': async () => ({ manifests: [{ id: 'direct' }, { id: 'plus-relay' }] }),
    'bridge.nodes': async () => ({ nodes: [{ node: 'n', name: 'This computer' }] })
  }

  it('never asks for Mousse ID status when the build has no service', async () => {
    const request = stub(ready)
    const result = await readDevices(false)
    expect(request.mock.calls.map(([method]) => method)).not.toContain('net.plus.status')
    expect(result.hosted).toBeUndefined()
    expect(result.addons.manifests.map((row) => row.id)).toEqual(['direct'])
    expect(result.nodes).toHaveLength(1)
  })

  it('still loads devices when Mousse ID status fails', async () => {
    stub({ ...ready, 'net.plus.status': async () => Promise.reject(new Error('unavailable')) })
    const result = await readDevices(true)
    expect(result.hosted).toBeUndefined()
    expect(result.addons.manifests.map((row) => row.id)).toEqual(['direct', 'plus-relay'])
    expect(result.nodes).toHaveLength(1)
  })

  it('keeps what add-on actions changed when the build has no Mousse ID service', async () => {
    const record = { action: 'serve', appliedAt: 1, record: { servePort: 47890, port: 47891, state: 'applied' } }
    stub({
      ...ready,
      'net.transport.list': async () => ({
        manifests: [{ id: 'tailscale' }, { id: 'plus-relay' }],
        records: { tailscale: record },
        settings: { tailscale: { binary: '/opt/tailscale' } }
      })
    })
    const result = await readDevices(false)
    expect(result.addons.manifests.map((row) => row.id)).toEqual(['tailscale'])
    expect(result.addons.records).toEqual({ tailscale: record })
    expect(result.addons.settings).toEqual({ tailscale: { binary: '/opt/tailscale' } })
  })

  it('still lists what add-on actions changed while networking is off', async () => {
    const record = { action: 'serve', appliedAt: 1, record: { servePort: 47890, port: 47891, state: 'applied' } }
    stub({
      'net.status': async () => ({ enabled: false, routes: [], peers: [] }),
      'net.transport.list': async () => ({ manifests: [{ id: 'tailscale' }], records: { tailscale: record } })
    })
    expect((await readDevices(false)).addons.records).toEqual({ tailscale: record })
  })

  it('shows no add-on changes when the service cannot list them while networking is off', async () => {
    stub({ 'net.status': async () => ({ enabled: false, routes: [], peers: [] }) })
    expect((await readDevices(false)).addons).toEqual({ manifests: [], records: {}, settings: {} })
  })

  it('returns Mousse ID status when the service is set', async () => {
    stub({ ...ready, 'net.plus.status': async () => ({ configured: true, connected: true }) })
    expect((await readDevices(true)).hosted).toEqual({ configured: true, connected: true })
  })
})
