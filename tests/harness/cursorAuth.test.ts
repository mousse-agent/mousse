/**
 * Cursor sign-in (agent CLIs plan §6 "Auth"): the account sign-in mints a key into Mousse's vault
 * (never `~/.cursor/sdk`), a late success after a cancel changes nothing, an API key wins over the
 * account's key, expiry and renewal, identity read without a network call, and sign-out.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProviderLoginEvent } from '../../src/shared/providerAuth'
import { cursorDriver, cursorKeySubject, RENEW_BEFORE_MS } from '../../src/mms/harness/drivers/cursor'
import type { DriverContext, DriverRuntime } from '../../src/mms/harness/driver'
import { instanceEnv } from '../../src/mms/harness/env'
import { UserQuestionService } from '../../src/mms/orchestrator/UserQuestionService'
import { LoginSession } from '../../src/mms/providers/LoginSession'
import { FakeCursorHost, hostFailure } from './fakeCursorHost'

const dirs: string[] = []
const runtimes: DriverRuntime[] = []
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.stop()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function setup(handlers: ConstructorParameters<typeof FakeCursorHost>[0] = {}, options: { now?: () => number } = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), 'mousse-cursor-auth-'))
  dirs.push(stateDir)
  const host = new FakeCursorHost({ me: (params) => ({ userId: params.apiKey === 'user-key' ? 7 : 42 }), models: () => ({ models: [{ id: 'gpt-5', displayName: 'GPT-5' }] }), ...handlers })
  const context: DriverContext = {
    instanceId: 'cursor:work',
    builtIn: false,
    config: { home: 'default', displayName: 'Work' },
    env: instanceEnv({ instanceId: 'cursor:work', driver: 'cursor', configRevision: 0, searchPath: [], base: { PATH: process.env.PATH ?? '', CURSOR_API_KEY: 'ambient-key' } }),
    profileHome: stateDir,
    installationHome: stateDir,
    stateDir,
    questions: new UserQuestionService(),
    findBinary: () => undefined,
    changed: () => {}
  }
  const runtime = cursorDriver({ connect: host.connect, ...(options.now ? { now: options.now } : {}) }).create(context)
  runtimes.push(runtime)
  const session = new LoginSession('login-1')
  const events: ProviderLoginEvent[] = []
  session.on('event', (event: ProviderLoginEvent) => events.push(event))
  const secrets = () => {
    try {
      return JSON.parse(readFileSync(join(stateDir, 'secrets.json'), 'utf8')) as Record<string, string>
    } catch {
      return {}
    }
  }
  return { host, runtime, session, events, secrets, stateDir }
}

describe('Cursor account sign-in', () => {
  it('shows the link, keeps the minted key in the vault with the account from `me`, and lists the models', async () => {
    const { host, runtime, session, events, secrets, stateDir } = setup({
      login: (params, fake) => {
        fake.emit({ event: 'login_url', loginId: String(params.loginId), url: 'https://cursor.com/loginDeepControl?challenge=x' })
        return { apiKey: 'minted-key', apiKeyExpiresAtMs: Date.now() + 90 * 86_400_000 }
      }
    })
    const result = await runtime.signIn!(session, '/tmp', 'account')
    expect(result).toMatchObject({ success: true })
    expect(events).toContainEqual(expect.objectContaining({ type: 'auth_url', url: 'https://cursor.com/loginDeepControl?challenge=x' }))
    expect(host.calls('me')).toEqual([{ apiKey: 'minted-key' }])
    expect(secrets()).toMatchObject({ accountKey: 'minted-key', accountSubject: 'cursor-user:42' })
    // The state file holds no secret.
    expect(readFileSync(join(stateDir, 'cursor.json'), 'utf8')).not.toContain('minted-key')
    expect(await runtime.identity!(new AbortController().signal)).toBe('cursor-user:42')
    expect(await runtime.auth({ force: false })).toMatchObject({ state: 'signed_in', methodLabel: 'Cursor account', subject: 'cursor-user:42' })
    await vi.waitFor(() => expect(runtime.models().map((model) => model.id)).toEqual(['default', 'gpt-5']))
    // Identity at admission never calls Cursor.
    expect(host.calls('me')).toHaveLength(1)
  })

  it('drops a success that arrives after the user cancelled', async () => {
    const minted = deferred<{ apiKey: string }>()
    const { host, runtime, session, secrets } = setup({ login: () => minted.promise, loginCancel: () => ({ cancelled: true }) })
    const signing = runtime.signIn!(session, '/tmp', 'account')
    await vi.waitFor(() => expect(host.calls('login')).toHaveLength(1))
    session.abort.abort()
    await vi.waitFor(() => expect(host.calls('loginCancel')).toHaveLength(1))
    minted.resolve({ apiKey: 'late-key' })
    expect(await signing).toMatchObject({ success: false, error: 'Login cancelled' })
    expect(secrets().accountKey).toBeUndefined()
    expect(await runtime.auth({ force: false })).toMatchObject({ state: 'signed_out' })
    expect(runtime.configured()).toBe(false)
  })
})

describe('Cursor keys', () => {
  it('an API key wins over the account key, for identity and for turns', async () => {
    const { host, runtime, session } = setup({
      login: () => ({ apiKey: 'minted-key' }),
      create: () => ({ agentId: 'agent-1' }),
      send: (_params, fake) => {
        setTimeout(() => fake.emit({ event: 'run_end', runId: 'run-1', status: 'finished' }), 1)
        return { runId: 'run-1' }
      }
    })
    await runtime.signIn!(session, '/tmp', 'account')
    const pasting = new LoginSession('login-2')
    pasting.on('event', (event: ProviderLoginEvent) => {
      if (event.type === 'prompt') pasting.respond({ sessionId: 'login-2', kind: 'prompt', value: 'user-key' })
    })
    expect(await runtime.signIn!(pasting, '/tmp', 'api_key')).toMatchObject({ success: true })
    expect(await runtime.identity!(new AbortController().signal)).toBe('cursor-user:7')
    expect(await runtime.auth({ force: false })).toMatchObject({ state: 'signed_in', methodLabel: 'API key' })
    await runtime.adapter.startTurn(
      { threadId: 't', instanceId: 'cursor:work', llmProvider: '', model: 'default', mode: 'agent', prompt: 'hi', cwd: '/tmp', nativeHistory: '', signal: new AbortController().signal } as never,
      { text: () => {}, thinking: () => {}, tool: () => {}, progress: () => {}, providerRef: () => {}, steerAccepted: () => {}, usage: () => {} } as never,
      { drainSteer: () => undefined, heartbeat: () => {} } as never,
      { mcp: null, context: { nativeHistoryAfterTurn: (text: string) => text } } as never
    )
    expect(host.calls('create')[0]).toMatchObject({ apiKey: 'user-key' })
  })

  it('asks which way to sign in, account first', async () => {
    const { runtime, session, events } = setup({ login: () => ({ apiKey: 'minted-key' }) })
    session.on('event', (event: ProviderLoginEvent) => {
      if (event.type === 'select') session.respond({ sessionId: 'login-1', kind: 'select', value: 'account' })
    })
    expect(await runtime.signIn!(session, '/tmp')).toMatchObject({ success: true })
    const select = events.find((event) => event.type === 'select') as Extract<ProviderLoginEvent, { type: 'select' }>
    expect(select.options.map((option) => option.label)).toEqual(['Sign in with your Cursor account', 'API key'])
  })

  it('falls back to the key fingerprint when Cursor cannot say who it belongs to, and refuses a key Cursor rejects', async () => {
    let refuse = false
    const { runtime } = setup({
      me: () => {
        throw refuse ? hostFailure('invalid key', { auth: true, name: 'AuthenticationError' }) : hostFailure('offline', { name: 'NetworkError' })
      }
    })
    await runtime.adoptApiKey!('team-key')
    expect(await runtime.identity!(new AbortController().signal)).toBe(cursorKeySubject('team-key'))
    refuse = true
    await expect(runtime.adoptApiKey!('bad-key')).rejects.toThrow('Cursor refused this key.')
    expect(await runtime.identity!(new AbortController().signal)).toBe(cursorKeySubject('team-key'))
  })

  it('offers Sign in again a week before the account key expires, and treats an expired key as signed out', async () => {
    let now = 1_000_000
    const { runtime, session } = setup({ login: () => ({ apiKey: 'minted-key', apiKeyExpiresAtMs: 1_000_000 + RENEW_BEFORE_MS + 60_000 }) }, { now: () => now })
    await runtime.signIn!(session, '/tmp', 'account')
    expect(await runtime.auth({ force: false })).toMatchObject({ state: 'signed_in' })
    expect((await runtime.auth({ force: false })).message).toBeUndefined()
    now += 120_000
    expect(await runtime.auth({ force: false })).toMatchObject({ state: 'signed_in', message: expect.stringMatching(/Sign in again to renew it/) })
    now += RENEW_BEFORE_MS
    expect(await runtime.auth({ force: false })).toMatchObject({ state: 'expired' })
    expect(runtime.configured()).toBe(false)
    expect(await runtime.identity!(new AbortController().signal)).toBeUndefined()
  })

  it('a key Cursor refuses during a turn signs the entry out', async () => {
    const { runtime } = setup({
      create: () => ({ agentId: 'agent-1' }),
      send: (_params, fake) => {
        setTimeout(() => fake.emit({ event: 'run_end', runId: 'run-1', status: 'error', error: { message: 'Unauthorized', auth: true } }), 1)
        return { runId: 'run-1' }
      },
      close: () => ({})
    })
    await runtime.adoptApiKey!('user-key')
    await expect(runtime.adapter.startTurn(
      { threadId: 't', instanceId: 'cursor:work', llmProvider: '', model: 'default', mode: 'agent', prompt: 'hi', cwd: '/tmp', nativeHistory: '', signal: new AbortController().signal } as never,
      { text: () => {}, thinking: () => {}, tool: () => {}, progress: () => {}, providerRef: () => {}, steerAccepted: () => {}, usage: () => {} } as never,
      { drainSteer: () => undefined, heartbeat: () => {} } as never,
      { mcp: null, context: { nativeHistoryAfterTurn: (text: string) => text } } as never
    )).rejects.toThrow(/Sign in to Work/)
    expect(await runtime.auth({ force: false })).toMatchObject({ state: 'signed_out', message: expect.stringMatching(/refused/) })
    expect(runtime.configured()).toBe(false)
  })

  it('signs out by forgetting the keys, and says the minted key stays valid on Cursor', async () => {
    const { runtime, session, secrets } = setup({ login: () => ({ apiKey: 'minted-key' }) })
    await runtime.signIn!(session, '/tmp', 'account')
    await runtime.signOut!()
    expect(secrets()).toEqual({})
    expect(await runtime.auth({ force: false })).toMatchObject({ state: 'signed_out', message: expect.stringMatching(/stays valid until it expires/) })
  })

  it('never reads an ambient CURSOR_API_KEY', async () => {
    const { runtime } = setup()
    expect(await runtime.auth({ force: false })).toMatchObject({ state: 'signed_out' })
    expect(runtime.configured()).toBe(false)
  })
})
