import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chatgptHostIdPath, ensureChatGptHostId } from '../../../src/mms/harness/chatgpt/hostId'
import { ChatGptStore, chatgptStorePath, emptyStore, profileKeyOf, type ChatGptStoreData } from '../../../src/mms/harness/chatgpt/store'
import { FakeIssuer, fakeVault, guardNetwork, tempHomes } from './fakeIssuer'
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

const SAMPLE: ChatGptStoreData = {
  version: 1,
  credentialEpoch: 3,
  active: 'oaiapp_a',
  registrations: [{ clientId: 'oaiapp_a', subject: 'alice', email: 'a@example.com', label: 'Connection 1', redirectPath: '/auth/callback', sharing: true }],
  sessions: [{ clientId: 'oaiapp_a', accessToken: 'secret-access', refreshToken: 'secret-refresh', idToken: 'secret-id', expiresAt: 1, earliestRefreshAt: null, scopes: ['openid'], savedAt: 1 }]
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

  it('a sign-in under Electron without a vault fails typed and saves nothing', async () => {
    const home = homes()
    const auth = chatgptAuth(issuer, home, { codec: fakeVault({ available: false }) })
    const { result } = await signIn(issuer, auth, { subject: 'alice' })
    expect(result).toEqual({ success: false, failure: 'storage', error: "Mousse can't save the ChatGPT connection securely because the system keychain is unavailable." })
    expect(existsSync(auth.lifecycle.store.path)).toBe(false)
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
