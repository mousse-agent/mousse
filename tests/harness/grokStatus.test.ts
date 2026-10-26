/**
 * Grok's sign-in as status reads it, without starting Grok (agent CLIs plan §2, §5): an API key
 * first, then anything that signs Grok in some other way reads unknown, then the home's
 * `auth.json`. A credential replaced outside Mousse is a new account.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { instanceEnv } from '../../src/mms/harness/env'
import { grokCredential, grokKeySubject, overrideTables } from '../../src/mms/harness/grok/credential'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function homes() {
  const root = mkdtempSync(join(tmpdir(), 'mousse-grok-status-'))
  dirs.push(root)
  const home = join(root, 'home')
  const system = join(root, 'system')
  mkdirSync(home, { recursive: true })
  mkdirSync(system, { recursive: true })
  return { home, system }
}

const NOW = Date.parse('2026-10-26T12:00:00Z')

function account(home: string, entries: Record<string, Record<string, unknown>>) {
  writeFileSync(join(home, 'auth.json'), JSON.stringify(Object.fromEntries(Object.entries(entries).map(([client, entry]) => [`https://auth.x.ai::${client}`, entry]))))
}

const read = (home: string, system: string, env: NodeJS.ProcessEnv = {}) => grokCredential({ env: { ...env, GROK_HOME: home }, systemDir: system, now: NOW })

describe('the Grok credential', () => {
  it('reads the signed-in account, a token due for renewal, an expired one and no sign-in', () => {
    const { home, system } = homes()
    expect(read(home, system)).toEqual({ kind: 'none' })
    account(home, { c1: { user_id: 'user-1', expires_at: '2026-10-27T00:00:00Z', refresh_token: 'r', auth_mode: 'oidc' } })
    expect(read(home, system)).toEqual({ kind: 'account', state: 'signed_in', subject: 'user-1', methodLabel: 'Grok account' })
    account(home, { c1: { user_id: 'user-1', expires_at: '2026-10-25T00:00:00Z', refresh_token: 'r' } })
    expect(read(home, system)).toMatchObject({ state: 'refreshing', subject: 'user-1' })
    account(home, { c1: { user_id: 'user-1', expires_at: '2026-10-25T00:00:00Z' } })
    expect(read(home, system)).toMatchObject({ state: 'expired' })
    account(home, { c1: { user_id: 'user-1', expires_at: '2026-10-27T00:00:00Z', auth_mode: 'api_key' } })
    expect(read(home, system)).toMatchObject({ state: 'signed_in', methodLabel: 'API key' })
  })

  it('takes an API key first, as an HMAC subject that never contains the key', () => {
    const { home, system } = homes()
    account(home, { c1: { user_id: 'user-1', expires_at: '2026-10-27T00:00:00Z' } })
    const found = read(home, system, { XAI_API_KEY: 'xai-secret' })
    expect(found).toMatchObject({ kind: 'api_key', subject: grokKeySubject('xai-secret') })
    expect(grokKeySubject('xai-secret')).not.toContain('xai-secret')
  })

  it.each([
    'GROK_AUTH', 'GROK_AUTH_PROVIDER_COMMAND', 'GROK_OAUTH2_CLIENT_ID', 'GROK_OIDC_ISSUER', 'GROK_CONFIG', 'GROK_CONFIG_PATH',
    'GROK_LOCAL_AUTH', 'GROK_CLI_CHAT_PROXY_BASE_URL', 'GROK_MODELS_BASE_URL'
  ])('reads unknown when %s is set', (name) => {
    const { home, system } = homes()
    account(home, { c1: { user_id: 'user-1', expires_at: '2026-10-27T00:00:00Z' } })
    expect(read(home, system, { [name]: 'x' })).toMatchObject({ kind: 'unknown' })
  })

  it('does not count the referrer Mousse sets itself as an override', () => {
    const { home, system } = homes()
    account(home, { c1: { user_id: 'user-1', expires_at: '2026-10-27T00:00:00Z' } })
    expect(read(home, system, { GROK_OAUTH2_REFERRER: 'mousse' })).toMatchObject({ kind: 'account', subject: 'user-1' })
  })

  it.each(['config.toml', 'managed_config.toml', 'requirements.toml'])('reads unknown when the home or the system %s points the sign-in elsewhere', (file) => {
    for (const where of ['home', 'system'] as const) {
      const { home, system } = homes()
      account(home, { c1: { user_id: 'user-1', expires_at: '2026-10-27T00:00:00Z' } })
      writeFileSync(join(where === 'home' ? home : system, file), '[cli]\ninstaller = "npm"\n\n[auth]\nprovider = "corp"\n')
      expect(read(home, system)).toMatchObject({ kind: 'unknown', reason: expect.stringContaining(file) })
    }
  })

  it('finds override tables, dotted keys and nested tables, and ignores comments and other tables', () => {
    expect(overrideTables('[grok_com_config]\nurl = "x"')).toEqual(['grok_com_config'])
    expect(overrideTables('endpoints.chat = "https://x"')).toEqual(['endpoints'])
    expect(overrideTables('[endpoints.models]\nurl = "x"')).toEqual(['endpoints'])
    expect(overrideTables('# [auth]\n[cli]\nauth = "not top level"\npermission_mode = "always-approve"')).toEqual([])
  })

  it('reads unknown when one home holds two accounts, or auth.json cannot be read', () => {
    const { home, system } = homes()
    account(home, { c1: { user_id: 'user-1', expires_at: '2026-10-27T00:00:00Z' }, c2: { user_id: 'user-2', expires_at: '2026-10-27T00:00:00Z' } })
    expect(read(home, system)).toMatchObject({ kind: 'unknown' })
    writeFileSync(join(home, 'auth.json'), '{not json')
    expect(read(home, system)).toMatchObject({ kind: 'unknown' })
  })

  it('gives an account replaced outside Mousse a new subject', () => {
    const { home, system } = homes()
    account(home, { c1: { user_id: 'user-1', expires_at: '2026-10-27T00:00:00Z' } })
    const before = read(home, system)
    account(home, { c1: { user_id: 'user-2', expires_at: '2026-10-27T00:00:00Z' } })
    expect(read(home, system)).not.toEqual(before)
    expect(read(home, system)).toMatchObject({ subject: 'user-2' })
  })

  it('in a private home, drops an ambient sign-in command and key, so the account is the home’s own', () => {
    const { home, system } = homes()
    account(home, { c1: { user_id: 'user-1', expires_at: '2026-10-27T00:00:00Z' } })
    const env = instanceEnv({ instanceId: 'grok:work', driver: 'grok', configRevision: 0, home, searchPath: [], base: { GROK_AUTH_PROVIDER_COMMAND: '/bin/corp-token', XAI_API_KEY: 'ambient', GROK_OIDC_ISSUER: 'x', PATH: '/bin' } })
    expect(env.env).toMatchObject({ GROK_HOME: home, GROK_DISABLE_AUTOUPDATER: '1', GROK_OAUTH2_REFERRER: 'mousse' })
    expect(env.env.GROK_AUTH_PROVIDER_COMMAND).toBeUndefined()
    expect(env.env.XAI_API_KEY).toBeUndefined()
    expect(grokCredential({ env: env.env, systemDir: system, now: NOW })).toMatchObject({ kind: 'account', subject: 'user-1' })
    // The user's own home keeps them, and reads unknown: Mousse cannot tell the account.
    const shared = instanceEnv({ instanceId: 'grok:me', driver: 'grok', configRevision: 0, searchPath: [], base: { GROK_HOME: home, GROK_AUTH_PROVIDER_COMMAND: '/bin/corp-token' } })
    expect(grokCredential({ env: shared.env, systemDir: system, now: NOW })).toMatchObject({ kind: 'unknown' })
  })

  it('reads unknown, with no native resume, when managed config overrides the account', () => {
    const { home, system } = homes()
    account(home, { c1: { user_id: 'user-1', expires_at: '2026-10-27T00:00:00Z' } })
    writeFileSync(join(system, 'managed_config.toml'), '[auth]\nprovider_command = "corp-token"\n')
    const found = read(home, system)
    expect(found.kind).toBe('unknown')
    expect('subject' in found).toBe(false)
  })
})
