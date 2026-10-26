import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chatgptHostIdPath, ensureChatGptHostId } from '../../../src/mms/harness/chatgpt/hostId'
import { ChatGptStore, chatgptStorePath, emptyStore, profileKeyOf, type ChatGptStoreData } from '../../../src/mms/harness/chatgpt/store'
import { FakeIssuer, fakeVault, guardNetwork, plainCodec, tempHomes } from './fakeIssuer'
import { chatgptAuth, signIn, startSignIn } from './signInFlow'

guardNetwork()
const homes = tempHomes()
let issuer: FakeIssuer
beforeEach(async () => {
  issuer = await new FakeIssuer().start()
})
afterEach(async () => {
  await issuer.stop()
})

const SAMPLE: ChatGptStoreData = {
  version: 1,
  revision: 0,
  credentialEpoch: 3,
  signInFence: 2,
  active: 'oaiapp_a',
  registrations: [{ clientId: 'oaiapp_a', subject: 'alice', email: 'a@example.com', label: 'Connection 1', redirectPath: '/auth/callback', sharing: true }],
  sessions: [{ clientId: 'oaiapp_a', accessToken: 'secret-access', refreshToken: 'secret-refresh', idToken: 'secret-id', expiresAt: 1, earliestRefreshAt: null, scopes: ['openid'], savedAt: 1 }],
  pendingRevocations: [{ clientId: 'oaiapp_a', refreshToken: 'secret-old-refresh' }]
}

describe('ChatGPT store', () => {
  it('encrypts with the vault: no token is readable on disk', () => {
    const { profileHome } = homes()
    const path = chatgptStorePath(profileHome, 'codex:managed')
    const vault = fakeVault()
    new ChatGptStore(path, vault).write(SAMPLE)
    const raw = readFileSync(path, 'utf8')
    expect(Object.keys(JSON.parse(raw))).toEqual(['__mousse_encrypted_v1'])
    expect(raw).not.toContain('secret')
    expect(new ChatGptStore(path, vault).read()).toEqual(SAMPLE)
    // The instance id is made safe for a path.
    expect(path).toBe(join(profileHome, 'harness', 'codex_managed', 'chatgpt.json'))
  })

  it('refuses to save when the required vault is unavailable, and writes nothing', () => {
    const { profileHome } = homes()
    const path = chatgptStorePath(profileHome, 'codex:managed')
    expect(() => new ChatGptStore(path, fakeVault({ available: false })).write(SAMPLE)).toThrow(expect.objectContaining({ code: 'unsupported', failure: 'storage' }))
    expect(existsSync(path)).toBe(false)
  })

  it('a sign-in under Electron without a vault fails typed before the browser opens, and saves nothing', async () => {
    const home = homes()
    const auth = chatgptAuth(issuer, home, { codec: fakeVault({ available: false }) })
    const flow = startSignIn(auth)
    expect(await flow.result).toEqual({ success: false, failure: 'storage', error: "Mousse can't save the ChatGPT connection securely because the system keychain is unavailable." })
    expect(flow.events.some((event) => event.type === 'auth_url')).toBe(false)
    expect(existsSync(auth.lifecycle.store.path)).toBe(false)
  })

  it.each([
    ['a plain daemon', () => plainCodec],
    ['Electron with the vault locked', () => fakeVault({ available: false })]
  ])('an encrypted store that %s cannot open is kept, never set aside or downgraded', async (_name, codec) => {
    const home = homes()
    const path = chatgptStorePath(home.profileHome, 'codex:managed')
    new ChatGptStore(path, fakeVault()).write(SAMPLE)
    const before = readFileSync(path, 'utf8')
    const auth = chatgptAuth(issuer, home, { codec: codec() })
    expect(auth.status()).toMatchObject({ state: 'unreadable', message: expect.stringContaining('system keychain is unavailable') })
    const flow = startSignIn(auth)
    expect(await flow.result).toMatchObject({ success: false, failure: 'storage_locked' })
    expect(flow.events.some((event) => event.type === 'auth_url')).toBe(false)
    await expect(auth.access()).rejects.toMatchObject({ failure: 'storage_locked' })
    await expect(auth.deleteInstance()).rejects.toMatchObject({ failure: 'storage_locked' })
    expect(readFileSync(path, 'utf8')).toBe(before)
    expect(readdirSync(dirname(path)).filter((name) => name.startsWith('chatgpt.json'))).toEqual(['chatgpt.json'])
  })

  it('a store written by a newer Mousse is kept and fails typed', async () => {
    const home = homes()
    const path = chatgptStorePath(home.profileHome, 'codex:managed')
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify({ version: 2, whatever: true }))
    const auth = chatgptAuth(issuer, home)
    const flow = startSignIn(auth)
    expect(await flow.result).toMatchObject({ success: false, failure: 'storage_newer' })
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ version: 2, whatever: true })
  })

  it('a corrupt encrypted envelope may only be replaced by an encrypted store', async () => {
    const home = homes()
    const path = chatgptStorePath(home.profileHome, 'codex:managed')
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify({ __mousse_encrypted_v1: '!!not base64' }))
    const plain = chatgptAuth(issuer, home)
    const flow = startSignIn(plain)
    expect(await flow.result).toMatchObject({ success: false, failure: 'storage' })
    expect(flow.events.some((event) => event.type === 'auth_url')).toBe(false)
    expect(readFileSync(path, 'utf8')).toContain('!!not base64')
    // With a working vault, the corrupt file is set aside and the new one is encrypted.
    const vaulted = chatgptAuth(issuer, home, { codec: fakeVault() })
    expect((await signIn(issuer, vaulted, { subject: 'alice' })).result).toEqual({ success: true })
    expect(readFileSync(path, 'utf8')).toContain('__mousse_encrypted_v1')
  })

  it('never downgrades an encrypted file to plain text', () => {
    const { profileHome } = homes()
    const path = chatgptStorePath(profileHome, 'i')
    const vault = { ...fakeVault(), encryptionRequired: false }
    new ChatGptStore(path, vault).write(SAMPLE)
    const store = new ChatGptStore(path, vault)
    store.read()
    vault.canEncrypt = () => false
    expect(() => store.write({ ...SAMPLE, credentialEpoch: 4 })).not.toThrow()
    expect(readFileSync(path, 'utf8')).toContain('__mousse_encrypted_v1')
  })

  it('a write is refused when another writer saved a newer revision since this one read', () => {
    const { profileHome } = homes()
    const path = chatgptStorePath(profileHome, 'i')
    const plain = { canEncrypt: () => false, encrypt: () => null, decrypt: () => null }
    const first = new ChatGptStore(path, plain)
    first.read()
    first.write({ ...SAMPLE })
    const stale = new ChatGptStore(path, plain)
    const seen = stale.read()
    first.write({ ...first.read(), credentialEpoch: 9 })
    expect(() => stale.write({ ...seen, active: null })).toThrow(expect.objectContaining({ code: 'operation_busy' }))
    expect(new ChatGptStore(path, plain).read()).toMatchObject({ credentialEpoch: 9, active: 'oaiapp_a', revision: 2 })
    // A store never read expects no file, so it cannot overwrite one blindly.
    expect(() => new ChatGptStore(path, plain).write({ ...SAMPLE })).toThrow(expect.objectContaining({ code: 'operation_busy' }))
  })

  it.skipIf(process.platform === 'win32')('a plain store is written with mode 0600', () => {
    const { profileHome } = homes()
    const path = chatgptStorePath(profileHome, 'i')
    new ChatGptStore(path, { canEncrypt: () => false, encrypt: () => null, decrypt: () => null }).write(SAMPLE)
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  it('an unreadable file fails typed; a new sign-in sets it aside and starts fresh', async () => {
    const home = homes()
    const auth = chatgptAuth(issuer, home)
    mkdirSync(dirname(auth.lifecycle.store.path), { recursive: true })
    writeFileSync(auth.lifecycle.store.path, '{"version":1,')
    expect(() => auth.lifecycle.read()).toThrow(expect.objectContaining({ failure: 'storage' }))
    expect(auth.status()).toMatchObject({ state: 'unreadable' })
    expect((await signIn(issuer, auth, { subject: 'alice' })).result).toEqual({ success: true })
    expect(readdirSync(dirname(auth.lifecycle.store.path)).some((name) => name.startsWith('chatgpt.json.corrupt-'))).toBe(true)
  })

  it('the profile key covers client, subject, ID token and epoch', () => {
    const key = profileKeyOf(SAMPLE)
    expect(key).toMatch(/^[0-9a-f]{64}$/)
    expect(profileKeyOf({ ...SAMPLE, credentialEpoch: 4 })).not.toBe(key)
    expect(profileKeyOf({ ...SAMPLE, sessions: [{ ...SAMPLE.sessions[0], idToken: 'other' }] })).not.toBe(key)
    expect(profileKeyOf({ ...SAMPLE, sessions: [{ ...SAMPLE.sessions[0], accessToken: 'rotated', refreshToken: 'rotated' }] })).toBe(key)
    expect(profileKeyOf({ ...SAMPLE, active: null })).toBeUndefined()
    expect(profileKeyOf(emptyStore())).toBeUndefined()
  })
})

describe('ChatGPT host id', () => {
  it('is created once per installation and survives sign-out', async () => {
    const home = homes()
    const auth = chatgptAuth(issuer, home)
    expect(existsSync(chatgptHostIdPath(home.installationHome))).toBe(false)
    const { link } = await signIn(issuer, auth, { subject: 'alice' })
    const hostId = ensureChatGptHostId(home.installationHome)
    expect(hostId).toMatch(/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(link.searchParams.get('ext_agent_host_id')).toBe(hostId)
    await auth.signOut()
    expect(ensureChatGptHostId(home.installationHome)).toBe(hostId)
    expect(JSON.parse(readFileSync(chatgptHostIdPath(home.installationHome), 'utf8'))).toEqual({ version: 1, hostId })
    // A second profile of the installation is the same host.
    const other = chatgptAuth(issuer, { profileHome: join(home.profileHome, '..', 'profile-2'), installationHome: home.installationHome })
    const second = await signIn(issuer, other, { subject: 'bob' })
    expect(second.link.searchParams.get('ext_agent_host_id')).toBe(hostId)
  })

  it('leaves no temporary files behind', () => {
    const { installationHome } = homes()
    ensureChatGptHostId(installationHome)
    ensureChatGptHostId(installationHome)
    expect(readdirSync(dirname(chatgptHostIdPath(installationHome)))).toEqual(['chatgpt-host.json'])
  })
})
