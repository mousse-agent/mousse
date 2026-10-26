import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatGptAuth } from '../../../src/mms/harness/chatgpt/chatgptAuth'
import type { ChatGptAuthError } from '../../../src/mms/harness/chatgpt/errors'
import { harnessAppError } from '../../../src/shared/harness/types'
import { tryAcquireOnceForTests } from '../../../src/mms/platform/asyncFileLock'
import { activeSession, ChatGptStore, chatgptStorePath, emptyStore, type ChatGptStoreData } from '../../../src/mms/harness/chatgpt/store'
import type { SecretCodec } from '../../../src/mms/providers/secretCodec'
import { FakeIssuer, fakeVault, FULL_SCOPE, guardNetwork, plainCodec, tempHomes, type Reply } from './fakeIssuer'
import { chatgptAuth, signIn } from './signInFlow'

guardNetwork()
const homes = tempHomes()
let issuer: FakeIssuer
beforeEach(async () => {
  issuer = await new FakeIssuer().start()
})
afterEach(async () => {
  await issuer.stop()
})

const INSTANCE = 'codex:managed'
const MINUTE = 60_000

interface Seed {
  clientId: string
  subject: string
  email?: string
  /** ms of life left on the access token. */
  life: number
  refreshToken?: string | null
  scopes?: string[]
  earliestRefreshAt?: number | null
}

/** `seed` with another codec. */
function seedWith(profileHome: string, codec: SecretCodec, seeds: Seed[]): ChatGptStoreData {
  return seed(profileHome, seeds, seeds[0]?.clientId ?? null, codec)
}

/** Writes a store directly, as an earlier sign-in would have left it. */
function seed(profileHome: string, seeds: Seed[], active: string | null = seeds[0]?.clientId ?? null, codec: SecretCodec = plainCodec): ChatGptStoreData {
  const data: ChatGptStoreData = {
    ...emptyStore(),
    credentialEpoch: 1,
    signInFence: 1,
    pendingRevocations: [],
    active,
    registrations: seeds.map((entry, index) => ({ clientId: entry.clientId, subject: entry.subject, email: entry.email ?? null, label: `Connection ${index + 1}`, redirectPath: '/auth/callback', sharing: true })),
    sessions: seeds.map((entry) => ({
      clientId: entry.clientId,
      accessToken: `at-${entry.clientId}`,
      refreshToken: entry.refreshToken === undefined ? `rt-${entry.clientId}` : entry.refreshToken,
      idToken: `id-${entry.clientId}`,
      expiresAt: Date.now() + entry.life,
      earliestRefreshAt: entry.earliestRefreshAt ?? null,
      scopes: entry.scopes ?? FULL_SCOPE.split(' '),
      savedAt: Date.now()
    }))
  }
  for (const entry of seeds) if (entry.refreshToken !== null) issuer.allowRefresh(entry.refreshToken ?? `rt-${entry.clientId}`, entry.clientId)
  // A write must find the revision it read, as every writer does.
  const store = new ChatGptStore(chatgptStorePath(profileHome, INSTANCE), codec)
  store.read()
  store.write(data)
  return data
}

function stored(auth: ChatGptAuth): ChatGptStoreData {
  return auth.lifecycle.read()
}

/** Holds token responses until `release()`; the default endpoint then answers. */
function holdTokenEndpoint() {
  let release!: () => void
  const released = new Promise<void>((resolve) => (release = resolve))
  const held = issuer.onToken
  issuer.onToken = async (form): Promise<Reply> => {
    await released
    issuer.onToken = held
    return issuer.defaultToken(form)
  }
  return { release, sent: () => vi.waitFor(() => expect(issuer.tokenRequests.length).toBeGreaterThan(0)) }
}

describe('access: renewal rules', () => {
  it('returns the saved token while more than 3 minutes are left, and refreshes inside the margin', async () => {
    const home = homes()
    seed(home.profileHome, [{ clientId: 'oaiapp_a', subject: 'alice', life: 4 * MINUTE }])
    const auth = chatgptAuth(issuer, home)
    expect((await auth.access()).accessToken).toBe('at-oaiapp_a')
    expect(issuer.tokenRequests).toHaveLength(0)

    seed(home.profileHome, [{ clientId: 'oaiapp_a', subject: 'alice', life: 2 * MINUTE }])
    const renewed = await auth.access()
    expect(renewed.accessToken).not.toBe('at-oaiapp_a')
    expect(issuer.tokenRequests).toEqual([{ grant_type: 'refresh_token', client_id: 'oaiapp_a', refresh_token: 'rt-oaiapp_a', resource: 'https://api.openai.com/v1' }])
    // One write rotates everything.
    const session = activeSession(stored(auth))!
    expect(session).toMatchObject({ accessToken: renewed.accessToken, idToken: 'id-oaiapp_a', earliestRefreshAt: null })
    expect(session.refreshToken).toMatch(/^rt-\d/)
    expect(session.expiresAt).toBeGreaterThan(Date.now() + 59 * MINUTE)
  })

  it('honours earliest_refresh_at: keeps a still-valid token, and asks to wait once it ran out', async () => {
    const home = homes()
    const later = Date.now() + 10 * MINUTE
    seed(home.profileHome, [{ clientId: 'oaiapp_a', subject: 'alice', life: MINUTE, earliestRefreshAt: later }])
    const auth = chatgptAuth(issuer, home)
    expect((await auth.access()).accessToken).toBe('at-oaiapp_a')
    seed(home.profileHome, [{ clientId: 'oaiapp_a', subject: 'alice', life: -MINUTE, earliestRefreshAt: later }])
    await expect(auth.access()).rejects.toMatchObject({ code: 'rate_limited', failure: 'refresh_not_yet', resetAt: new Date(later).toISOString() })
    expect(issuer.tokenRequests).toHaveLength(0)
  })

  it('reads earliest_refresh_at in seconds or as an ISO time', async () => {
    const home = homes()
    const auth = chatgptAuth(issuer, home)
    for (const [value, expected] of [[1_900_000_000, 1_900_000_000_000], ['2030-01-01T00:00:00Z', Date.parse('2030-01-01T00:00:00Z')]] as const) {
      seed(home.profileHome, [{ clientId: 'oaiapp_a', subject: 'alice', life: 0 }])
      issuer.onToken = async (form) => ({ status: 200, body: { ...(await issuer.tokens(form.client_id, FULL_SCOPE)), earliest_refresh_at: value } })
      await auth.access()
      expect(activeSession(stored(auth))!.earliestRefreshAt).toBe(expected)
    }
  })

  it.each(['invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused'])(
    'a terminal %s clears the tokens, keeps the registration, and reads expired',
    async (error) => {
      const home = homes()
      seed(home.profileHome, [{ clientId: 'oaiapp_a', subject: 'alice', email: 'a@example.com', life: 0 }])
      const auth = chatgptAuth(issuer, home)
      issuer.onToken = () => ({ status: 400, body: { error } })
      await expect(auth.access()).rejects.toMatchObject({ code: 'auth_expired', failure: 'expired' })
      const after = stored(auth)
      expect(after.sessions).toEqual([])
      expect(after.registrations.map((registration) => registration.clientId)).toEqual(['oaiapp_a'])
      expect(after.active).toBe('oaiapp_a')
      expect(after.credentialEpoch).toBe(2)
      expect(auth.status()).toMatchObject({ state: 'expired', email: 'a@example.com' })
    }
  )

  it('invalid_client is a typed configuration error and keeps the tokens', async () => {
    const home = homes()
    const before = seed(home.profileHome, [{ clientId: 'oaiapp_a', subject: 'alice', life: 0 }])
    const auth = chatgptAuth(issuer, home)
    issuer.onToken = () => ({ status: 401, body: { error: 'invalid_client' } })
    await expect(auth.access()).rejects.toMatchObject({ code: 'wont_run', failure: 'invalid_client' })
    expect(stored(auth)).toEqual(before)
  })

  it.each([
    ['a 5xx', () => ({ status: 503, body: { error: 'temporarily_unavailable' } }), { code: 'timeout' }],
    ['a dropped connection', () => ({ status: 0 }), { code: 'timeout' }],
    ['a 429', () => ({ status: 429, body: { error: 'slow_down' }, headers: { 'retry-after': '120' } }), { code: 'rate_limited', resetAt: expect.any(String) }]
  ])('%s keeps the credentials and reads as retryable', async (_name, reply, expected) => {
    const home = homes()
    const before = seed(home.profileHome, [{ clientId: 'oaiapp_a', subject: 'alice', life: 0 }])
    const auth = chatgptAuth(issuer, home)
    issuer.onToken = reply
    const started = Date.now()
    const error = await auth.access().catch((caught: unknown) => caught)
    expect(error).toMatchObject({ failure: 'transient', ...expected })
    expect(harnessAppError((error as ChatGptAuthError).toHarnessError()).errorInfo?.retryable).toBe(true)
    if ((error as ChatGptAuthError).resetAt) expect(Date.parse((error as ChatGptAuthError).resetAt!)).toBeGreaterThanOrEqual(started + 119_000)
    expect(stored(auth)).toEqual(before)
  })

  it('a renewal without scope keeps the saved scopes', async () => {
    const home = homes()
    seed(home.profileHome, [{ clientId: 'oaiapp_a', subject: 'alice', life: 0 }])
    const auth = chatgptAuth(issuer, home)
    issuer.onToken = async (form) => {
      const { scope: _scope, ...rest } = await issuer.tokens(form.client_id, FULL_SCOPE)
      return { status: 200, body: rest }
    }
    const renewed = await auth.access()
    expect(renewed.accessToken).toMatch(/^at-\d/)
    expect(activeSession(stored(auth))!.scopes).toEqual(FULL_SCOPE.split(' '))
  })

  it('fails typed when signed out, when plan use is off, and when the connection changed', async () => {
    const home = homes()
    const auth = chatgptAuth(issuer, home)
    await expect(auth.access()).rejects.toMatchObject({ code: 'signed_out', failure: 'signed_out' })
    seed(home.profileHome, [{ clientId: 'oaiapp_a', subject: 'alice', life: 30 * MINUTE, scopes: ['openid'] }])
    await expect(auth.access()).rejects.toMatchObject({ code: 'signed_out', failure: 'sharing_disabled', message: "ChatGPT plan use isn't enabled. Sign in again and allow it, or use another provider." })
    seed(home.profileHome, [{ clientId: 'oaiapp_a', subject: 'alice', life: 30 * MINUTE }])
    const key = auth.profileKey()!
    expect((await auth.access(key)).profileKey).toBe(key)
    await expect(auth.access('another-key')).rejects.toMatchObject({ code: 'auth_expired', failure: 'account_changed' })
  })

  it('two store instances on one directory make exactly one refresh', async () => {
    const home = homes()
    seed(home.profileHome, [{ clientId: 'oaiapp_a', subject: 'alice', life: 0 }])
    const first = chatgptAuth(issuer, home)
    const second = chatgptAuth(issuer, home)
    const hold = holdTokenEndpoint()
    const a = first.access()
    const b = second.access()
    await hold.sent()
    hold.release()
    const [left, right] = await Promise.all([a, b])
    expect(issuer.tokenRequests).toHaveLength(1)
    expect(left.accessToken).toBe(right.accessToken)
  })

  it('reclaims a lock left by a dead process', async () => {
    const home = homes()
    seed(home.profileHome, [{ clientId: 'oaiapp_a', subject: 'alice', life: 30 * MINUTE }])
    const auth = chatgptAuth(issuer, home)
    const dead = spawnSync(process.execPath, ['-e', '']).pid!
    mkdirSync(dirname(auth.lifecycle.lockPath), { recursive: true })
    writeFileSync(auth.lifecycle.lockPath, JSON.stringify({ pid: dead, processInstanceId: 'gone', token: 't', acquiredAt: new Date().toISOString() }))
    expect((await auth.access()).accessToken).toBe('at-oaiapp_a')
  })
})

describe('lifecycle: one lock for every change', () => {
  it('refresh vs sign-out: sign-out waits, then clears and revokes the rotated token; nothing comes back', async () => {
    const home = homes()
    seed(home.profileHome, [{ clientId: 'oaiapp_a', subject: 'alice', life: 0 }])
    const refresher = chatgptAuth(issuer, home)
    const leaver = chatgptAuth(issuer, home)
    const hold = holdTokenEndpoint()
    const refresh = refresher.access()
    await hold.sent()
    const signOut = leaver.signOut()
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(issuer.revokeRequests).toHaveLength(0)
    hold.release()
    const renewed = await refresh
    expect(await signOut).toEqual({ confirmed: true })
    const after = stored(leaver)
    expect(after.active).toBeNull()
    expect(after.sessions).toEqual([])
    // Sign-out saw the rotated tokens: it revoked the new refresh token, not the spent one.
    expect(issuer.revokeRequests).toHaveLength(1)
    expect(issuer.revokeRequests[0]).toMatchObject({ client_id: 'oaiapp_a', token_type_hint: 'refresh_token' })
    expect(issuer.revokeRequests[0].token).not.toBe('rt-oaiapp_a')
    expect(JSON.stringify(after)).not.toContain(renewed.accessToken)
    await expect(refresher.access()).rejects.toMatchObject({ code: 'signed_out' })
  })

  it('refresh vs activation: activation wins and the refresh is not overwritten', async () => {
    const home = homes()
    seed(home.profileHome, [
      { clientId: 'oaiapp_a', subject: 'alice', life: 0 },
      { clientId: 'oaiapp_b', subject: 'bob', life: 30 * MINUTE }
    ])
    const refresher = chatgptAuth(issuer, home)
    const switcher = chatgptAuth(issuer, home)
    const hold = holdTokenEndpoint()
    const refresh = refresher.access()
    await hold.sent()
    const activation = switcher.activate('oaiapp_b')
    hold.release()
    const renewed = await refresh
    const key = await activation
    const after = stored(switcher)
    expect(after.active).toBe('oaiapp_b')
    expect(after.registrations[0].clientId).toBe('oaiapp_b')
    expect(after.sessions.find((session) => session.clientId === 'oaiapp_a')!.accessToken).toBe(renewed.accessToken)
    expect(switcher.profileKey()).toBe(key)
    expect((await switcher.access(key)).accessToken).toBe('at-oaiapp_b')
  })

  it('rotation then abort: the late response is still saved', async () => {
    const home = homes()
    seed(home.profileHome, [{ clientId: 'oaiapp_a', subject: 'alice', life: 0 }])
    const auth = chatgptAuth(issuer, home)
    const hold = holdTokenEndpoint()
    const controller = new AbortController()
    const refresh = auth.access(undefined, controller.signal)
    await hold.sent()
    controller.abort()
    hold.release()
    await expect(refresh).rejects.toMatchObject({ code: 'cancelled' })
    const session = activeSession(stored(auth))!
    expect(session.refreshToken).not.toBe('rt-oaiapp_a')
    expect(session.accessToken).toMatch(/^at-\d/)
  })

  it('an abort before the refresh is sent changes nothing', async () => {
    const home = homes()
    const before = seed(home.profileHome, [{ clientId: 'oaiapp_a', subject: 'alice', life: 0 }])
    const auth = chatgptAuth(issuer, home)
    const controller = new AbortController()
    controller.abort()
    await expect(auth.access(undefined, controller.signal)).rejects.toMatchObject({ code: 'cancelled' })
    expect(issuer.tokenRequests).toHaveLength(0)
    expect(stored(auth)).toEqual(before)
  })

  it('the profile key changes on every sign-in, activation, sign-out and terminal error, never on refresh', async () => {
    const home = homes()
    const auth = chatgptAuth(issuer, home)
    const keys: Array<string | undefined> = []
    const epoch = () => stored(auth).credentialEpoch

    await signIn(issuer, auth, { subject: 'alice', email: 'a@example.com' })
    keys.push(auth.profileKey())
    expect(epoch()).toBe(1)

    // A refresh, even one that returns a new ID token, keeps the key.
    const data = stored(auth)
    data.sessions[0].expiresAt = Date.now()
    auth.lifecycle.store.write(data)
    const idToken = data.sessions[0].idToken
    await auth.access()
    expect(issuer.tokenRequests.at(-1)!.grant_type).toBe('refresh_token')
    expect(activeSession(stored(auth))!.idToken).toBe(idToken)
    expect(auth.profileKey()).toBe(keys[0])

    // The same account signing in again is a new commit.
    await signIn(issuer, auth, { subject: 'alice', email: 'a@example.com' })
    keys.push(auth.profileKey())
    await signIn(issuer, auth, { subject: 'bob' }, { method: 'chatgpt-new-account', clientId: 'oaiapp_two' })
    keys.push(auth.profileKey())
    await auth.activate('oaiapp_one')
    keys.push(auth.profileKey())
    await auth.signOut()
    keys.push(auth.profileKey())
    expect(keys[4]).toBeUndefined()
    await signIn(issuer, auth, { subject: 'alice', email: 'a@example.com' })
    keys.push(auth.profileKey())
    // A terminal refresh error.
    const expiring = stored(auth)
    expiring.sessions.find((session) => session.clientId === expiring.active)!.expiresAt = Date.now()
    auth.lifecycle.store.write(expiring)
    issuer.onToken = () => ({ status: 400, body: { error: 'invalid_grant' } })
    await expect(auth.access()).rejects.toMatchObject({ failure: 'expired' })
    issuer.onToken = undefined
    expect(auth.profileKey()).toBeUndefined()
    expect(epoch()).toBe(7)

    const defined = keys.filter((key): key is string => key !== undefined)
    expect(new Set(defined).size).toBe(defined.length)
  })

  it('sign-in, activation and sign-out stop what used the old connection before any revocation', async () => {
    const home = homes()
    const order: string[] = []
    issuer.onRevoke = () => {
      order.push('revoke')
      return { status: 200 }
    }
    const auth = chatgptAuth(issuer, home, { onCredentialChange: async (change) => { order.push(change) } })
    await signIn(issuer, auth, { subject: 'alice' })
    await signIn(issuer, auth, { subject: 'bob' }, { method: 'chatgpt-new-account', clientId: 'oaiapp_two' })
    await auth.activate('oaiapp_one')
    await auth.signOut()
    expect(order).toEqual(['sign_in', 'sign_in', 'activation', 'sign_out', 'revoke'])
  })
})

describe('sign-out and deletion', () => {
  it('revokes with the issued client id and keeps the registration and host id', async () => {
    const home = homes()
    const auth = chatgptAuth(issuer, home)
    const { link } = await signIn(issuer, auth, { subject: 'alice', email: 'a@example.com' })
    const refreshToken = activeSession(stored(auth))!.refreshToken
    expect(await auth.signOut()).toEqual({ confirmed: true })
    expect(issuer.revokeRequests).toEqual([{ token: refreshToken, token_type_hint: 'refresh_token', client_id: 'oaiapp_one' }])
    expect(auth.status()).toMatchObject({ state: 'signed_out' })
    expect(stored(auth).registrations.map((registration) => registration.clientId)).toEqual(['oaiapp_one'])
    const again = await signIn(issuer, auth, { subject: 'alice', email: 'a@example.com' })
    expect(again.link.searchParams.get('client_id')).toBe('oaiapp_one')
    expect(again.link.searchParams.get('ext_agent_host_id')).toBe(link.searchParams.get('ext_agent_host_id'))
  })

  it('retries a 5xx three times, then says revocation was not confirmed', async () => {
    const home = homes()
    seed(home.profileHome, [{ clientId: 'oaiapp_a', subject: 'alice', life: 30 * MINUTE }])
    const auth = chatgptAuth(issuer, home)
    issuer.onRevoke = () => ({ status: 503 })
    expect(await auth.signOut()).toEqual({ confirmed: false, message: 'Signed out in Mousse. Remote revocation could not be confirmed; disconnect Mousse in ChatGPT Settings.' })
    expect(issuer.revokeRequests).toHaveLength(3)
    expect(auth.status().state).toBe('signed_out')
  })

  it('does not retry a 4xx', async () => {
    const home = homes()
    seed(home.profileHome, [{ clientId: 'oaiapp_a', subject: 'alice', life: 30 * MINUTE }])
    const auth = chatgptAuth(issuer, home)
    issuer.onRevoke = () => ({ status: 400, body: { error: 'invalid_request' } })
    expect((await auth.signOut()).confirmed).toBe(false)
    expect(issuer.revokeRequests).toHaveLength(1)
  })

  it('instance deletion leaves a fenced empty store, revokes every saved token and keeps the host id', async () => {
    const home = homes()
    seed(home.profileHome, [
      { clientId: 'oaiapp_a', subject: 'alice', life: 30 * MINUTE },
      { clientId: 'oaiapp_b', subject: 'bob', life: 30 * MINUTE }
    ])
    const auth = chatgptAuth(issuer, home)
    const { ensureChatGptHostId } = await import('../../../src/mms/harness/chatgpt/hostId')
    const hostId = ensureChatGptHostId(home.installationHome)
    expect(await auth.deleteInstance()).toEqual({ confirmed: true })
    expect(issuer.revokeRequests.map((request) => request.token).sort()).toEqual(['rt-oaiapp_a', 'rt-oaiapp_b'])
    expect(auth.status().state).toBe('signed_out')
    expect(stored(auth)).toEqual({ ...emptyStore(), revision: expect.any(Number), credentialEpoch: 2, signInFence: 2 })
    expect(ensureChatGptHostId(home.installationHome)).toBe(hostId)
  })

  it('a stop hook that fails keeps the revocation pending until a retry stops and revokes', async () => {
    const home = homes()
    seed(home.profileHome, [{ clientId: 'oaiapp_a', subject: 'alice', life: 30 * MINUTE }])
    let failStop = true
    const order: string[] = []
    issuer.onRevoke = () => {
      order.push('revoke')
      return { status: 200 }
    }
    const auth = chatgptAuth(issuer, home, {
      onCredentialChange: async () => {
        order.push('stop')
        if (failStop) throw new Error('app-server did not exit')
      }
    })
    await expect(auth.signOut()).rejects.toThrow('app-server did not exit')
    expect(issuer.revokeRequests).toHaveLength(0)
    // Signed out locally; the token waits, encrypted with the store, for a stop that succeeds.
    expect(auth.status()).toMatchObject({ state: 'signed_out', revocationPending: true })
    expect(stored(auth).pendingRevocations).toEqual([{ clientId: 'oaiapp_a', refreshToken: 'rt-oaiapp_a' }])
    failStop = false
    expect(await auth.signOut()).toEqual({ confirmed: true })
    expect(order).toEqual(['stop', 'stop', 'revoke'])
    expect(issuer.revokeRequests[0].token).toBe('rt-oaiapp_a')
    expect(stored(auth).pendingRevocations).toEqual([])
    expect(auth.status()).not.toHaveProperty('revocationPending')
  })

  it('a holder suspended past the lock max hold cannot overwrite what happened meanwhile', async () => {
    const home = homes()
    seed(home.profileHome, [{ clientId: 'oaiapp_a', subject: 'alice', life: 0 }])
    const sleeper = chatgptAuth(issuer, home)
    const hold = holdTokenEndpoint()
    const refresh = sleeper.access()
    await hold.sent()
    // The refreshing process is suspended for more than 5 minutes: its lock reads as expired, and
    // another process takes it over (the lock tests cover that takeover) and signs out. Callers in
    // this process would queue behind the sleeper, so the other process is played by a bare store
    // writer that takes the expired lock.
    const lock = JSON.parse(readFileSync(sleeper.lifecycle.lockPath, 'utf8'))
    writeFileSync(sleeper.lifecycle.lockPath, JSON.stringify({ ...lock, acquiredAt: new Date(Date.now() - 10 * MINUTE).toISOString() }))
    expect(tryAcquireOnceForTests(sleeper.lifecycle.lockPath, 5 * MINUTE)).toMatch(/^[0-9a-f]{32}$/)
    const other = new ChatGptStore(chatgptStorePath(home.profileHome, INSTANCE), plainCodec)
    const current = other.read()
    other.write({ ...current, active: null, sessions: [], signInFence: current.signInFence + 1, credentialEpoch: current.credentialEpoch + 1 })
    // It resumes: its renewal is refused, and the sign-out stands.
    hold.release()
    await expect(refresh).rejects.toMatchObject({ code: 'operation_busy', message: 'The ChatGPT connection changed while this was running. Try again.' })
    const after = stored(sleeper)
    expect(after.active).toBeNull()
    expect(after.sessions).toEqual([])
  })

  it('a vault that locks during the stop hook leaves the revocation pending, never falsely confirmed', async () => {
    const home = homes()
    const vault = fakeVault()
    seedWith(home.profileHome, vault, [{ clientId: 'oaiapp_a', subject: 'alice', life: 30 * MINUTE }])
    const auth = chatgptAuth(issuer, home, { codec: vault, onCredentialChange: async () => { vault.available = false } })
    expect(await auth.signOut()).toEqual({ confirmed: false, message: 'Signed out in Mousse. Revoking the old sign-in at OpenAI is still pending; sign out again to retry.' })
    expect(issuer.revokeRequests).toHaveLength(0)
    vault.available = true
    const retry = chatgptAuth(issuer, home, { codec: vault })
    expect(retry.status()).toMatchObject({ state: 'signed_out', revocationPending: true })
    expect(await retry.signOut()).toEqual({ confirmed: true })
    expect(issuer.revokeRequests.map((request) => request.token)).toEqual(['rt-oaiapp_a'])
  })

  it('a sign-in whose stop hook fails is still saved, and says the old sign-in waits', async () => {
    const home = homes()
    let fail = false
    const auth = chatgptAuth(issuer, home, { onCredentialChange: async () => { if (fail) throw new Error('app-server did not exit') } })
    await signIn(issuer, auth, { subject: 'alice' })
    const first = activeSession(stored(auth))!.refreshToken
    fail = true
    const { result } = await signIn(issuer, auth, { subject: 'alice' })
    expect(result).toEqual({ success: true, warning: 'Signed in. Work that used the previous sign-in could not be stopped yet; it is retried before the old sign-in is revoked.' })
    expect(auth.status()).toMatchObject({ state: 'signed_in', revocationPending: true })
    expect(stored(auth).pendingRevocations.map((token) => token.refreshToken)).toEqual([first])
    expect(issuer.revokeRequests).toHaveLength(0)
  })

  it('an unconfirmed revocation is reported and not retried forever', async () => {
    const home = homes()
    seed(home.profileHome, [{ clientId: 'oaiapp_a', subject: 'alice', life: 30 * MINUTE }])
    const auth = chatgptAuth(issuer, home)
    issuer.onRevoke = () => ({ status: 0 })
    expect(await auth.signOut()).toEqual({ confirmed: false, message: 'Signed out in Mousse. Remote revocation could not be confirmed; disconnect Mousse in ChatGPT Settings.' })
    expect(stored(auth).pendingRevocations).toEqual([])
  })

  it('signing in again on a connection revokes the session it replaced, after the stop', async () => {
    const home = homes()
    const order: string[] = []
    issuer.onRevoke = (form) => {
      order.push(`revoke ${form.token}`)
      return { status: 200 }
    }
    const auth = chatgptAuth(issuer, home, { onCredentialChange: async (change) => { order.push(change) } })
    await signIn(issuer, auth, { subject: 'alice' })
    const first = activeSession(stored(auth))!.refreshToken
    await signIn(issuer, auth, { subject: 'alice' })
    expect(order).toEqual(['sign_in', 'sign_in', `revoke ${first}`])
    expect(stored(auth).pendingRevocations).toEqual([])
  })

})
