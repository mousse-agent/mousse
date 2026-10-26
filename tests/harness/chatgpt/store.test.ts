import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chatgptHostIdPath, ensureChatGptHostId } from '../../../src/mms/harness/chatgpt/hostId'
import { ChatGptLifecycle } from '../../../src/mms/harness/chatgpt/lifecycle'
import type { SecretCodec } from '../../../src/mms/providers/secretCodec'
import { ChatGptStore, chatgptStorePath, emptyStore, profileKeyOf, setSwapHookForTests, type ChatGptStoreData } from '../../../src/mms/harness/chatgpt/store'
import { FakeIssuer, fakeVault, guardNetwork, plainCodec, tempHomes } from './fakeIssuer'
import { chatgptAuth, signIn, startSignIn } from './signInFlow'

// Lets a test make renaming the store fail, as Windows does for a file another process holds open.
const fsControl = vi.hoisted(() => ({
  failRename: null as ((from: string) => boolean) | null,
  /** Called when the store checks whether a file exists, before the answer. */
  beforeExists: null as ((path: string) => void) | null
}))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    existsSync: (path: Parameters<typeof actual.existsSync>[0]) => {
      fsControl.beforeExists?.(String(path))
      return actual.existsSync(path)
    },
    renameSync: (from: Parameters<typeof actual.renameSync>[0], to: Parameters<typeof actual.renameSync>[1]) => {
      if (fsControl.failRename?.(String(from))) throw Object.assign(new Error('simulated EPERM'), { code: 'EPERM' })
      return actual.renameSync(from, to)
    }
  }
})

guardNetwork()
const homes = tempHomes()
let issuer: FakeIssuer
beforeEach(async () => {
  issuer = await new FakeIssuer().start()
})
afterEach(async () => {
  fsControl.failRename = null
  fsControl.beforeExists = null
  await issuer.stop()
})

/** The store's row as SQLite holds it. */
function row(path: string): { revision: number; fence: number; encrypted: number; payload: string } | undefined {
  const database = new DatabaseSync(path)
  try {
    return database.prepare('SELECT revision, fence, encrypted, payload FROM store WHERE id = 1').get() as never
  } finally {
    database.close()
  }
}

/** Replaces the row's payload directly, as damage or another Mousse version would. */
function setPayload(path: string, payload: string, encrypted: number): void {
  const database = new DatabaseSync(path)
  try {
    database.prepare('UPDATE store SET payload = ?, encrypted = ? WHERE id = 1').run(payload, encrypted)
  } finally {
    database.close()
  }
}

function userVersion(path: string, version?: number): number {
  const database = new DatabaseSync(path)
  try {
    if (version !== undefined) database.exec(`PRAGMA user_version=${version}`)
    return Number((database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)
  } finally {
    database.close()
  }
}

/** Overwrites the database header, as disk damage would. */
function damageHeader(path: string): void {
  const bytes = readFileSync(path)
  bytes.fill(0x21, 0, 100)
  writeFileSync(path, bytes)
}

function lifecycle(profileHome: string, codec: SecretCodec): ChatGptLifecycle {
  return new ChatGptLifecycle({ instanceId: 'codex:managed', profileHome, codec })
}

const SAMPLE = (): ChatGptStoreData => ({
  version: 1,
  revision: 0,
  incarnation: '',
  credentialEpoch: 3,
  signInFence: 2,
  active: 'oaiapp_a',
  registrations: [{ clientId: 'oaiapp_a', subject: 'alice', email: 'a@example.com', label: 'Connection 1', redirectPath: '/auth/callback', sharing: true }],
  sessions: [{ clientId: 'oaiapp_a', accessToken: 'secret-access', refreshToken: 'secret-refresh', idToken: 'secret-id', expiresAt: 1, earliestRefreshAt: null, scopes: ['openid'], savedAt: 1 }],
  pendingRevocations: [{ clientId: 'oaiapp_a', refreshToken: 'secret-old-refresh' }]
})

describe('ChatGPT store', () => {
  it('encrypts with the vault: no token is readable on disk', () => {
    const { profileHome } = homes()
    const path = chatgptStorePath(profileHome, 'codex:managed')
    // The instance id is made safe for a path.
    expect(path).toBe(join(profileHome, 'harness', 'codex_managed', 'chatgpt.db'))
    const vault = fakeVault()
    const data = SAMPLE()
    new ChatGptStore(path, vault).write(data)
    expect(data.revision).toBe(1)
    expect(row(path)).toMatchObject({ revision: 1, fence: 2, encrypted: 1 })
    expect(Object.keys(JSON.parse(row(path)!.payload))).toEqual(['__mousse_encrypted_v1'])
    for (const file of readdirSync(dirname(path))) expect(readFileSync(join(dirname(path), file)).includes('secret'), file).toBe(false)
    expect(new ChatGptStore(path, vault).read()).toEqual({ ...SAMPLE(), revision: 1, incarnation: expect.stringMatching(/^[0-9a-f-]{36}$/) })
  })

  it('refuses to save when the required vault is unavailable, and saves nothing', () => {
    const { profileHome } = homes()
    const path = chatgptStorePath(profileHome, 'codex:managed')
    expect(() => new ChatGptStore(path, fakeVault({ available: false })).write(SAMPLE())).toThrow(expect.objectContaining({ code: 'unsupported', failure: 'storage' }))
    expect(row(path)).toBeUndefined()
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
    new ChatGptStore(path, fakeVault()).write(SAMPLE())
    const before = row(path)
    const auth = chatgptAuth(issuer, home, { codec: codec() })
    expect(auth.status()).toMatchObject({ state: 'unreadable', message: expect.stringContaining('system keychain is unavailable') })
    const flow = startSignIn(auth)
    expect(await flow.result).toMatchObject({ success: false, failure: 'storage_locked' })
    expect(flow.events.some((event) => event.type === 'auth_url')).toBe(false)
    await expect(auth.access()).rejects.toMatchObject({ failure: 'storage_locked' })
    await expect(auth.signOut()).rejects.toMatchObject({ failure: 'storage_locked' })
    await expect(auth.deleteInstance()).rejects.toMatchObject({ failure: 'storage_locked' })
    expect(row(path)).toEqual(before)
    expect(readdirSync(dirname(path)).some((name) => name.includes('.corrupt-'))).toBe(false)
  })

  it('a store a newer Mousse made is kept and fails typed (newer database or newer payload)', async () => {
    const home = homes()
    const path = chatgptStorePath(home.profileHome, 'codex:managed')
    new ChatGptStore(path, plainCodec).write(SAMPLE())
    userVersion(path, 3)
    const auth = chatgptAuth(issuer, home)
    const flow = startSignIn(auth)
    expect(await flow.result).toMatchObject({ success: false, failure: 'storage_newer' })
    expect(userVersion(path)).toBe(3)
    userVersion(path, 2)
    setPayload(path, JSON.stringify({ version: 2, whatever: true }), 0)
    const before = row(path)
    expect((await startSignIn(auth).result)).toMatchObject({ success: false, failure: 'storage_newer' })
    expect(row(path)).toEqual(before)
  })

  it('a corrupt encrypted payload may only be replaced by an encrypted store, and is kept aside', async () => {
    const home = homes()
    const path = chatgptStorePath(home.profileHome, 'codex:managed')
    new ChatGptStore(path, fakeVault()).write(SAMPLE())
    setPayload(path, JSON.stringify({ __mousse_encrypted_v1: '!!not base64' }), 1)
    const before = row(path)
    const plain = chatgptAuth(issuer, home)
    const flow = startSignIn(plain)
    expect(await flow.result).toMatchObject({ success: false, failure: 'storage' })
    expect(flow.events.some((event) => event.type === 'auth_url')).toBe(false)
    expect(row(path)).toEqual(before)
    // With a working vault, the payload is set aside in the same database and the new one is encrypted.
    const vaulted = chatgptAuth(issuer, home, { codec: fakeVault() })
    expect((await signIn(issuer, vaulted, { subject: 'alice' })).result).toEqual({ success: true })
    expect(row(path)).toMatchObject({ encrypted: 1, fence: before!.fence + 2 })
    expect(new ChatGptStore(path, fakeVault()).setAside()).toBe(1)
  })

  it('never downgrades an encrypted store to plain text', () => {
    const { profileHome } = homes()
    const path = chatgptStorePath(profileHome, 'i')
    const vault = { ...fakeVault(), encryptionRequired: false }
    new ChatGptStore(path, vault).write(SAMPLE())
    const store = new ChatGptStore(path, vault)
    const data = store.read()
    vault.canEncrypt = () => false
    store.write({ ...data, credentialEpoch: 4 })
    expect(row(path)).toMatchObject({ encrypted: 1, revision: 2 })
  })

  it('a write commits only on the revision its own data was read at; other reads do not matter', () => {
    const { profileHome } = homes()
    const path = chatgptStorePath(profileHome, 'i')
    const store = new ChatGptStore(path, plainCodec)
    store.write(SAMPLE())
    const stale = store.read()
    store.write({ ...store.read(), credentialEpoch: 9 })
    // A display read on the same store object sees revision 2; the stale data still carries 1.
    expect(store.read().revision).toBe(2)
    expect(() => store.write({ ...stale, active: null })).toThrow(expect.objectContaining({ code: 'operation_busy' }))
    expect(store.read()).toMatchObject({ credentialEpoch: 9, active: 'oaiapp_a', revision: 2 })
    // Data that was never read (revision 0) cannot overwrite an existing row.
    expect(() => store.write(SAMPLE())).toThrow(expect.objectContaining({ code: 'operation_busy' }))
  })

  it('a vault that locks between the read and the write fails as storage, not as a lost race', () => {
    const { profileHome } = homes()
    const path = chatgptStorePath(profileHome, 'i')
    const vault = fakeVault()
    const store = new ChatGptStore(path, vault)
    store.write(SAMPLE())
    const data = store.read()
    vault.available = false
    expect(() => store.write({ ...data, credentialEpoch: 5 })).toThrow(expect.objectContaining({ code: 'unsupported', failure: 'storage' }))
  })

  it.skipIf(process.platform === 'win32')('a plain store is written with mode 0600', () => {
    const { profileHome } = homes()
    const path = chatgptStorePath(profileHome, 'i')
    new ChatGptStore(path, plainCodec).write(SAMPLE())
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  it('a corrupt payload fails typed; a new sign-in sets it aside with a new fence and starts fresh', async () => {
    const home = homes()
    const auth = chatgptAuth(issuer, home)
    const path = auth.lifecycle.store.path
    new ChatGptStore(path, plainCodec).write(SAMPLE())
    setPayload(path, '{"version":1,', 0)
    expect(() => auth.lifecycle.read()).toThrow(expect.objectContaining({ failure: 'storage' }))
    expect(auth.status()).toMatchObject({ state: 'unreadable' })
    expect((await signIn(issuer, auth, { subject: 'alice' })).result).toEqual({ success: true })
    expect(new ChatGptStore(path, plainCodec).setAside()).toBe(1)
  })

  it('a corrupt database file is renamed aside before a fresh one is made', async () => {
    const home = homes()
    const auth = chatgptAuth(issuer, home)
    const path = auth.lifecycle.store.path
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, 'SQLite format 3\0 but not really a database'.repeat(200))
    expect(auth.status()).toMatchObject({ state: 'unreadable' })
    expect((await signIn(issuer, auth, { subject: 'alice' })).result).toEqual({ success: true })
    expect(readdirSync(dirname(path)).some((name) => name.startsWith('chatgpt.db.corrupt-'))).toBe(true)
    expect(auth.status().state).toBe('signed_in')
  })

  it('when the damaged database cannot be renamed (Windows, held open), nothing is treated as recovered', async () => {
    const home = homes()
    const auth = chatgptAuth(issuer, home)
    const path = auth.lifecycle.store.path
    mkdirSync(dirname(path), { recursive: true })
    const damaged = 'SQLite format 3\0 but not really a database'.repeat(200)
    writeFileSync(path, damaged)
    fsControl.failRename = (from) => from === path
    const flow = startSignIn(auth)
    expect(await flow.result).toMatchObject({ success: false, failure: 'storage', error: expect.stringContaining('another Mousse window') })
    expect(flow.events.some((event) => event.type === 'auth_url')).toBe(false)
    expect(readFileSync(path, 'utf8')).toBe(damaged)
    fsControl.failRename = null
    expect((await signIn(issuer, auth, { subject: 'alice' })).result).toEqual({ success: true })
  })

  it('data read from a database that was since replaced can never commit, even at a matching revision', async () => {
    const { profileHome } = homes()
    const path = chatgptStorePath(profileHome, 'codex:managed')
    const store = new ChatGptStore(path, plainCodec)
    store.write(SAMPLE())
    store.write({ ...store.read(), credentialEpoch: 5 })
    const old = store.read()
    expect(old.revision).toBe(2)
    // The file is damaged; another process deletes the instance, which replaces the database and
    // writes its empty store at revision 2 again.
    damageHeader(path)
    await lifecycle(profileHome, plainCodec).deleteInstance()
    const replaced = store.read()
    expect(replaced.revision).toBe(2)
    expect(replaced.incarnation).not.toBe(old.incarnation)
    expect(() => store.write({ ...old, signInFence: 9 })).toThrow(expect.objectContaining({ code: 'operation_busy' }))
    expect(store.read()).toMatchObject({ active: null, sessions: [], signInFence: replaced.signInFence })
  })

  it('a damaged encrypted database that a plain daemon cannot replace stays as it was, and encryption stays required', async () => {
    const { profileHome } = homes()
    const path = chatgptStorePath(profileHome, 'codex:managed')
    new ChatGptStore(path, fakeVault()).write(SAMPLE())
    damageHeader(path)
    const before = readFileSync(path)
    const plain = lifecycle(profileHome, plainCodec)
    await expect(plain.deleteInstance()).rejects.toMatchObject({ failure: 'storage', message: expect.stringContaining('keychain') })
    expect(readFileSync(path).equals(before)).toBe(true)
    expect(readdirSync(dirname(path)).filter((name) => name.startsWith('chatgpt.db'))).toEqual(['chatgpt.db'])
    await expect(plain.prepareSignIn()).rejects.toMatchObject({ failure: 'storage' })
    // Even with the database gone, this instance never takes plain-text credentials again.
    rmSync(path)
    expect(() => new ChatGptStore(path, plainCodec).write(SAMPLE())).toThrow(expect.objectContaining({ failure: 'storage', message: expect.stringContaining('keychain') }))
  })

  it('the old journal moves aside with a damaged database, or nothing moves', async () => {
    const home = homes()
    const auth = chatgptAuth(issuer, home)
    const path = auth.lifecycle.store.path
    mkdirSync(dirname(path), { recursive: true })
    // Damaged from the first byte: with an old journal beside it, a file that still has SQLite's
    // magic can look like an empty database to SQLite.
    const damaged = 'not a database at all, damaged beyond its header '.repeat(200)
    writeFileSync(path, damaged)
    // SQLite deletes a stray journal when it closes the damaged file, so put one back right when the
    // replacement looks for it, as another process's journal would be.
    fsControl.beforeExists = (file) => {
      if (file === `${path}-wal` && !readdirSync(dirname(path)).some((name) => name.includes('.corrupt-'))) writeFileSync(file, 'old journal')
    }
    fsControl.failRename = (from) => from.endsWith('-wal')
    expect(await startSignIn(auth).result).toMatchObject({ success: false, failure: 'storage', error: expect.stringContaining('another Mousse window') })
    expect(readFileSync(path, 'utf8')).toBe(damaged)
    expect(readFileSync(`${path}-wal`, 'utf8')).toBe('old journal')
    expect(readdirSync(dirname(path)).filter((name) => name.startsWith('chatgpt.db')).sort()).toEqual(['chatgpt.db', 'chatgpt.db-wal'])
    fsControl.failRename = null
    expect((await signIn(issuer, auth, { subject: 'alice' })).result).toEqual({ success: true })
    fsControl.beforeExists = null
    const names = readdirSync(dirname(path))
    expect(names.some((name) => /^chatgpt\.db\.corrupt-.*-wal$/.test(name))).toBe(true)
    expect(auth.status().state).toBe('signed_in')
  })

  it('a rejected write never makes a plain store require encryption', () => {
    const { profileHome } = homes()
    const path = chatgptStorePath(profileHome, 'i')
    const plain = new ChatGptStore(path, plainCodec)
    plain.write(SAMPLE())
    const stale = plain.read()
    plain.write({ ...plain.read(), credentialEpoch: 7 })
    // A host with a working vault would seal this write; it loses the race.
    const vaulted = new ChatGptStore(path, { ...fakeVault(), encryptionRequired: false })
    expect(() => vaulted.write({ ...stale, active: null })).toThrow(expect.objectContaining({ code: 'operation_busy' }))
    expect(readdirSync(dirname(path)).filter((name) => name.startsWith('chatgpt.encrypted'))).toEqual([])
    expect(row(path)).toMatchObject({ encrypted: 0 })
    plain.write({ ...plain.read(), credentialEpoch: 8 })
    expect(row(path)).toMatchObject({ encrypted: 0, revision: 3 })
  })

  it('a pending encryption marker is settled from the committed row on the next open', () => {
    const { profileHome } = homes()
    const path = chatgptStorePath(profileHome, 'i')
    const directory = dirname(path)
    // Crash after an encrypted commit, before the marker was promoted: it is promoted.
    new ChatGptStore(path, fakeVault()).write(SAMPLE())
    rmSync(join(directory, 'chatgpt.encrypted'))
    writeFileSync(join(directory, 'chatgpt.encrypted.pending'), '')
    new ChatGptStore(path, fakeVault()).read()
    expect(readdirSync(directory).filter((name) => name.startsWith('chatgpt.encrypted'))).toEqual(['chatgpt.encrypted'])
    // Crash before a commit that never happened: the pending marker goes away.
    const other = chatgptStorePath(profileHome, 'j')
    new ChatGptStore(other, plainCodec).write(SAMPLE())
    writeFileSync(join(dirname(other), 'chatgpt.encrypted.pending'), '')
    new ChatGptStore(other, plainCodec).read()
    expect(readdirSync(dirname(other)).filter((name) => name.startsWith('chatgpt.encrypted'))).toEqual([])
  })

  it('a replacement that cannot take the name puts the original back, and it still reads as damaged', () => {
    const { profileHome } = homes()
    const path = chatgptStorePath(profileHome, 'codex:managed')
    new ChatGptStore(path, plainCodec).write(SAMPLE())
    damageHeader(path)
    const before = readFileSync(path)
    fsControl.failRename = (from) => from.includes('.new-')
    expect(() => new ChatGptStore(path, plainCodec).recover()).toThrow(expect.objectContaining({ failure: 'storage' }))
    fsControl.failRename = null
    expect(readFileSync(path).equals(before)).toBe(true)
    expect(readdirSync(dirname(path)).filter((name) => name.startsWith('chatgpt.db'))).toEqual(['chatgpt.db'])
    expect(() => new ChatGptStore(path, plainCodec).read()).toThrow(expect.objectContaining({ failure: 'storage' }))
  })

  it('a swap interrupted by a crash is finished on the next open, never read as a store never written', () => {
    const { profileHome } = homes()
    const path = chatgptStorePath(profileHome, 'codex:managed')
    new ChatGptStore(path, plainCodec).write(SAMPLE())
    damageHeader(path)
    setSwapHookForTests(() => {
      throw new Error('crash')
    })
    try {
      expect(() => new ChatGptStore(path, plainCodec).recover()).toThrow('crash')
    } finally {
      setSwapHookForTests(null)
    }
    expect(existsSync(path)).toBe(false)
    const after = new ChatGptStore(path, plainCodec).read()
    // The complete replacement took the name: revision 1 of a new database with a clock fence.
    expect(after).toMatchObject({ revision: 1, active: null, incarnation: expect.stringMatching(/^[0-9a-f-]{36}$/) })
    expect(after.signInFence).toBeGreaterThan(1_000_000_000_000)
    expect(readdirSync(dirname(path)).some((name) => name.endsWith('.swap') || name.includes('.new-'))).toBe(false)
  })

  it('a swap interrupted after its replacement was lost is rolled back to the damaged original', () => {
    const { profileHome } = homes()
    const path = chatgptStorePath(profileHome, 'codex:managed')
    new ChatGptStore(path, plainCodec).write(SAMPLE())
    damageHeader(path)
    const before = readFileSync(path)
    setSwapHookForTests(() => {
      for (const name of readdirSync(dirname(path))) if (name.includes('.new-')) rmSync(join(dirname(path), name))
      throw new Error('crash')
    })
    try {
      expect(() => new ChatGptStore(path, plainCodec).recover()).toThrow('crash')
    } finally {
      setSwapHookForTests(null)
    }
    expect(() => new ChatGptStore(path, plainCodec).read()).toThrow(expect.objectContaining({ failure: 'storage' }))
    expect(readFileSync(path).equals(before)).toBe(true)
  })

  it('a missing database after one was set aside is recovered, not read as never written', async () => {
    const { profileHome } = homes()
    const path = chatgptStorePath(profileHome, 'codex:managed')
    new ChatGptStore(path, plainCodec).write(SAMPLE())
    damageHeader(path)
    new ChatGptStore(path, plainCodec).recover()
    rmSync(path)
    expect(() => new ChatGptStore(path, plainCodec).read()).toThrow(expect.objectContaining({ failure: 'storage' }))
    expect(() => new ChatGptStore(path, plainCodec).write(SAMPLE())).toThrow(expect.objectContaining({ failure: 'storage' }))
    const start = await lifecycle(profileHome, plainCodec).prepareSignIn()
    expect(start.fence).toBeGreaterThan(1_000_000_000_000)
  })

  it('a database from the previous layout gains its incarnation and keeps its data', () => {
    const { profileHome } = homes()
    const path = chatgptStorePath(profileHome, 'i')
    new ChatGptStore(path, plainCodec).write(SAMPLE())
    const database = new DatabaseSync(path)
    try {
      database.exec('DROP TABLE meta; PRAGMA user_version=1;')
    } finally {
      database.close()
    }
    const data = new ChatGptStore(path, plainCodec).read()
    expect(data).toMatchObject({ revision: 1, active: 'oaiapp_a', incarnation: expect.stringMatching(/^[0-9a-f-]{36}$/) })
    expect(userVersion(path)).toBe(2)
    new ChatGptStore(path, plainCodec).write({ ...data, credentialEpoch: 6 })
  })

  it('clears replacements an interrupted swap left before saving its intent', () => {
    const { profileHome } = homes()
    const path = chatgptStorePath(profileHome, 'i')
    new ChatGptStore(path, plainCodec).write(SAMPLE())
    const old = `${path}.new-11111111-1111-4111-8111-111111111111`
    const recent = `${path}.new-22222222-2222-4222-8222-222222222222`
    writeFileSync(old, 'x')
    writeFileSync(recent, 'y')
    const longAgo = new Date(Date.now() - 10 * 60_000)
    utimesSync(old, longAgo, longAgo)
    new ChatGptStore(path, plainCodec).read()
    expect(existsSync(old)).toBe(false)
    // One in flight in another process is left alone.
    expect(existsSync(recent)).toBe(true)
  })

  it('the profile key covers client, subject, ID token and epoch', () => {
    const sample = SAMPLE()
    const key = profileKeyOf(sample)
    expect(key).toMatch(/^[0-9a-f]{64}$/)
    expect(profileKeyOf({ ...sample, credentialEpoch: 4 })).not.toBe(key)
    expect(profileKeyOf({ ...sample, sessions: [{ ...sample.sessions[0], idToken: 'other' }] })).not.toBe(key)
    expect(profileKeyOf({ ...sample, sessions: [{ ...sample.sessions[0], accessToken: 'rotated', refreshToken: 'rotated' }] })).toBe(key)
    expect(profileKeyOf({ ...sample, revision: 7, signInFence: 9 })).toBe(key)
    expect(profileKeyOf({ ...sample, active: null })).toBeUndefined()
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
