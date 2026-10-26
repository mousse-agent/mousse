import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { generateKeyPair } from 'jose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parsePastedRedirect } from '../../../src/mms/harness/chatgpt/oauth'
import type { HarnessGatewayEvent } from '../../../src/mms/harness/gateway'
import { ProviderInstanceService } from '../../../src/mms/providers/ProviderInstanceService'
import { PiLoopAdapter } from '../../../src/mms/run/adapters/pi/PiLoopAdapter'
import type { ProviderAdapter } from '../../../src/mms/run/adapters/ProviderAdapter'
import { adapterDriver, testHarness } from '../../../src/mms/run/testkit/harness'
import { FakeIssuer, FULL_SCOPE, guardNetwork, tempHomes } from './fakeIssuer'
import { approve, callbackFor, chatgptAuth, signIn, startSignIn } from './signInFlow'

guardNetwork()
const homes = tempHomes()
let issuer: FakeIssuer
beforeEach(async () => {
  issuer = await new FakeIssuer().start()
})
afterEach(async () => {
  await issuer.stop()
})

const ALICE = { subject: 'user-alice', email: 'alice@example.com' }
const BOB = { subject: 'user-bob', email: 'bob@example.com' }

describe('Sign in with ChatGPT: authorize request', () => {
  it('registers a new client with the exact parameters, and exchanges the code with the same redirect', async () => {
    const auth = chatgptAuth(issuer, homes())
    const { link, result } = await signIn(issuer, auth, ALICE)
    expect(result).toEqual({ success: true })
    const params = Object.fromEntries(link.searchParams)
    expect(Object.keys(params).sort()).toEqual([
      'agent_name_hint', 'client_id', 'code_challenge', 'code_challenge_method', 'ext_agent_host_id', 'nonce',
      'redirect_uri', 'resource', 'response_type', 'scope', 'state'
    ])
    expect(params).toMatchObject({
      client_id: 'dynamic_agent_client',
      agent_name_hint: 'Mousse',
      response_type: 'code',
      scope: FULL_SCOPE,
      resource: 'https://api.openai.com/v1',
      code_challenge_method: 'S256'
    })
    expect(params.ext_agent_host_id).toMatch(/^urn:uuid:[0-9a-f-]{36}$/)
    expect(params.redirect_uri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/)
    expect(params.state).toHaveLength(43)
    expect(params.nonce).toHaveLength(43)
    expect(params.state).not.toBe(params.nonce)
    expect(link.origin + link.pathname).toBe(`${issuer.base}/oauth/authorize`)

    const [exchange] = issuer.tokenRequests
    expect(Object.keys(exchange).sort()).toEqual(['client_id', 'code', 'code_verifier', 'grant_type', 'redirect_uri', 'resource'])
    expect(exchange).toMatchObject({ grant_type: 'authorization_code', client_id: 'oaiapp_one', redirect_uri: params.redirect_uri, resource: 'https://api.openai.com/v1' })
    expect(exchange.code_verifier).toHaveLength(86)
    expect(createHash('sha256').update(exchange.code_verifier).digest('base64url')).toBe(params.code_challenge)

    expect(auth.status()).toEqual({ state: 'signed_in', email: 'alice@example.com', label: 'Connection 1' })
    expect(auth.identity()).toBe('chatgpt:oaiapp_one:user-alice')
  })

  it('signs in again on the saved registration with login_hint, never agent_name_hint or id_token_hint', async () => {
    const home = homes()
    const auth = chatgptAuth(issuer, home)
    const first = await signIn(issuer, auth, ALICE)
    const again = await signIn(issuer, auth, ALICE)
    expect(again.result).toEqual({ success: true })
    const params = Object.fromEntries(again.link.searchParams)
    expect(params.client_id).toBe('oaiapp_one')
    expect(params.login_hint).toBe('alice@example.com')
    expect(params).not.toHaveProperty('agent_name_hint')
    expect(params).not.toHaveProperty('id_token_hint')
    expect(params).not.toHaveProperty('prompt')
    // The host id belongs to the installation and stays the same.
    expect(params.ext_agent_host_id).toBe(first.link.searchParams.get('ext_agent_host_id'))
    expect(params.state).not.toBe(first.link.searchParams.get('state'))
  })

  it('"Different account" registers another client and keeps the first one saved', async () => {
    const auth = chatgptAuth(issuer, homes())
    await signIn(issuer, auth, ALICE)
    const other = await signIn(issuer, auth, BOB, { method: 'chatgpt-new-account', clientId: 'oaiapp_two' })
    expect(other.link.searchParams.get('client_id')).toBe('dynamic_agent_client')
    expect(auth.identity()).toBe('chatgpt:oaiapp_two:user-bob')
    expect(auth.signInOptions().map((option) => option.id)).toEqual(['chatgpt', 'chatgpt-new-account', 'chatgpt-profile:oaiapp_two', 'chatgpt-profile:oaiapp_one'])
    const saved = await signIn(issuer, auth, ALICE, { method: 'chatgpt-profile:oaiapp_one' })
    expect(saved.link.searchParams.get('client_id')).toBe('oaiapp_one')
    expect(auth.identity()).toBe('chatgpt:oaiapp_one:user-alice')
  })
})

describe('Sign in with ChatGPT: callback rules', () => {
  it('a first registration needs an issued oaiapp_ client id', async () => {
    for (const returned of [null, 'dynamic_agent_client', 'something_else']) {
      const auth = chatgptAuth(issuer, homes())
      const flow = startSignIn(auth)
      await approve(issuer, await flow.link(), ALICE, { returnClientId: returned })
      expect(await flow.result).toMatchObject({ success: false, failure: 'registration' })
      expect(auth.status().state).toBe('signed_out')
    }
  })

  it('a reauth that returns another client id is refused', async () => {
    const auth = chatgptAuth(issuer, homes())
    await signIn(issuer, auth, ALICE)
    const flow = startSignIn(auth)
    await approve(issuer, await flow.link(), ALICE, { returnClientId: 'oaiapp_other' })
    expect(await flow.result).toMatchObject({ success: false, failure: 'registration' })
    expect(auth.identity()).toBe('chatgpt:oaiapp_one:user-alice')
  })

  it('checks the state before anything else', async () => {
    const auth = chatgptAuth(issuer, homes())
    const flow = startSignIn(auth)
    const link = await flow.link()
    const callback = callbackFor(link, { code: 'x', error: 'access_denied' })
    callback.searchParams.set('state', 'forged')
    await fetch(callback)
    expect(await flow.result).toMatchObject({ success: false, failure: 'callback', error: "This sign-in couldn't be verified. Start again." })
    expect(issuer.tokenRequests).toHaveLength(0)
  })

  it('a declined authorization says so', async () => {
    const auth = chatgptAuth(issuer, homes())
    const flow = startSignIn(auth)
    await fetch(callbackFor(await flow.link(), { error: 'access_denied' }))
    expect(await flow.result).toEqual({ success: false, failure: 'declined', error: 'ChatGPT sign-in was declined. Sign in again when you are ready.' })
  })

  it('answers the callback once, then 410', async () => {
    const auth = chatgptAuth(issuer, homes())
    const flow = startSignIn(auth)
    const link = await flow.link()
    issuer.onToken = () => new Promise(() => undefined)
    const callback = await approve(issuer, link, ALICE, { open: false })
    const first = await fetch(callback)
    expect(first.status).toBe(200)
    expect(first.headers.get('content-security-policy')).toContain("default-src 'none'")
    expect(first.headers.get('cache-control')).toBe('no-store')
    expect(first.headers.get('referrer-policy')).toBe('no-referrer')
    expect((await fetch(callback)).status).toBe(410)
    flow.cancel()
    expect(await flow.result).toMatchObject({ success: false, failure: 'cancelled' })
  })
})

describe('Sign in with ChatGPT: ID token and token response', () => {
  /** Answers the exchange with an ID token built by `make` for the attempt's nonce. */
  async function withIdToken(make: (nonce: string) => Promise<string>, extra: Record<string, unknown> = {}) {
    const auth = chatgptAuth(issuer, homes())
    const flow = startSignIn(auth)
    const link = await flow.link()
    const nonce = link.searchParams.get('nonce')!
    const idToken = await make(nonce)
    issuer.onToken = async () => ({ status: 200, body: { ...(await issuer.tokens('oaiapp_one', FULL_SCOPE, idToken)), ...extra } })
    await fetch(callbackFor(link, { code: 'c', client_id: 'oaiapp_one' }))
    return { auth, result: await flow.result }
  }

  it.each([
    ['another audience', (nonce: string) => issuer.idToken('oaiapp_one', { sub: 'u', nonce, aud: 'oaiapp_other' })],
    ['another issuer', (nonce: string) => issuer.idToken('oaiapp_one', { sub: 'u', nonce, iss: 'https://evil.example' })],
    ['another nonce', () => issuer.idToken('oaiapp_one', { sub: 'u', nonce: 'stale' })],
    ['an expired token', (nonce: string) => issuer.idToken('oaiapp_one', { sub: 'u', nonce }, { expiresIn: '-1h' })],
    ['no subject', (nonce: string) => issuer.idToken('oaiapp_one', { nonce })],
    ['an unpublished key', async (nonce: string) => issuer.idToken('oaiapp_one', { sub: 'u', nonce }, { key: (await generateKeyPair('RS256')).privateKey })],
    ['alg none', async (nonce: string) => {
      const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url')
      return `${part({ alg: 'none' })}.${part({ iss: issuer.base, aud: 'oaiapp_one', sub: 'u', nonce, exp: Math.floor(Date.now() / 1000) + 600 })}.`
    }]
  ])('refuses an ID token with %s and saves nothing', async (_name, make) => {
    const { auth, result } = await withIdToken(make)
    expect(result).toMatchObject({ success: false, failure: 'verify' })
    expect(auth.status().state).toBe('signed_out')
    expect(existsSync(auth.lifecycle.store.path)).toBe(false)
  })

  it('refuses a token response without an ID token', async () => {
    const auth = chatgptAuth(issuer, homes())
    const flow = startSignIn(auth)
    const link = await flow.link()
    issuer.onToken = async () => ({ status: 200, body: await issuer.tokens('oaiapp_one', FULL_SCOPE) })
    await fetch(callbackFor(link, { code: 'c', client_id: 'oaiapp_one' }))
    expect(await flow.result).toMatchObject({ success: false, failure: 'verify', error: "ChatGPT didn't return a verified identity. Sign in again." })
  })

  it('refuses a token that is not a bearer token', async () => {
    const { result } = await withIdToken((nonce) => issuer.idToken('oaiapp_one', { sub: 'u', nonce }), { token_type: 'mac' })
    expect(result).toMatchObject({ success: false, failure: 'invalid_response' })
  })

  it('a different account on a saved registration is refused and the connection is unchanged', async () => {
    const auth = chatgptAuth(issuer, homes())
    await signIn(issuer, auth, ALICE)
    const key = auth.profileKey()
    const { result } = await signIn(issuer, auth, BOB)
    expect(result).toEqual({ success: false, failure: 'subject_mismatch', error: "This sign-in returned a different ChatGPT account. Use 'Different account'. Your saved connection is unchanged." })
    expect(auth.identity()).toBe('chatgpt:oaiapp_one:user-alice')
    expect(auth.profileKey()).toBe(key)
  })

  it('a grant without plan use is kept, reads sharing disabled, and the next sign-in asks for consent', async () => {
    const auth = chatgptAuth(issuer, homes())
    const { result } = await signIn(issuer, auth, ALICE, { scope: 'openid profile email offline_access' })
    expect(result).toMatchObject({ success: false, failure: 'sharing_disabled', error: "ChatGPT plan use isn't enabled. Sign in again and allow it, or use another provider." })
    expect(auth.status()).toMatchObject({ state: 'sharing_disabled', email: 'alice@example.com' })
    await expect(auth.access()).rejects.toMatchObject({ code: 'signed_out', failure: 'sharing_disabled' })
    const again = await signIn(issuer, auth, ALICE)
    expect(again.link.searchParams.get('prompt')).toBe('consent')
    expect(again.result).toEqual({ success: true })
    expect(auth.status().state).toBe('signed_in')
  })

  it('an expired code keeps the new registration, and the next attempt reuses it', async () => {
    const auth = chatgptAuth(issuer, homes())
    const flow = startSignIn(auth)
    await fetch(callbackFor(await flow.link(), { code: 'never-granted', client_id: 'oaiapp_new' }))
    expect(await flow.result).toMatchObject({ success: false, failure: 'code_expired' })
    const again = await signIn(issuer, auth, ALICE)
    expect(again.link.searchParams.get('client_id')).toBe('oaiapp_new')
    expect(again.result).toEqual({ success: true })
    expect(auth.identity()).toBe('chatgpt:oaiapp_new:user-alice')
  })
})

describe('Sign in with ChatGPT: pasted redirect', () => {
  const port = 51234
  const good = `http://127.0.0.1:${port}/auth/callback?code=abc&state=s1&client_id=oaiapp_one`

  it('accepts the exact callback address', () => {
    expect(parsePastedRedirect(`  ${good}  `, port).searchParams.get('code')).toBe('abc')
    expect(parsePastedRedirect(`http://127.0.0.1:${port}/auth/callback?error=access_denied&state=s1`, port).searchParams.get('error')).toBe('access_denied')
  })

  it.each([
    ['another port', good.replace(String(port), '51235')],
    ['localhost', good.replace('127.0.0.1', 'localhost')],
    ['https', good.replace('http:', 'https:')],
    ['another path', good.replace('/auth/callback', '/auth/other')],
    ['a duplicated code', `${good}&code=def`],
    ['a duplicated state', `${good}&state=s2`],
    ['no code', good.replace('code=abc&', '')],
    ['credentials', good.replace('http://', 'http://user:pw@')],
    ['a fragment', `${good}#x`],
    ['more than 16 KB', `${good}&pad=${'a'.repeat(16 * 1024)}`],
    ['not a URL', 'abc']
  ])('refuses %s', (_name, value) => {
    expect(() => parsePastedRedirect(value, port)).toThrow(expect.objectContaining({ failure: 'callback' }))
  })

  it('completes a sign-in from a pasted address', async () => {
    const auth = chatgptAuth(issuer, homes())
    const flow = startSignIn(auth)
    const callback = await approve(issuer, await flow.link(), ALICE, { open: false })
    flow.paste(callback.toString())
    expect(await flow.result).toEqual({ success: true })
    expect(auth.identity()).toBe('chatgpt:oaiapp_one:user-alice')
  })

  it('refuses a pasted address of another port', async () => {
    const auth = chatgptAuth(issuer, homes())
    const flow = startSignIn(auth)
    const callback = await approve(issuer, await flow.link(), ALICE, { open: false })
    callback.port = String(Number(callback.port) === 65535 ? 65534 : Number(callback.port) + 1)
    flow.paste(callback.toString())
    expect(await flow.result).toMatchObject({ success: false, failure: 'callback' })
    expect(issuer.tokenRequests).toHaveLength(0)
  })
})

describe('Sign in with ChatGPT: cancellation', () => {
  it('cancel closes the callback server; a late callback reaches nothing', async () => {
    const auth = chatgptAuth(issuer, homes())
    const flow = startSignIn(auth)
    const link = await flow.link()
    flow.cancel()
    expect(await flow.result).toEqual({ success: false, failure: 'cancelled', error: 'Sign-in cancelled' })
    const callback = await approve(issuer, link, ALICE, { open: false })
    await expect(fetch(callback)).rejects.toThrow()
    expect(issuer.tokenRequests).toHaveLength(0)
    expect(existsSync(auth.lifecycle.store.path)).toBe(false)
  })

  it('an exchange that finishes after a cancel saves nothing', async () => {
    const auth = chatgptAuth(issuer, homes())
    const flow = startSignIn(auth)
    const link = await flow.link()
    let answer!: () => void
    const answered = new Promise<void>((resolve) => (answer = resolve))
    issuer.onToken = async (form) => {
      await answered
      issuer.onToken = undefined
      const idToken = await issuer.idToken(form.client_id, { sub: ALICE.subject, nonce: link.searchParams.get('nonce')! })
      return { status: 200, body: await issuer.tokens(form.client_id, FULL_SCOPE, idToken) }
    }
    await fetch(callbackFor(link, { code: 'c', client_id: 'oaiapp_one' }))
    await vi.waitFor(() => expect(issuer.tokenRequests).toHaveLength(1))
    flow.cancel()
    answer()
    expect(await flow.result).toMatchObject({ success: false, failure: 'cancelled' })
    expect(auth.status().state).toBe('signed_out')
    expect(existsSync(auth.lifecycle.store.path)).toBe(false)
  })

  it('a newer attempt supersedes an older one that finishes late', async () => {
    const auth = chatgptAuth(issuer, homes())
    const older = startSignIn(auth)
    const olderLink = await older.link()
    const newer = startSignIn(auth)
    const newerLink = await newer.link()
    await approve(issuer, olderLink, BOB)
    expect(await older.result).toMatchObject({ success: false, failure: 'cancelled' })
    await approve(issuer, newerLink, ALICE)
    expect(await newer.result).toEqual({ success: true })
    expect(auth.identity()).toBe('chatgpt:oaiapp_one:user-alice')
  })
})

describe('Sign in with ChatGPT through the gateway', () => {
  const fake = (): ProviderAdapter => ({
    driver: 'codex',
    capabilities: new PiLoopAdapter(() => ({ chat: async () => { throw new Error('unused') } })).capabilities,
    configured: () => true,
    startTurn: async () => { throw new Error('unused') },
    interrupt: async () => 'not_active'
  })

  it('the sign-in link prompt offers both the callback server and the pasted address', async () => {
    const home = homes()
    const auth = chatgptAuth(issuer, home)
    const driver = adapterDriver(fake(), { runtime: { signIn: (session) => auth.signIn(session) } })
    let stored: unknown
    const instances = new ProviderInstanceService({
      store: { read: () => ({ instances: stored }), write: (next) => { stored = next.instances } },
      providerAuth: { credentials: { listProviderIds: () => [] } }
    })
    const harness = testHarness({ drivers: [driver], instances, profileHome: home.profileHome })
    const events: HarnessGatewayEvent[] = []
    harness.instances.subscribe((event) => events.push(event))
    const started = await harness.instances.signIn('codex')
    const prompts = () => events.flatMap((event) => (event.type === 'operation' && event.data.phase === 'prompt' ? [event.data.prompt] : []))
    await vi.waitFor(() => expect(prompts().some((prompt) => prompt.type === 'auth_url')).toBe(true))
    const link = prompts().find((prompt) => prompt.type === 'auth_url')!
    expect(link).toMatchObject({ type: 'auth_url', usesCallbackServer: true, acceptsRedirectPaste: true })
    // The dialog's paste field answers the link prompt.
    const callback = await approve(issuer, new URL(link.type === 'auth_url' ? link.url : ''), ALICE, { open: false })
    expect(await harness.instances.respondSignIn(started.operationId, { promptId: link.promptId, kind: 'redirect_url', value: callback.toString() })).toBe(true)
    await vi.waitFor(() => expect(events.some((event) => event.type === 'operation' && event.data.phase === 'completed')).toBe(true))
    expect(auth.identity()).toBe('chatgpt:oaiapp_one:user-alice')
  })
})
