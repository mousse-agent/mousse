import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  cappedFetch,
  proxyClaudeAccount,
  checkProxyKey,
  claudeProxyAccounts,
  detectCliProxy,
  isLocalHost,
  localProxyOrigin,
  LOCAL_PROXY_SOURCE,
  PROXY_LIMITS_UNAVAILABLE,
  proxyApiCallBody,
  proxyClaudeWindows,
  readLocalProxyClaudeUsage,
  readLocalProxyClaudeAccount,
  previewLocalProxyClaudeAccounts,
  observedClaudeLimits,
  resetLocalProxyDetection,
  ACCOUNT_READ_REUSE_MS,
  MODEL_LIMITS_REUSE_MS,
  OBSERVED_FRESH_MS,
  RATE_LIMIT_WAIT_MS,
  type ProxyFetch
} from '../src/mms/harness/vendors/claude/localProxyUsage'

/**
 * Claude limits through a local CLI-to-API proxy (CLIProxyAPI): found only on this computer or the
 * private network, recognised by its root reply, read through its management API with the key the
 * user set. Every request here goes to a fake: no network.
 */

const ROOT = { message: 'CLI Proxy API Server', endpoints: ['POST /v1/chat/completions', 'POST /v1/completions', 'GET /v1/models'] }
// `GET /v0/management/auth-files`, trimmed: one Claude sign-in and one Codex.
const AUTH_FILES = {
  files: [
    { id: 'claude-me.json', name: 'claude-me.json', provider: 'claude', type: 'claude', email: 'me@example.com', auth_index: 'a1b2', disabled: false },
    { id: 'codex-me.json', name: 'codex-me.json', provider: 'codex', type: 'codex', email: 'me@example.com', auth_index: 'c3d4' }
  ]
}
// Anthropic's account usage as the proxy relays it (`api-call`): the upstream body is a string.
const CLAUDE_USAGE = {
  five_hour: { utilization: 37, resets_at: '2026-11-08T17:00:00Z' },
  seven_day: { utilization: 12.5, resets_at: '2026-11-12T09:00:00Z' },
  seven_day_opus: null,
  extra_usage: { is_enabled: false, utilization: null }
}
const apiCall = (status: number, body: unknown) => ({ status_code: status, header: { 'Content-Type': ['application/json'] }, body: JSON.stringify(body) })

interface Route { status: number; body: unknown }
function fakeFetch(routes: Record<string, Route | (() => Route) | 'hang'>) {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body?: string; redirect: string }> = []
  const fetch: ProxyFetch = vi.fn(async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, ...(init.body ? { body: init.body } : {}), redirect: init.redirect })
    const route = routes[`${init.method} ${url}`]
    if (route === 'hang') return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))))
    const answer = typeof route === 'function' ? route() : route ?? { status: 404, body: { error: 'not found' } }
    return { status: answer.status, text: async () => (typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body)) }
  })
  return { fetch, calls }
}

const proxy = (origin = 'http://127.0.0.1:8317') => ({
  [`GET ${origin}/`]: { status: 200, body: ROOT },
  [`GET ${origin}/v0/management/auth-files`]: { status: 200, body: AUTH_FILES },
  [`POST ${origin}/v0/management/api-call`]: { status: 200, body: apiCall(200, CLAUDE_USAGE) }
})

afterEach(() => resetLocalProxyDetection())

describe('which addresses may be a local proxy', () => {
  it.each(['localhost', '127.0.0.1', '127.8.9.1', '10.0.0.5', '172.16.0.1', '172.31.255.255', '192.168.1.20', '169.254.10.1', '100.64.0.1', '100.101.102.103', '100.127.255.254', '[::1]', '::1', 'fd12:3456::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:c0a8:114'])('%s is local', (host) => {
    expect(isLocalHost(host)).toBe(true)
  })
  it.each(['api.anthropic.com', 'example.com', '8.8.8.8', '172.32.0.1', '100.63.255.255', '100.128.0.1', '192.169.0.1', '11.0.0.1', '2001:db8::1', 'localhost.example.com', '::ffff:8.8.8.8', '::ffff:808:808', 'api.localhost', '127.0.0.1.nip.io', 'proxy.internal', '0.0.0.0', '::'])('%s is not', (host) => {
    expect(isLocalHost(host)).toBe(false)
  })
  it('keeps the origin of an http(s) base URL on a local address only', () => {
    expect(localProxyOrigin('http://127.0.0.1:8317/v1')).toBe('http://127.0.0.1:8317')
    expect(localProxyOrigin(' https://localhost:8317 ')).toBe('https://localhost:8317')
    expect(localProxyOrigin('https://api.anthropic.com')).toBeUndefined()
    expect(localProxyOrigin('ftp://127.0.0.1')).toBeUndefined()
    expect(localProxyOrigin('http://user:pass@127.0.0.1:8317')).toBeUndefined()
    expect(localProxyOrigin('not a url')).toBeUndefined()
    expect(localProxyOrigin(undefined)).toBeUndefined()
  })
  it('judges the address a URL resolves to, never a name a DNS server answers', () => {
    // The URL parser writes these as hex IPv6 or as a plain IPv4 address.
    expect(localProxyOrigin('http://[::ffff:127.0.0.1]:8317')).toBe('http://[::ffff:7f00:1]:8317')
    expect(localProxyOrigin('http://0x7f.1:8317')).toBe('http://127.0.0.1:8317')
    expect(localProxyOrigin('http://[::ffff:8.8.8.8]:8317')).toBeUndefined()
    expect(localProxyOrigin('http://2130706433.example.com')).toBeUndefined()
    expect(localProxyOrigin('http://evil.localhost:8317')).toBeUndefined()
    expect(localProxyOrigin('http://localtest.me:8317')).toBeUndefined()
  })
})

describe('recognising CLIProxyAPI', () => {
  it('its root reply says so', async () => {
    expect(await detectCliProxy('http://127.0.0.1:8317', fakeFetch(proxy()).fetch)).toBe(true)
  })
  it('another server on the same port is not a proxy: other JSON, HTML, an error status', async () => {
    const origin = 'http://127.0.0.1:8317'
    for (const route of [{ status: 200, body: { message: 'hello' } }, { status: 200, body: '<html>dev server</html>' }, { status: 500, body: ROOT }])
      expect(await detectCliProxy(origin, fakeFetch({ [`GET ${origin}/`]: route }).fetch)).toBe(false)
  })
  it('gives up after a short timeout and never follows a redirect', async () => {
    const origin = 'http://127.0.0.1:8317'
    const { fetch, calls } = fakeFetch({ [`GET ${origin}/`]: 'hang' })
    const started = Date.now()
    expect(await detectCliProxy(origin, fetch, { timeoutMs: 30 })).toBe(false)
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(calls[0]!.redirect).toBe('manual')
  })
})

describe('over a real socket', () => {
  const servers: Server[] = []
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise((settle) => server.close(settle))))
  })
  async function serve(handler: Parameters<typeof createServer>[1]): Promise<string> {
    const server = createServer(handler)
    servers.push(server)
    await new Promise<void>((settle) => server.listen(0, '127.0.0.1', settle))
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  }

  it('a redirect is not followed: the key never reaches where it points', async () => {
    let reached = 0
    const elsewhere = await serve((_req, res) => { reached += 1; res.end(JSON.stringify(ROOT)) })
    const origin = await serve((_req, res) => { res.writeHead(302, { Location: `${elsewhere}/` }); res.end() })
    expect(await detectCliProxy(origin, cappedFetch)).toBe(false)
    expect(reached).toBe(0)
  })

  it('stops reading a reply over the size limit', async () => {
    const origin = await serve((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      const chunk = Buffer.alloc(64 * 1024, 32)
      let sent = 0
      const write = () => { while (sent < 64 && res.write(chunk)) sent += 1; if (sent < 64) res.once('drain', write); else res.end() }
      write()
    })
    const reply = await cappedFetch(`${origin}/`, { method: 'GET', headers: {}, signal: AbortSignal.timeout(5_000), redirect: 'manual' })
    await expect(reply.text()).rejects.toThrow(/too large/)
    expect(await detectCliProxy(origin, cappedFetch)).toBe(false)
  })

  it('recognises a real CLIProxyAPI root reply', async () => {
    const origin = await serve((_req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(ROOT)) })
    expect(await detectCliProxy(origin, cappedFetch)).toBe(true)
  })
})

describe('parsing what the proxy returns', () => {
  it('lists its Claude sign-ins, not its other providers', () => {
    expect(claudeProxyAccounts(AUTH_FILES)).toEqual([{ id: 'claude-me.json', authIndex: 'a1b2', label: 'me@example.com', state: 'active' }])
    expect(claudeProxyAccounts({ credentials: [{ type: 'anthropic', auth_index: 7 }] })).toEqual([{ id: '7', authIndex: '7', state: 'active' }])
    expect(claudeProxyAccounts([{ provider: 'claude' }])).toEqual([])
    expect(claudeProxyAccounts({ files: 'nope' })).toEqual([])
    expect(claudeProxyAccounts(null)).toEqual([])
  })
  it('unwraps the upstream reply of an api-call, as text or JSON', () => {
    expect(proxyApiCallBody(apiCall(200, CLAUDE_USAGE))).toEqual({ status: 200, body: CLAUDE_USAGE })
    expect(proxyApiCallBody({ status_code: 401, body: 'unauthorized' })).toEqual({ status: 401, body: undefined })
    expect(proxyApiCallBody({ body: '{}' })).toBeUndefined()
  })
  it("maps Claude's account usage to windows, and names the account when there are several", () => {
    expect(proxyClaudeWindows(CLAUDE_USAGE, { authIndex: 'a1b2', label: 'me@example.com' }, 0, false)).toEqual([
      { id: 'five_hour', label: '5-hour limit', remainingPercent: 63, resetsAt: '2026-11-08T17:00:00Z' },
      { id: 'seven_day', label: 'Weekly limit', remainingPercent: 87.5, resetsAt: '2026-11-12T09:00:00Z' }
    ])
    expect(proxyClaudeWindows(CLAUDE_USAGE, { authIndex: 'x' }, 1, true)[0]).toMatchObject({ id: '1:five_hour', label: '5-hour limit · account 2' })
    expect(proxyClaudeWindows('nope', { authIndex: 'x' }, 0, false)).toEqual([])
  })
})

describe('reading Claude limits through a local proxy', () => {
  const baseUrl = 'http://127.0.0.1:8317'

  it('reads each Claude sign-in through api-call with the management key, labelled with its source', async () => {
    const { fetch, calls } = fakeFetch(proxy())
    const usage = await readLocalProxyClaudeUsage({ baseUrl, managementKey: 'mgmt', fetch })
    expect(usage).toEqual({
      status: 'available',
      source: LOCAL_PROXY_SOURCE,
      proxy: { address: '127.0.0.1:8317', key: 'environment' },
      windows: [
        { id: 'five_hour', label: '5-hour limit', remainingPercent: 63, resetsAt: '2026-11-08T17:00:00Z' },
        { id: 'seven_day', label: 'Weekly limit', remainingPercent: 87.5, resetsAt: '2026-11-12T09:00:00Z' }
      ]
    })
    // The current API first; the older one where it is missing.
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      `GET ${baseUrl}/`,
      `GET ${baseUrl}/v8/management/credentials`,
      `GET ${baseUrl}/v0/management/auth-files`,
      `POST ${baseUrl}/v8/management/requests/api-call`,
      `POST ${baseUrl}/v0/management/api-call`
    ])
    expect(calls.slice(1).every((call) => call.headers.Authorization === 'Bearer mgmt' && call.redirect === 'manual')).toBe(true)
    expect(calls[0]!.headers.Authorization).toBeUndefined()
    // The proxy fills in its own credential: Mousse sends only the placeholder.
    expect(JSON.parse(calls.at(-1)!.body!)).toMatchObject({ auth_index: 'a1b2', method: 'GET', url: 'https://api.anthropic.com/api/oauth/usage', header: { Authorization: 'Bearer $TOKEN$' } })
  })

  it('no request at all for an address that is not local', async () => {
    const { fetch } = fakeFetch({})
    expect(await readLocalProxyClaudeUsage({ baseUrl: 'https://api.anthropic.com', managementKey: 'mgmt', fetch })).toBeUndefined()
    expect(await readLocalProxyClaudeUsage({ baseUrl: undefined, managementKey: 'mgmt', fetch })).toBeUndefined()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('a local server that is not a proxy leaves the answer to the caller, and gets no key', async () => {
    const { fetch, calls } = fakeFetch({ [`GET ${baseUrl}/`]: { status: 200, body: { message: 'vite' } } })
    expect(await readLocalProxyClaudeUsage({ baseUrl, managementKey: 'mgmt', fetch })).toBeUndefined()
    expect(calls).toHaveLength(1)
    expect(calls[0]!.headers.Authorization).toBeUndefined()
  })

  it('without a key, or when the proxy refuses or has no numbers, says limits are unavailable (proxy)', async () => {
    const proxyState = { address: '127.0.0.1:8317', key: 'environment' }
    const unavailable = { status: 'unavailable', windows: [], source: LOCAL_PROXY_SOURCE, message: PROXY_LIMITS_UNAVAILABLE, proxy: proxyState }
    const noKey = await readLocalProxyClaudeUsage({ baseUrl, managementKey: undefined, fetch: fakeFetch(proxy()).fetch })
    expect(noKey?.proxy).toEqual({ address: '127.0.0.1:8317', key: 'none' })
    expect(noKey).toMatchObject({ status: 'unavailable', message: expect.stringMatching(/^Limits unavailable \(proxy\)\. Set CLIPROXY_MANAGEMENT_KEY/) })
    resetLocalProxyDetection()
    const refused = await readLocalProxyClaudeUsage({ baseUrl, managementKey: 'wrong', fetch: fakeFetch({ ...proxy(), [`GET ${baseUrl}/v0/management/auth-files`]: { status: 401, body: { error: 'invalid management key' } } }).fetch })
    expect(refused).toEqual({ ...unavailable, proxy: { ...proxyState, problem: 'rejected' } })
    resetLocalProxyDetection()
    const noClaude = await readLocalProxyClaudeUsage({ baseUrl, managementKey: 'mgmt', fetch: fakeFetch({ ...proxy(), [`GET ${baseUrl}/v0/management/auth-files`]: { status: 200, body: { files: [] } } }).fetch })
    expect(noClaude).toEqual(unavailable)
    resetLocalProxyDetection()
    const upstreamFailed = await readLocalProxyClaudeUsage({ baseUrl, managementKey: 'mgmt', fetch: fakeFetch({ ...proxy(), [`POST ${baseUrl}/v0/management/api-call`]: { status: 200, body: apiCall(429, { error: 'rate limited' }) } }).fetch })
    expect(upstreamFailed).toEqual(unavailable)
    resetLocalProxyDetection()
    const hung = await readLocalProxyClaudeUsage({ baseUrl, managementKey: 'mgmt', timeouts: { readMs: 20 }, fetch: fakeFetch({ ...proxy(), [`GET ${baseUrl}/v8/management/credentials`]: 'hang' }).fetch })
    expect(hung).toEqual({ ...unavailable, proxy: { ...proxyState, problem: 'unreachable' } })
  })

  it('says where the key came from: a saved key reads as saved', async () => {
    const usage = await readLocalProxyClaudeUsage({ baseUrl, managementKey: 'mgmt', keySource: 'saved', fetch: fakeFetch(proxy()).fetch })
    expect(usage?.proxy).toEqual({ address: '127.0.0.1:8317', key: 'saved' })
  })
})

describe('several Claude sign-ins through the proxy', () => {
  const baseUrl = 'http://127.0.0.1:8317'
  const two = { files: [
    { provider: 'claude', email: 'me@example.com', auth_index: 'a1' },
    { provider: 'claude', email: 'work@example.com', auth_index: 'b2' }
  ] }

  it('gives each account its own group, and an expired sign-in says so in its own group', async () => {
    let call = 0
    const { fetch } = fakeFetch({
      ...proxy(),
      [`GET ${baseUrl}/v0/management/auth-files`]: { status: 200, body: two },
      [`POST ${baseUrl}/v0/management/api-call`]: () => (call++ === 0 ? { status: 200, body: apiCall(200, CLAUDE_USAGE) } : { status: 200, body: apiCall(401, { error: 'expired' }) })
    })
    const usage = await readLocalProxyClaudeUsage({ baseUrl, managementKey: 'mgmt', fetch })
    expect(usage?.status).toBe('available')
    expect(usage?.accounts).toEqual([
      { id: 'a1', label: 'me@example.com', windows: [
        { id: 'five_hour', label: '5-hour limit', remainingPercent: 63, resetsAt: '2026-11-08T17:00:00Z' },
        { id: 'seven_day', label: 'Weekly limit', remainingPercent: 87.5, resetsAt: '2026-11-12T09:00:00Z' }
      ] },
      { id: 'b2', label: 'work@example.com', windows: [], problem: 'Sign-in expired' }
    ])
  })

  it('one account has no groups, only its windows', async () => {
    const usage = await readLocalProxyClaudeUsage({ baseUrl, managementKey: 'mgmt', fetch: fakeFetch(proxy()).fetch })
    expect(usage?.accounts).toBeUndefined()
    expect(usage?.windows).toHaveLength(2)
  })

  it('names a group by the proxy label, or by its place when the proxy gives none', () => {
    const active = { id: 'x', authIndex: 'x', state: 'active' as const }
    expect(proxyClaudeAccount(active, 2, { status: 200, body: {} })).toEqual({ id: 'x', label: 'Account 3', windows: [], problem: 'No limits reported' })
    expect(proxyClaudeAccount({ ...active, label: 'Team' }, 0, undefined).problem).toBe('Not reachable')
    expect(proxyClaudeAccount(active, 0, { status: 500, body: undefined }).problem).toBe("Couldn't read limits")
  })

  // Five Claude entries as the proxy lists them: two working sign-ins, one whose usage call fails, one
  // disabled in the proxy, one API key; plus a true duplicate (same credential id) and a Codex sign-in.
  const FIVE = { files: [
    { id: 'claude-1.json', provider: 'claude', type: 'claude', account_type: 'oauth', email: 'one@example.com', auth_index: 'i1', disabled: false, status: 'active' },
    { id: 'claude-2.json', provider: 'claude', type: 'claude', account_type: 'oauth', email: 'two@example.com', auth_index: 'i2', disabled: false, status: 'active' },
    { id: 'claude-3.json', provider: 'claude', type: 'claude', account_type: 'oauth', email: 'three@example.com', auth_index: 'i3', disabled: false, status: 'active' },
    { id: 'claude-4.json', provider: 'claude', type: 'claude', account_type: 'oauth', email: 'two@example.com', auth_index: 'i4', disabled: true, status: 'disabled' },
    { id: 'claude-key', provider: 'claude', type: 'claude', account_type: 'api_key', label: 'Team key', auth_index: 'i5', status: 'active' },
    { id: 'claude-1.json', provider: 'claude', type: 'claude', account_type: 'oauth', email: 'one@example.com', auth_index: 'i1' },
    { id: 'codex-1.json', provider: 'codex', type: 'codex', email: 'one@example.com', auth_index: 'c1' }
  ] }

  it('lists every Claude entry once by credential id: the same email twice is two accounts', () => {
    expect(claudeProxyAccounts(FIVE).map((account) => [account.id, account.state])).toEqual([
      ['claude-1.json', 'active'], ['claude-2.json', 'active'], ['claude-3.json', 'active'], ['claude-4.json', 'disabled'], ['claude-key', 'api_key']
    ])
  })

  it('shows all five: limits for the working ones, the failing one with its error, disabled and API key as such, and asks only the active ones', async () => {
    const usageFor = new Map([['i1', apiCall(200, CLAUDE_USAGE)], ['i2', apiCall(200, CLAUDE_USAGE)], ['i3', apiCall(401, { error: 'expired' })]])
    const asked: string[] = []
    const fetch: ProxyFetch = vi.fn(async (url, init) => {
      if (url === `${baseUrl}/`) return { status: 200, text: async () => JSON.stringify(ROOT) }
      if (url.endsWith('/v0/management/auth-files')) return { status: 200, text: async () => JSON.stringify(FIVE) }
      if (url.endsWith('/v0/management/api-call')) {
        const index = (JSON.parse(init.body!) as { auth_index: string }).auth_index
        asked.push(index)
        return { status: 200, text: async () => JSON.stringify(usageFor.get(index)) }
      }
      return { status: 404, text: async () => '{}' }
    })
    const usage = await readLocalProxyClaudeUsage({ baseUrl, managementKey: 'mgmt', fetch })
    expect(asked).toEqual(['i1', 'i2', 'i3'])
    expect(usage?.accounts?.map((account) => [account.id, account.windows.length, account.problem])).toEqual([
      ['claude-1.json', 2, undefined],
      ['claude-2.json', 2, undefined],
      ['claude-3.json', 0, 'Sign-in expired'],
      ['claude-4.json', 0, 'Disabled in proxy'],
      ['claude-key', 0, 'API key · no plan limits']
    ])
  })
})

describe('checking a proxy key before it is saved', () => {
  const baseUrl = 'http://127.0.0.1:8317'

  it('one management call: ok on 200, rejected on 401 or 403, and the key goes to that proxy only', async () => {
    const accepted = fakeFetch(proxy())
    expect(await checkProxyKey({ baseUrl, key: ' mgmt ', fetch: accepted.fetch })).toEqual({ ok: true })
    expect(accepted.calls.every((call) => call.url.startsWith(baseUrl) && call.redirect === 'manual')).toBe(true)
    expect(accepted.calls.find((call) => call.headers.Authorization)?.headers.Authorization).toBe('Bearer mgmt')
    for (const status of [401, 403]) {
      resetLocalProxyDetection()
      expect(await checkProxyKey({ baseUrl, key: 'wrong', fetch: fakeFetch({ ...proxy(), [`GET ${baseUrl}/v0/management/auth-files`]: { status, body: {} } }).fetch })).toEqual({ ok: false, reason: 'rejected' })
    }
  })

  it('a proxy that does not answer is unreachable; an address that is not a local proxy gets nothing', async () => {
    expect(await checkProxyKey({ baseUrl, key: 'mgmt', timeoutMs: 20, fetch: fakeFetch({ ...proxy(), [`GET ${baseUrl}/v8/management/credentials`]: 'hang' }).fetch })).toEqual({ ok: false, reason: 'unreachable' })
    resetLocalProxyDetection()
    expect(await checkProxyKey({ baseUrl, key: 'mgmt', fetch: fakeFetch({ ...proxy(), [`GET ${baseUrl}/v0/management/auth-files`]: { status: 500, body: {} } }).fetch })).toEqual({ ok: false, reason: 'unreachable' })
    const remote = fakeFetch({})
    expect(await checkProxyKey({ baseUrl: 'https://api.anthropic.com', key: 'mgmt', fetch: remote.fetch })).toEqual({ ok: false, reason: 'no_proxy' })
    expect(remote.fetch).not.toHaveBeenCalled()
    resetLocalProxyDetection()
    const notProxy = fakeFetch({ [`GET ${baseUrl}/`]: { status: 200, body: { message: 'vite' } } })
    expect(await checkProxyKey({ baseUrl, key: 'mgmt', fetch: notProxy.fetch })).toEqual({ ok: false, reason: 'no_proxy' })
    expect(notProxy.calls.some((call) => call.headers.Authorization)).toBe(false)
  })

  it('the whole read ends within its total limit, however many sign-ins the proxy has', async () => {
    const many = { files: [1, 2, 3, 4].map((n) => ({ provider: 'claude', email: `u${n}@example.com`, auth_index: `i${n}` })) }
    const { fetch } = fakeFetch({ ...proxy(), [`GET ${baseUrl}/v0/management/auth-files`]: { status: 200, body: many }, [`POST ${baseUrl}/v0/management/api-call`]: 'hang' })
    const started = Date.now()
    const usage = await readLocalProxyClaudeUsage({ baseUrl, managementKey: 'mgmt', fetch, timeouts: { readMs: 5_000, totalMs: 50 } })
    expect(usage).toMatchObject({ status: 'unavailable', source: LOCAL_PROXY_SOURCE })
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it('a read the caller already gave up on sends nothing and is not remembered', async () => {
    const { fetch, calls } = fakeFetch(proxy())
    const aborted = AbortSignal.abort()
    expect(await readLocalProxyClaudeUsage({ baseUrl, managementKey: 'mgmt', fetch, signal: aborted })).toBeUndefined()
    expect(calls).toHaveLength(0)
    await readLocalProxyClaudeUsage({ baseUrl, managementKey: 'mgmt', fetch })
    expect(calls.filter((call) => call.url === `${baseUrl}/`)).toHaveLength(1)
  })

  it('remembers a detection for a minute, so a refresh does not ask again', async () => {
    let now = 0
    const { fetch, calls } = fakeFetch(proxy())
    await readLocalProxyClaudeUsage({ baseUrl, managementKey: 'mgmt', fetch, now: () => now })
    now = 30_000
    await readLocalProxyClaudeUsage({ baseUrl, managementKey: 'mgmt', fetch, now: () => now })
    expect(calls.filter((call) => call.url === `${baseUrl}/`)).toHaveLength(1)
    now = 61_000
    await readLocalProxyClaudeUsage({ baseUrl, managementKey: 'mgmt', fetch, now: () => now })
    expect(calls.filter((call) => call.url === `${baseUrl}/`)).toHaveLength(2)
  })
})

describe('fewer requests: the limits the proxy already lists', () => {
  const baseUrl = 'http://127.0.0.1:8317'
  const NOW = Date.parse('2026-11-09T12:00:00Z')
  const seconds = (iso: string) => String(Date.parse(iso) / 1000)
  // `quota` on a listing entry, as CLIProxyAPI writes it from the last reply the sign-in served.
  const quota = (observedAt: string, five = '0.37', seven = '0.125') => ({
    observed_at: observedAt,
    signals: {
      'Anthropic-Ratelimit-Unified-Status': 'allowed',
      'Anthropic-Ratelimit-Unified-5h-Utilization': five,
      'Anthropic-Ratelimit-Unified-5h-Reset': seconds('2026-11-09T14:00:00Z'),
      'Anthropic-Ratelimit-Unified-7d-Utilization': seven,
      'Anthropic-Ratelimit-Unified-7d-Reset': seconds('2026-11-12T09:00:00Z')
    }
  })
  const RECENT = '2026-11-09T11:55:00Z'
  const WINDOWS = [
    { id: 'five_hour', label: '5-hour limit', remainingPercent: 63, resetsAt: '2026-11-09T14:00:00.000Z' },
    { id: 'seven_day', label: 'Weekly limit', remainingPercent: 87.5, resetsAt: '2026-11-12T09:00:00.000Z' }
  ]

  /** A proxy whose listing is `files` and whose `api-call` answers `usage(authIndex)`; counts every request. */
  function fakeProxy(files: unknown[], usage: (authIndex: string) => unknown = () => apiCall(200, CLAUDE_USAGE)) {
    const asked: string[] = []
    let listed = 0
    let hold: Promise<void> | undefined
    const fetch: ProxyFetch = vi.fn(async (url, init) => {
      if (url === `${baseUrl}/`) return { status: 200, text: async () => JSON.stringify(ROOT) }
      if (url === `${baseUrl}/v8/management/credentials`) {
        listed++
        return { status: 200, text: async () => JSON.stringify({ files }) }
      }
      if (url === `${baseUrl}/v8/management/requests/api-call`) {
        const index = (JSON.parse(init.body!) as { auth_index: string }).auth_index
        asked.push(index)
        if (hold) await hold
        return { status: 200, text: async () => JSON.stringify(usage(index)) }
      }
      return { status: 404, text: async () => '{}' }
    })
    return { fetch, asked, listings: () => listed, holdReads: (until: Promise<void>) => { hold = until } }
  }
  const read = (fetch: ProxyFetch, at: number, extra: object = {}) => readLocalProxyClaudeUsage({ baseUrl, managementKey: 'mgmt', fetch, now: () => at, ...extra })

  // A sign-in's own read: the listing has no weekly limit per model, this has Fable's.
  const MODEL_USAGE = { ...CLAUDE_USAGE, seven_day_fable: { utilization: 40, resets_at: '2026-11-12T09:00:00Z' } }
  const FABLE = { id: 'seven_day_fable', label: 'Weekly · Fable', remainingPercent: 60, resetsAt: '2026-11-12T09:00:00Z' }
  const DIRECT = [
    { id: 'five_hour', label: '5-hour limit', remainingPercent: 63, resetsAt: '2026-11-08T17:00:00Z' },
    { id: 'seven_day', label: 'Weekly limit', remainingPercent: 87.5, resetsAt: '2026-11-12T09:00:00Z' },
    FABLE
  ]

  it('a sign-in with recent listed limits is read once a quarter hour for its model limits; the listing updates the 5-hour and weekly ones in between', async () => {
    const files = [
      { id: 'one.json', provider: 'claude', email: 'one@example.com', auth_index: 'i1', quota: quota(RECENT) },
      { id: 'two.json', provider: 'claude', email: 'two@example.com', auth_index: 'i2', quota: quota(RECENT) }
    ]
    const proxyFake = fakeProxy(files, () => apiCall(200, MODEL_USAGE))
    const first = await read(proxyFake.fetch, NOW)
    expect(proxyFake.asked.sort()).toEqual(['i1', 'i2'])
    // The read just made is newer than the listing: it shows whole, Fable included.
    expect(first?.accounts?.map((account) => account.windows)).toEqual([DIRECT, DIRECT])

    // A later reply through the proxy updates two's listed limits; Fable stays from its own read.
    files[1]!.quota = quota('2026-11-09T12:01:00Z', '0.9', '0.5')
    const later = await read(proxyFake.fetch, NOW + 120_000)
    expect(proxyFake.asked).toHaveLength(2)
    expect(later?.accounts).toEqual([
      { id: 'one.json', label: 'one@example.com', windows: DIRECT },
      { id: 'two.json', label: 'two@example.com', windows: [{ ...WINDOWS[0], remainingPercent: 10 }, { ...WINDOWS[1], remainingPercent: 50 }, FABLE] }
    ])
    expect(later?.windows.map((window) => window.label)).toContain('Weekly · Fable · two@example.com')

    await read(proxyFake.fetch, NOW + MODEL_LIMITS_REUSE_MS - 1_000)
    expect(proxyFake.asked).toHaveLength(2)
    await read(proxyFake.fetch, NOW + MODEL_LIMITS_REUSE_MS)
    expect(proxyFake.asked).toHaveLength(4)
  })

  it('the Usage page filling sign-ins one by one lists them once and reads each once', async () => {
    const proxyFake = fakeProxy([
      { id: 'one.json', provider: 'claude', auth_index: 'i1', quota: quota(RECENT) },
      { id: 'two.json', provider: 'claude', auth_index: 'i2', quota: quota(RECENT) },
      { id: 'three.json', provider: 'claude', auth_index: 'i3', quota: quota(RECENT) }
    ], () => apiCall(200, MODEL_USAGE))
    const options = { baseUrl, managementKey: 'mgmt', fetch: proxyFake.fetch, now: () => NOW }
    const preview = await previewLocalProxyClaudeAccounts(options)
    const groups = await Promise.all(preview!.accounts!.map((account) => readLocalProxyClaudeAccount(options, account.id)))
    expect(groups.map((group) => group?.windows)).toEqual([DIRECT, DIRECT, DIRECT])
    expect(proxyFake.asked.sort()).toEqual(['i1', 'i2', 'i3'])
    expect(proxyFake.listings()).toBe(1)
  })

  it('a sign-in without recent listed limits is read again after a few minutes; one with them, after a quarter hour', async () => {
    const stale = new Date(NOW - OBSERVED_FRESH_MS - 60_000).toISOString()
    const proxyFake = fakeProxy([
      { id: 'fresh.json', provider: 'claude', auth_index: 'i1', quota: quota(RECENT) },
      { id: 'stale.json', provider: 'claude', auth_index: 'i2', quota: quota(stale) },
      { id: 'none.json', provider: 'claude', auth_index: 'i3' },
      { id: 'empty.json', provider: 'claude', auth_index: 'i4', quota: { signals: {} } }
    ])
    const first = await read(proxyFake.fetch, NOW)
    expect(proxyFake.asked.sort()).toEqual(['i1', 'i2', 'i3', 'i4'])
    expect(first?.accounts?.map((account) => account.windows.length)).toEqual([2, 2, 2, 2])
    // The listing is read again on a later refresh; the sign-ins' own reads are not.
    await read(proxyFake.fetch, NOW + 60_000)
    await read(proxyFake.fetch, NOW + ACCOUNT_READ_REUSE_MS - 1_000)
    expect(proxyFake.asked).toHaveLength(4)
    expect(proxyFake.listings()).toBe(3)
    await read(proxyFake.fetch, NOW + ACCOUNT_READ_REUSE_MS)
    expect(proxyFake.asked.slice(4).sort()).toEqual(['i2', 'i3', 'i4'])
  })

  it('when the read for model limits is rate limited or refused, the recent listed limits still show', async () => {
    for (const reply of [apiCall(429, { error: 'rate_limited' }), apiCall(401, { error: 'expired' }), apiCall(200, 'not json')]) {
      resetLocalProxyDetection()
      const proxyFake = fakeProxy([{ id: 'one.json', provider: 'claude', auth_index: 'i1', quota: quota(RECENT) }], () => reply)
      const usage = await read(proxyFake.fetch, NOW)
      expect(proxyFake.asked).toEqual(['i1'])
      expect(usage?.windows).toEqual(WINDOWS)
    }
  })

  it('reads at the same time share one request per sign-in', async () => {
    const proxyFake = fakeProxy([{ id: 'one.json', provider: 'claude', auth_index: 'i1' }, { id: 'two.json', provider: 'claude', auth_index: 'i2' }])
    let release!: () => void
    proxyFake.holdReads(new Promise<void>((settle) => { release = settle }))
    const options = { baseUrl, managementKey: 'mgmt', fetch: proxyFake.fetch, now: () => NOW }
    const reads = Promise.all([read(proxyFake.fetch, NOW), readLocalProxyClaudeAccount(options, 'one.json'), readLocalProxyClaudeAccount(options, 'one.json'), read(proxyFake.fetch, NOW)])
    await vi.waitFor(() => expect(proxyFake.asked.length).toBeGreaterThanOrEqual(2))
    release()
    const [whole, one, again, wholeAgain] = await reads
    expect(proxyFake.asked.sort()).toEqual(['i1', 'i2'])
    expect(one?.windows).toHaveLength(2)
    expect(again).toEqual(one)
    expect(wholeAgain).toEqual(whole)
  })

  it('after a 429 the sign-in is not asked again until Retry-After has passed, and shows the last limits known', async () => {
    let limited = true
    const stale = new Date(NOW - OBSERVED_FRESH_MS - 60_000).toISOString()
    const proxyFake = fakeProxy([{ id: 'one.json', provider: 'claude', auth_index: 'i1', quota: quota(stale) }], () => (limited
      ? { status_code: 429, header: { 'Retry-After': ['600'] }, body: '{"error":"rate_limited"}' }
      : apiCall(200, CLAUDE_USAGE)))
    const first = await read(proxyFake.fetch, NOW)
    expect(proxyFake.asked).toHaveLength(1)
    // The listing's older limits stand in rather than "Rate limited".
    expect(first?.windows).toEqual(WINDOWS)
    limited = false
    await read(proxyFake.fetch, NOW + 60_000)
    await read(proxyFake.fetch, NOW + 599_000)
    expect(proxyFake.asked).toHaveLength(1)
    const after = await read(proxyFake.fetch, NOW + 600_000)
    expect(proxyFake.asked).toHaveLength(2)
    expect(after?.windows.map((window) => window.resetsAt)).toEqual(['2026-11-08T17:00:00Z', '2026-11-12T09:00:00Z'])
  })

  it('a 429 without Retry-After waits a couple of minutes; with nothing known it says Rate limited', async () => {
    const proxyFake = fakeProxy([{ id: 'one.json', provider: 'claude', auth_index: 'i1' }, { id: 'two.json', provider: 'claude', auth_index: 'i2', quota: quota(RECENT) }], () => apiCall(429, { error: 'rate_limited' }))
    const first = await read(proxyFake.fetch, NOW)
    expect(first?.accounts?.[0]).toMatchObject({ id: 'one.json', windows: [], problem: 'Rate limited' })
    expect(first?.accounts?.[1]).toMatchObject({ id: 'two.json', windows: WINDOWS })
    await read(proxyFake.fetch, NOW + RATE_LIMIT_WAIT_MS - 1_000)
    expect(proxyFake.asked.sort()).toEqual(['i1', 'i2'])
    await read(proxyFake.fetch, NOW + RATE_LIMIT_WAIT_MS)
    expect(proxyFake.asked.sort()).toEqual(['i1', 'i1', 'i2', 'i2'])
  })

  it('an expired sign-in says so, even when older limits are listed for it', async () => {
    const stale = new Date(NOW - OBSERVED_FRESH_MS - 60_000).toISOString()
    const proxyFake = fakeProxy([{ id: 'one.json', provider: 'claude', auth_index: 'i1', quota: quota(stale) }, { id: 'two.json', provider: 'claude', auth_index: 'i2', quota: quota(RECENT) }], () => apiCall(401, { error: 'expired' }))
    const usage = await read(proxyFake.fetch, NOW)
    expect(usage?.accounts?.[0]).toMatchObject({ id: 'one.json', windows: [], problem: 'Sign-in expired' })
  })

  it('another management key does not reuse what the last one read', async () => {
    const proxyFake = fakeProxy([{ id: 'one.json', provider: 'claude', auth_index: 'i1' }])
    await read(proxyFake.fetch, NOW)
    await read(proxyFake.fetch, NOW + 1_000, { managementKey: 'other' })
    expect(proxyFake.asked).toEqual(['i1', 'i1'])
  })

  it('turns limit headers into windows: a window past its reset is unused, odd values are left out', () => {
    const observed = (signals: Record<string, string>) => ({ at: NOW, signals })
    expect(observedClaudeLimits(observed({ '5h-utilization': '0.37', '5h-reset': seconds('2026-11-09T14:00:00Z'), '7d-utilization': '1.02' }), NOW)).toEqual({
      five_hour: { utilization: 37, resets_at: '2026-11-09T14:00:00.000Z' },
      seven_day: { utilization: 100 }
    })
    // The 5-hour window reset after the reply that reported it.
    expect(observedClaudeLimits(observed({ '5h-utilization': '0.95', '5h-reset': seconds('2026-11-09T11:00:00Z') }), NOW)).toEqual({ five_hour: { utilization: 0 } })
    expect(observedClaudeLimits(observed({ '5h-reset': '2026-11-09T14:00:00Z', '5h-utilization': '0.5' }), NOW)).toEqual({ five_hour: { utilization: 50, resets_at: '2026-11-09T14:00:00.000Z' } })
    for (const bad of ['', '-0.1', 'abc', '37', 'NaN', '0x1']) expect(observedClaudeLimits(observed({ '5h-utilization': bad }), NOW)).toBeUndefined()
    expect(observedClaudeLimits(observed({ status: 'allowed' }), NOW)).toBeUndefined()
  })

  it('reads the listing quota in any header case, and ignores other providers\' signals and a missing time', () => {
    const [withLimits, codexStyle, undated] = claudeProxyAccounts({ files: [
      { id: 'a', provider: 'claude', auth_index: 'a', quota: { observed_at: '2026-11-09T11:55:00.123456789Z', signals: { 'anthropic-ratelimit-unified-5h-utilization': '0.2', 'X-Other': '1' } } },
      { id: 'b', provider: 'claude', auth_index: 'b', quota: { observed_at: RECENT, signals: { 'X-Codex-Primary-Used-Percent': '90' } } },
      { id: 'c', provider: 'claude', auth_index: 'c', quota: { signals: { 'Anthropic-Ratelimit-Unified-5h-Utilization': '0.2' } } }
    ] })
    expect(withLimits!.observed).toEqual({ at: Date.parse('2026-11-09T11:55:00.123Z'), signals: { '5h-utilization': '0.2' } })
    expect(codexStyle!.observed).toBeUndefined()
    expect(undated!.observed).toBeUndefined()
  })
})
