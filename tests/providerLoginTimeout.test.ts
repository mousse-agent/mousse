import { afterEach, expect, it, vi } from 'vitest'
import { LocalMmsClient } from '../src/mms/protocol/client'

afterEach(() => vi.useRealTimers())

it('keeps interactive login pending past the ordinary timeout and accepts its response', async () => {
  vi.useFakeTimers()
  const client = new LocalMmsClient({ homeDir: '.', ownerToken: 'test' })
  const transport = client as unknown as {
    _connected: boolean
    socket: unknown
    pending: Map<string, { resolve(value: unknown): void }>
  }
  transport._connected = true
  transport.socket = { destroyed: false, write: vi.fn() }
  const login = client.request('providers.loginOAuth', { providerId: 'example' })
  const ordinary = client.request('providers.list').catch((error: Error) => error.message)
  await vi.advanceTimersByTimeAsync(61_000)
  expect(await ordinary).toBe('Request timeout: providers.list')
  expect(transport.pending.size).toBe(1)
  const response = { result: { success: true } }
  transport.pending.values().next().value!.resolve(response)
  await expect(login).resolves.toEqual(response)
})

it('keeps the Antigravity download pending past the login timeout', async () => {
  vi.useFakeTimers()
  const client = new LocalMmsClient({ homeDir: '.', ownerToken: 'test' })
  const transport = client as unknown as { _connected: boolean; socket: unknown; pending: Map<string, { resolve(value: unknown): void }> }
  transport._connected = true
  transport.socket = { destroyed: false, write: vi.fn() }
  const install = client.request('providers.installAntigravity', {})
  await vi.advanceTimersByTimeAsync(20 * 60_000)
  expect(transport.pending.size).toBe(1)
  const response = { config: {} }
  transport.pending.values().next().value!.resolve(response)
  await expect(install).resolves.toEqual(response)
})
