import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { createServer as createHttpsServer } from 'node:https'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isRetryableAssistantError, type OAuthCredential, type Provider } from '@earendil-works/pi-ai'
import { builtinProviders } from '@earendil-works/pi-ai/providers/all'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PiBridge } from '../../src/mms/harness/pi/bridge'
import mousseExtension from '../../src/mms/harness/pi/extension/index'
import { CREDENTIAL_UNAVAILABLE, LOGIN_REFUSED } from '../../src/mms/harness/pi/extension/messages'
import { PI_BRIDGE_ENV, type PiCatalogProvider, type PiCredentialRequest, type PiCredentialResponse } from '../../src/mms/harness/pi/extension/protocol'
import {
  oauthGrant,
  oauthSubject,
  piCredentialHandler,
  piOAuthBroker,
  piOAuthCredential,
  piOAuthHandle,
  writePiAuth,
  type PiOAuthGrant,
  type PiOAuthSource,
  type PiOAuthVault
} from '../../src/mms/harness/pi/oauthBroker'
import { preparePiHome } from '../../src/mms/harness/pi/settings'
import { launchPi, piPackage, scratchDir, startRecorder, testExtension, testSettings, type RecordedRequest } from './piRpcFixture'

// The OAuth broker (PR 2 §5): Mousse keeps the refresh token and is the only refresher; Pi holds an
// opaque handle. Fake tokens and local recorders only; nothing here signs in or reaches an endpoint.

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  delete process.env[PI_BRIDGE_ENV]
})

function b64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

/** A fake unsigned JWT. */
function jwt(claims: Record<string, unknown>): string {
  return `${b64url({ alg: 'none' })}.${b64url(claims)}.fake`
}

const HOUR = 3_600_000

function copilotCredential(access: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'oauth',
    access,
    refresh: 'ghu_real_refresh_token',
    expires: Date.now() + HOUR,
    enterpriseUrl: 'ghe.mousse.test',
    availableModelIds: ['gpt-5.4', 'claude-sonnet-5'],
    ...extra
  }
}

/** A vault whose `getAuth` replaces the stored credential with `next` after `gate` opens (as pi-ai's refresh persists). */
function fakeVault(stored: Record<string, Record<string, unknown>>, next?: (current: Record<string, unknown>) => Record<string, unknown>) {
  let open!: () => void
  const gate = new Promise<void>((resolve) => (open = resolve))
  const getAuth = vi.fn(async (providerId: string) => {
    await gate
    if (next) stored[providerId] = next(stored[providerId]!)
    return undefined
  })
  const vault = { credentials: { get: (id: string) => stored[id] }, models: { getAuth } } as unknown as PiOAuthVault
  return { vault, getAuth, open }
}

async function piAuthStorage(path: string): Promise<{ read(provider: string): Promise<unknown> }> {
  const module = (await import(pathToFileURL(join(piPackage, 'dist/core/auth-storage.js')).href)) as { AuthStorage: { create(path: string): { read(provider: string): Promise<unknown> } } }
  return module.AuthStorage.create(path)
}

describe('the OAuth broker, Mousse side', () => {
  it('writes an auth.json Pi’s AuthStorage loads: the handle, Copilot’s fields, never the refresh token', async () => {
    const scratch = scratchDir()
    cleanups.push(() => scratch.cleanup())
    const home = join(scratch.dir, 'home')
    const { vault } = fakeVault({ 'github-copilot': copilotCredential('tid=fake;proxy-ep=proxy.mousse.test;', { idToken: 'secret-id-token' }) })
    const grant = await piOAuthBroker(vault).credential('github-copilot')
    const handle = piOAuthHandle('pi:github-copilot')
    preparePiHome(home)
    writePiAuth(home, 'github-copilot', piOAuthCredential(grant!, handle))
    // A later start keeps it (Mousse wrote it).
    preparePiHome(home)
    const path = join(home, 'auth.json')
    const text = readFileSync(path, 'utf8')
    expect(text).not.toContain('ghu_real_refresh_token')
    expect(text).not.toContain('secret-id-token')
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600)
    const loaded = await (await piAuthStorage(path)).read('github-copilot')
    expect(loaded).toEqual({
      type: 'oauth',
      access: 'tid=fake;proxy-ep=proxy.mousse.test;',
      refresh: handle,
      expires: grant!.expires,
      enterpriseUrl: 'ghe.mousse.test',
      availableModelIds: ['gpt-5.4', 'claude-sonnet-5']
    })
    expect(handle).toMatch(/^mousse:pi:github-copilot:[\w-]+$/)
    // Signed out: the file goes.
    writePiAuth(home, 'github-copilot', undefined)
    expect(existsSync(path)).toBe(false)
  })

  it('hands Pi only pi-ai OAuth providers’ credentials (never Anthropic, Codex or an API key)', () => {
    expect(oauthGrant('anthropic', { type: 'oauth', access: 'sk-ant-oat01-x', refresh: 'r', expires: 1 })).toBeUndefined()
    expect(oauthGrant('openai-codex', { type: 'oauth', access: 'a', refresh: 'r', expires: 1 })).toBeUndefined()
    expect(oauthGrant('kimi-coding', { type: 'api_key', key: 'k' })).toBeUndefined()
    expect(oauthGrant('kimi-coding', { type: 'oauth', access: '', refresh: 'r', expires: 1 })).toBeUndefined()
    expect(oauthGrant('kimi-coding', { type: 'oauth', access: 'a', refresh: 'r', expires: 1, scope: 'x' })).toEqual({ access: 'a', expires: 1, fields: {} })
    expect(oauthGrant('radius', { type: 'oauth', access: 'a', refresh: 'r', expires: 1, scope: 'x' })).toEqual({ access: 'a', expires: 1, fields: { scope: 'x' } })
  })

  it('refreshes once under concurrency, keeps Copilot’s fields, and the subject survives a refresh', async () => {
    const before = copilotCredential('tid=old;proxy-ep=proxy.mousse.test;')
    const { vault, getAuth, open } = fakeVault({ 'github-copilot': before }, (current) => ({
      ...current,
      access: 'tid=new;proxy-ep=proxy.mousse.test;',
      expires: Date.now() + 2 * HOUR,
      availableModelIds: ['gpt-5.4']
    }))
    const broker = piOAuthBroker(vault)
    const handle = piOAuthHandle('pi:github-copilot')
    const handler = piCredentialHandler({ provider: 'github-copilot', handle: () => handle, source: broker })
    const grants = Array.from({ length: 3 }, () => broker.refresh('github-copilot'))
    const answers = Array.from({ length: 3 }, () => handler({ providerId: 'github-copilot', handle }))
    open()
    const expires = (await grants[0])!.expires
    expect(getAuth).toHaveBeenCalledTimes(1)
    // Copilot's subject: its stored GitHub token, which the refresh kept.
    const subject = (await grants[0])!.subject
    expect(subject).toMatch(/^github:/)
    expect(await Promise.all(grants)).toEqual(Array(3).fill({ access: 'tid=new;proxy-ep=proxy.mousse.test;', expires, fields: { enterpriseUrl: 'ghe.mousse.test', availableModelIds: ['gpt-5.4'] }, subject }))
    expect(await Promise.all(answers)).toEqual(Array(3).fill({ credential: { type: 'oauth', access: 'tid=new;proxy-ep=proxy.mousse.test;', refresh: handle, expires, enterpriseUrl: 'ghe.mousse.test', availableModelIds: ['gpt-5.4'] } }))
    // A later refresh starts a new one.
    await broker.refresh('github-copilot')
    expect(getAuth).toHaveBeenCalledTimes(2)

    // The subject: the JWT `sub`, unchanged by a refresh that rotates every token.
    const kimi = { type: 'oauth', access: jwt({ sub: 'user-7', exp: 1 }), refresh: 'r1', expires: 1 }
    const kimiVault = fakeVault({ 'kimi-coding': kimi }, (current) => ({ ...current, access: jwt({ sub: 'user-7', exp: 2 }), refresh: 'r2', expires: 2 }))
    const kimiSubject = oauthSubject(kimiVault.vault.credentials.get('kimi-coding'))
    kimiVault.open()
    await piOAuthBroker(kimiVault.vault).refresh('kimi-coding')
    const refreshed = kimiVault.vault.credentials.get('kimi-coding') as Record<string, unknown>
    expect(refreshed.access).not.toBe(kimi.access)
    expect(kimiSubject).toBe('sub:user-7')
    expect(oauthSubject(refreshed)).toBe(kimiSubject)
    // Else the account id pi-ai stores, else a `credentialId`; Copilot's tokens carry neither (its
    // GitHub token names it only when the provider is given).
    expect(oauthSubject({ type: 'oauth', access: 'opaque', accountId: 'acct-1' })).toBe('account:acct-1')
    expect(oauthSubject({ type: 'oauth', access: 'opaque', credentialId: 'c-1' })).toBe('credential:c-1')
    expect(oauthSubject(before)).toBeUndefined()
    expect(oauthSubject({ type: 'api_key', key: jwt({ sub: 'x' }) })).toBeUndefined()
  })

  it('refuses a handle from another instance or an earlier engine, and any other provider', async () => {
    const { vault, open } = fakeVault({ 'github-copilot': copilotCredential('tid=a;') })
    open()
    const source = piOAuthBroker(vault)
    const refresh = vi.spyOn(source, 'refresh')
    const handle = piOAuthHandle('pi:github-copilot')
    const handler = piCredentialHandler({ provider: 'github-copilot', handle: () => handle, source })
    const refused: PiCredentialRequest[] = [
      { providerId: 'github-copilot', handle: piOAuthHandle('pi:github-copilot-work') },
      { providerId: 'github-copilot', handle: piOAuthHandle('pi:github-copilot') },
      { providerId: 'github-copilot', handle: 'ghu_real_refresh_token' },
      { providerId: 'kimi-coding', handle },
      { providerId: 'github-copilot', handle: undefined as never }
    ]
    for (const request of refused) await expect(handler(request)).rejects.toThrow()
    expect(refresh).not.toHaveBeenCalled()
    await expect(handler({ providerId: 'github-copilot', handle })).resolves.toMatchObject({ credential: { refresh: handle } })
  })
})

function fakePi() {
  const providers: Provider[] = []
  const pi = {
    registerCommand: () => {},
    registerProvider: (provider: Provider) => void providers.push(provider),
    registerTool: () => {},
    setActiveTools: () => {},
    on: () => {}
  }
  return { pi, providers }
}

describe('the OAuth broker, extension side', () => {
  async function loaded(credential: (request: PiCredentialRequest) => Promise<PiCredentialResponse>) {
    const bridge = new PiBridge()
    await bridge.start()
    cleanups.push(() => bridge.stop())
    const registration = bridge.register({
      catalog: async () => ({ provider: { id: 'github-copilot', builtin: true, models: [] }, catalogRevision: 1 }),
      ready: () => {},
      turn: async () => ({ attemptToken: 'a', sessionInstructions: '', tools: [], activeBuiltins: [], mcp: null, catalogRevision: 1 }),
      gate: async () => ({ allow: false, reason: 'test' }),
      quiesce: async () => ({ ok: false, reason: 'test' }),
      fatal: () => {},
      credential
    })
    process.env[PI_BRIDGE_ENV] = JSON.stringify(registration.address)
    const fake = fakePi()
    await mousseExtension(fake.pi as never)
    const provider = (id: string) => fake.providers.findLast((entry) => entry.id === id)!
    return { ...fake, provider, registration }
  }

  it('keeps the stock toAuth, brokers refresh over the bridge, and refuses sign-in', async () => {
    const { vault, open } = fakeVault({ 'github-copilot': copilotCredential('tid=old;proxy-ep=proxy.mousse.test;') }, (current) => ({ ...current, access: 'tid=new;proxy-ep=proxy.mousse.test;', expires: Date.now() + HOUR }))
    open()
    const handle = piOAuthHandle('pi:github-copilot')
    const { provider, providers, registration } = await loaded(piCredentialHandler({ provider: 'github-copilot', handle: () => handle, source: piOAuthBroker(vault) }))
    const copilot = provider('github-copilot')
    const stock = builtinProviders().find((entry) => entry.id === 'github-copilot')!
    expect(copilot.auth.oauth!.name).toBe(stock.auth.oauth!.name)
    expect(copilot.auth.oauth!.isSubscription).toBe(stock.auth.oauth!.isSubscription)
    // Copilot's base URL still comes from the token; Kimi still sends a Bearer header.
    const held: OAuthCredential = { type: 'oauth', access: 'tid=old;proxy-ep=proxy.mousse.test;', refresh: handle, expires: 0 }
    expect(await copilot.auth.oauth!.toAuth(held)).toMatchObject({ apiKey: held.access, baseUrl: 'https://api.mousse.test' })
    expect(await provider('kimi-coding').auth.oauth!.toAuth({ ...held, access: 'kimi-access' })).toEqual({ headers: { Authorization: 'Bearer kimi-access' } })

    const signal = new AbortController().signal
    expect(await copilot.auth.oauth!.refresh(held, signal)).toEqual({
      type: 'oauth', access: 'tid=new;proxy-ep=proxy.mousse.test;', refresh: handle, expires: expect.any(Number),
      enterpriseUrl: 'ghe.mousse.test', availableModelIds: ['gpt-5.4', 'claude-sonnet-5']
    })
    // Another instance's handle, another provider, a plain refresh token: one fixed text, no detail.
    for (const [id, credential] of [
      ['github-copilot', { ...held, refresh: piOAuthHandle('pi:github-copilot-work') }],
      ['kimi-coding', held],
      ['github-copilot', { ...held, refresh: 'ghu_real_refresh_token' }]
    ] as const)
      await expect(provider(id).auth.oauth!.refresh(credential, signal)).rejects.toThrow(new Error(CREDENTIAL_UNAVAILABLE))
    // Every OAuth provider's sign-in is Mousse's.
    const oauthProviders = providers.filter((entry) => entry.auth.oauth)
    expect(new Set(oauthProviders.map((entry) => entry.id))).toEqual(new Set(['github-copilot', 'kimi-coding', 'radius', 'xai', 'openrouter', 'anthropic', 'openai-codex'].filter((id) => builtinProviders().some((entry) => entry.id === id && entry.auth.oauth))))
    for (const entry of oauthProviders) await expect(entry.auth.oauth!.login({} as never)).rejects.toThrow(LOGIN_REFUSED)
    // The bridge gone (transport failure): the same fixed text.
    registration.close()
    await expect(copilot.auth.oauth!.refresh(held, signal)).rejects.toThrow(new Error(CREDENTIAL_UNAVAILABLE))
    // As pi-ai wraps it, Pi does not retry it.
    expect(isRetryableAssistantError({ stopReason: 'error', errorMessage: `OAuth refresh failed for github-copilot: ${CREDENTIAL_UNAVAILABLE}` } as never)).toBe(false)
  })

  it('refuses an answer that is not a credential for the handle', async () => {
    const handle = piOAuthHandle('pi:github-copilot')
    const answers: unknown[] = [{}, { credential: { type: 'oauth', access: 'a', refresh: 'other', expires: 1 } }, { credential: { type: 'oauth', access: '', refresh: handle, expires: 1 } }]
    let next = 0
    const { provider } = await loaded(async () => answers[next++] as PiCredentialResponse)
    for (let index = 0; index < answers.length; index += 1)
      await expect(provider('github-copilot').auth.oauth!.refresh({ type: 'oauth', access: 'a', refresh: handle, expires: 0 }, new AbortController().signal)).rejects.toThrow(new Error(CREDENTIAL_UNAVAILABLE))
  })
})

// -- The real pinned Pi child ---------------------------------------------------------------------

function openssl(): boolean {
  return spawnSync('openssl', ['version'], { stdio: 'ignore' }).status === 0
}

/** A throwaway self-signed certificate for 127.0.0.1, made per run (no key is checked in). */
function testCertificate(dir: string): { key: Buffer; cert: Buffer; certPath: string } {
  const keyPath = join(dir, 'tls-key.pem')
  const certPath = join(dir, 'tls-cert.pem')
  const made = spawnSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', keyPath, '-out', certPath, '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { encoding: 'utf8' })
  if (made.status !== 0) throw new Error(`openssl failed: ${made.stderr}`)
  return { key: readFileSync(keyPath), cert: readFileSync(certPath), certPath }
}

/** A local HTTPS recorder (answers 400 to everything). */
async function startTlsRecorder(tls: { key: Buffer; cert: Buffer }): Promise<{ port: number; requests: RecordedRequest[]; close(): Promise<void> }> {
  const requests: RecordedRequest[] = []
  const server = createHttpsServer({ key: tls.key, cert: tls.cert }, (req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString('utf8') })
      const body = JSON.stringify({ error: { message: 'recorded by the Mousse test recorder' } })
      res.writeHead(400, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
      res.end(body)
    })
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  return {
    port: (server.address() as AddressInfo).port,
    requests,
    close: () => new Promise<void>((done) => {
      server.closeAllConnections()
      server.close(() => done())
    })
  }
}

/** A Pi child for `provider` with Mousse's extension, its bridge answering `/pi/credential` from `source`. */
async function child(options: { provider: PiCatalogProvider; model: string; grant: PiOAuthGrant; source: PiOAuthSource; env?: NodeJS.ProcessEnv }) {
  const scratch = scratchDir()
  cleanups.push(() => scratch.cleanup())
  const bridge = new PiBridge()
  await bridge.start()
  cleanups.push(() => bridge.stop())
  const handle = piOAuthHandle(`pi:${options.provider.id}`)
  const credentialRequests: PiCredentialRequest[] = []
  const handler = piCredentialHandler({ provider: options.provider.id, handle: () => handle, source: options.source })
  const registration = bridge.register({
    catalog: async () => ({ provider: options.provider, catalogRevision: 1 }),
    ready: () => {},
    turn: async () => ({ attemptToken: 'a1', sessionInstructions: '', tools: [], activeBuiltins: [], mcp: null, catalogRevision: 1 }),
    gate: async () => ({ allow: false, reason: 'test' }),
    quiesce: async () => ({ ok: false, reason: 'test' }),
    fatal: () => {},
    credential: (request) => {
      credentialRequests.push(request)
      return handler(request)
    }
  })
  const extension = await testExtension(scratch.dir)
  const pi = launchPi({
    dir: scratch.dir, provider: options.provider.id, model: options.model, extension, bridge: registration.address,
    homeFiles: { 'settings.json': testSettings(), 'auth.json': { [options.provider.id]: piOAuthCredential(options.grant, handle) } },
    ...(options.env ? { env: options.env } : {})
  })
  cleanups.push(() => pi.kill())
  await pi.process.client.send({ type: 'get_state' }).catch((error: Error) => { throw new Error(`${error.message}\n${pi.process.stderr()}`) })
  const prompt = async (provider: string, modelId: string) => {
    await pi.process.client.send({ type: 'set_model', provider, modelId })
    const from = pi.events.length
    await pi.process.client.send({ type: 'prompt', message: 'hello' })
    await pi.next((event) => event.type === 'agent_settled', from)
  }
  return { pi, handle, credentialRequests, prompt, authPath: join(pi.home, 'auth.json') }
}

describe('the OAuth broker in the real Pi child', () => {
  it.skipIf(!openssl())('lists Copilot’s models from auth.json, refreshes once through Mousse, and reaches the token-derived host over TLS', async () => {
    const scratch = scratchDir()
    cleanups.push(() => scratch.cleanup())
    const tls = testCertificate(scratch.dir)
    const recorder = await startTlsRecorder(tls)
    cleanups.push(() => recorder.close())
    // Expired: Pi's first request refreshes, through `/pi/credential`, to a token whose proxy endpoint is the recorder.
    const stale: PiOAuthGrant = { access: 'tid=stale;proxy-ep=proxy.unused.invalid;', expires: Date.now() - 1000, fields: { availableModelIds: ['gpt-5.4', 'claude-sonnet-5'] } }
    const fresh: PiOAuthGrant = { access: `tid=fresh;proxy-ep=127.0.0.1:${recorder.port};`, expires: Date.now() + HOUR, fields: { availableModelIds: ['gpt-5.4', 'claude-sonnet-5'] } }
    const source: PiOAuthSource = { credential: async () => stale, refresh: vi.fn(async () => fresh) }
    const run = await child({
      provider: { id: 'github-copilot', builtin: true, models: [] }, model: 'gpt-5.4', grant: stale, source,
      env: { NODE_EXTRA_CA_CERTS: tls.certPath }
    })
    const { models } = await run.pi.process.client.send({ type: 'get_available_models' })
    expect(models.filter((entry) => entry.provider === 'github-copilot').map((entry) => entry.id).sort()).toEqual(['claude-sonnet-5', 'gpt-5.4'])
    await run.prompt('github-copilot', 'gpt-5.4')
    await run.prompt('github-copilot', 'claude-sonnet-5')
    expect(run.credentialRequests).toEqual([{ providerId: 'github-copilot', handle: run.handle }])
    expect(source.refresh).toHaveBeenCalledTimes(1)
    // Pi stored the refreshed credential with the handle and the kept fields.
    expect(JSON.parse(readFileSync(run.authPath, 'utf8'))['github-copilot']).toMatchObject({ access: fresh.access, refresh: run.handle, availableModelIds: ['gpt-5.4', 'claude-sonnet-5'] })
    // An `openai-responses` and an `anthropic-messages` request, both at the token's host with the fresh token.
    expect(recorder.requests.some((request) => request.url.endsWith('/responses') && request.headers.authorization === `Bearer ${fresh.access}`), JSON.stringify(recorder.requests.map((request) => request.url))).toBe(true)
    const errors = run.pi.events.filter((event) => event.type === 'message_end').map((event) => (event.message as { errorMessage?: string }).errorMessage)
    const messages = recorder.requests.filter((request) => request.url.split('?')[0]!.endsWith('/v1/messages'))
    expect(messages.length, JSON.stringify({ urls: recorder.requests.map((request) => request.url), errors })).toBe(1)
    expect(JSON.stringify(messages[0]!.headers)).toContain(fresh.access)
    for (const request of recorder.requests) expect(JSON.stringify(request.headers)).not.toContain('stale')
  }, 180_000)

  it('sends Kimi’s access token as a Bearer header', async () => {
    const recorder = await startRecorder()
    cleanups.push(() => recorder.close())
    const model = {
      id: 'mousse-kimi', name: 'Mousse Kimi', api: 'anthropic-messages', provider: 'kimi-coding', baseUrl: `${recorder.url}/kimi`,
      reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096
    }
    const grant: PiOAuthGrant = { access: 'kimi-fake-access', expires: Date.now() + HOUR, fields: {} }
    const source: PiOAuthSource = { credential: async () => grant, refresh: vi.fn(async () => grant) }
    const run = await child({ provider: { id: 'kimi-coding', builtin: true, models: [model] as never }, model: 'mousse-kimi', grant, source })
    await run.prompt('kimi-coding', 'mousse-kimi')
    expect(recorder.requests.length).toBeGreaterThan(0)
    for (const request of recorder.requests) {
      expect(request.headers.authorization).toBe('Bearer kimi-fake-access')
      expect(request.headers['x-api-key']).toBeUndefined()
    }
    expect(source.refresh).not.toHaveBeenCalled()
  }, 180_000)
})
