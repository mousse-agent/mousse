/**
 * The bot engine's internet check (docs/bots.md, "No internet"): the provider's API host and two
 * well-known hosts, any one is enough; a local provider is never checked; results are reused for
 * a few seconds; and which run errors are connection failures.
 */
import { createServer, type AddressInfo, type LookupFunction } from 'node:net'
import { describe, expect, it } from 'vitest'
import { GENERIC_PROBE_HOSTS, botApiHost, createBotConnectivity, isConnectionFailure, probeHost } from '../../src/mms/bots/activation/connectivity'

describe('the internet check', () => {
  const setup = (answers: Record<string, boolean>) => {
    const probed: string[] = []
    const clock = { now: 0 }
    const connectivity = createBotConnectivity({
      apiHost: (instanceId) => (instanceId === 'claude' ? 'api.anthropic.com' : instanceId === 'pi:ollama' ? 'local' : undefined),
      probe: async (host) => {
        probed.push(host)
        return answers[host] ?? false
      },
      now: () => clock.now
    })
    return { connectivity, probed, clock }
  }

  it('checks the provider\'s host and the generic hosts; any one answering is online', async () => {
    const { connectivity, probed } = setup({ 'cloudflare.com': true })
    expect(await connectivity.online({ instanceId: 'claude' })).toBe(true)
    expect(probed).toEqual(['api.anthropic.com', ...GENERIC_PROBE_HOSTS])
  })

  it('is offline when nothing answers, and reuses a result for a few seconds', async () => {
    const { connectivity, probed, clock } = setup({})
    expect(await connectivity.online({ instanceId: 'claude' })).toBe(false)
    expect(await connectivity.online({ instanceId: 'claude' })).toBe(false)
    expect(probed).toHaveLength(3)
    clock.now += 10_000
    await connectivity.online({ instanceId: 'claude' })
    expect(probed).toHaveLength(6)
  })

  it('never checks a provider on this computer, and checks only the generic hosts for an unknown one', async () => {
    const { connectivity, probed } = setup({})
    expect(await connectivity.online({ instanceId: 'pi:ollama' })).toBe(true)
    expect(probed).toEqual([])
    await connectivity.online({ instanceId: 'pi:custom' })
    expect(probed).toEqual([...GENERIC_PROBE_HOSTS])
  })

  it('knows the API hosts of the runtimes that hold bots', () => {
    expect(botApiHost('claude')).toBe('api.anthropic.com')
    expect(botApiHost('codex')).toBe('chatgpt.com')
    expect(botApiHost('pi', 'openrouter')).toBe('openrouter.ai')
    expect(botApiHost('pi', 'ollama')).toBe('local')
    expect(botApiHost('pi', 'someone-else')).toBeUndefined()
  })
})

describe('one host\'s probe', () => {
  /** A name that resolves to an IPv6 address with no route first (100::/64 discards), then to this computer. */
  const ipv6First: LookupFunction = (_hostname, _options, callback) => {
    (callback as (error: null, addresses: Array<{ address: string; family: number }>) => void)(null, [
      { address: '100::1', family: 6 },
      { address: '127.0.0.1', family: 4 }
    ])
  }

  it('is online over IPv4 when the first address the name resolves to is IPv6 that does not route', async () => {
    const server = createServer((socket) => socket.destroy())
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const { port } = server.address() as AddressInfo
      expect(await probeHost('api.example.test', 4_000, { port, lookup: ipv6First })).toBe(true)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('is offline when nothing answers', async () => {
    const server = createServer()
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    await new Promise<void>((resolve) => server.close(() => resolve()))
    expect(await probeHost('api.example.test', 4_000, { port, lookup: ipv6First })).toBe(false)
  })
})

describe('connection failures', () => {
  it('are the provider being unreachable, not its other errors', () => {
    for (const error of ['[provider_unavailable] The provider is temporarily unavailable. Please try again.', 'getaddrinfo ENOTFOUND api.anthropic.com', 'API Error: Connection error.', 'connect ECONNREFUSED 1.2.3.4:443', 'fetch failed'])
      expect(isConnectionFailure(error)).toBe(true)
    for (const error of ['[provider_auth_invalid] Sign in again.', 'provider_usage_limit', '', undefined])
      expect(isConnectionFailure(error)).toBe(false)
  })
})
