/**
 * Launch settings and the sign-out flag live in each instance's config; the vendor's own
 * settings.json keeps a mirror for older Mousse versions (plan PR 5 §4). Every fixture is a
 * profile on disk started, stopped, edited the way an older build or a crash leaves it, and started
 * again. No CLI or agent runs: sign-in checks are fakes and PATH is empty.
 */
import { readFileSync, readdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { claudeCodeDriver } from '../../src/mms/harness/drivers/claudeCode'
import { createHarnessGateway } from '../../src/mms/harness/gateway'
import { instanceStateDir } from '../../src/mms/harness/instances'
import { mirrorHash, reconcileRow, settingsMirror, type MirrorTuple } from '../../src/mms/harness/vendorMirror'
import { UserQuestionService } from '../../src/mms/orchestrator/UserQuestionService'
import { ClaudeSubscriptionProviderService } from '../../src/mms/providers/claudeSubscription/ClaudeSubscriptionProviderService'
import { ProviderInstanceService } from '../../src/mms/providers/ProviderInstanceService'
import { LoginSession } from '../../src/mms/providers/LoginSession'
import {
  executable,
  readVendor,
  readVendorText,
  removeHome,
  settingsPath,
  startProfile,
  storedConfig,
  tempHome,
  writeVendor,
  type ProfileStore,
  type StartedProfile
} from './vendorProfile'

const homes: string[] = []
const running: StartedProfile[] = []
const cleanups: Array<() => void> = []

beforeEach(() => {
  // No CLI on PATH or in a home: nothing the user installed is ever found or started.
  const empty = tempHome('mousse-empty-home-')
  homes.push(empty)
  vi.stubEnv('PATH', '')
  vi.stubEnv('Path', '')
  vi.stubEnv('HOME', empty)
  vi.stubEnv('USERPROFILE', empty)
})

afterEach(() => {
  for (const profile of running.splice(0)) profile.stop()
  for (const cleanup of cleanups.splice(0)) cleanup()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  for (const home of homes.splice(0)) removeHome(home)
})

function home(): string {
  const dir = tempHome()
  homes.push(dir)
  return dir
}

/** A profile config written before this version: built-ins seeded, no launch keys, no markers. */
function legacyStore(): ProfileStore {
  return {
    instances: {
      antigravity: { driver: 'antigravity', enabled: true },
      claude: { driver: 'claude', enabled: true },
      codex: { driver: 'codex', enabled: true }
    },
    seedVersion: 1,
    writes: []
  }
}

function start(dir: string, store: ProfileStore): StartedProfile {
  const profile = startProfile(dir, store)
  running.push(profile)
  return profile
}

function stopAll(): void {
  for (const profile of running.splice(0)) profile.stop()
}

function restart(dir: string, store: ProfileStore): StartedProfile {
  stopAll()
  return start(dir, store)
}

function snapshotOf(profile: StartedProfile, instanceId: string) {
  return profile.harness.instances.snapshots({ kind: 'device' }).then((all) => all.find((entry) => entry.instanceId === instanceId)!)
}

async function bindTurn(profile: StartedProfile, instanceId: string, llmProvider: string) {
  const resolved = profile.harness.resolveStored({ instanceId, llmProvider, model: 'default' }, { purpose: 'turn', allowDisabled: true })
  return profile.harness.bind(resolved, { mode: 'default' })
}

function setStored(store: ProfileStore, instanceId: string, patch: Record<string, unknown>): void {
  const instances = store.instances as Record<string, { config?: Record<string, unknown> }>
  instances[instanceId] = { ...instances[instanceId]!, config: { ...instances[instanceId]!.config, ...patch } }
}

describe('reconcile rows', () => {
  it('reads the five cases from the instance hash, the vendor hash and the marker', () => {
    expect(reconcileRow('i', 'v', undefined)).toBe('first_copy')
    expect(reconcileRow('x', 'x', 'm')).toBe('in_sync')
    expect(reconcileRow('i', 'm', 'm')).toBe('finish_write')
    expect(reconcileRow('m', 'v', 'm')).toBe('older_changed')
    expect(reconcileRow('i', 'v', 'm')).toBe('conflict')
  })

  it('hashes variables in any order alike, and a path differently from none', () => {
    const none: MirrorTuple = {}
    expect(mirrorHash({ env: { B: '2', A: '1' } })).toBe(mirrorHash({ env: { A: '1', B: '2' } }))
    expect(mirrorHash({ binaryPath: '/a' })).not.toBe(mirrorHash(none))
    expect(mirrorHash({ signedOut: true })).not.toBe(mirrorHash(none))
  })
})

describe('first start after the upgrade', () => {
  it('copies the vendor launch settings and sign-out into the instance, leaving the vendor files byte-for-byte', async () => {
    const dir = home()
    const claudeBin = executable(join(dir, 'bin'), 'claude')
    writeVendor(dir, 'claude', { loginPolicy: 'cli', binaryPath: claudeBin, args: ['--verbose'], env: { FOO: 'bar' } })
    writeVendor(dir, 'codex', { disconnected: true, threads: {} })
    const claudeText = readVendorText(dir, 'claude')
    const codexText = readVendorText(dir, 'codex')
    const store = legacyStore()
    const profile = start(dir, store)

    expect(storedConfig(store, 'claude')).toMatchObject({ binaryPath: claudeBin, args: ['--verbose'], env: { FOO: 'bar' }, signedOutInMousse: false, vendorMirror: expect.any(String) })
    expect(storedConfig(store, 'codex')).toMatchObject({ binaryPath: null, args: null, env: null, signedOutInMousse: true, vendorMirror: expect.any(String) })
    expect(storedConfig(store, 'antigravity')).toMatchObject({ binaryPath: null, vendorMirror: expect.any(String) })
    expect(readVendorText(dir, 'claude')).toBe(claudeText)
    expect(readVendorText(dir, 'codex')).toBe(codexText)
    // What runs now comes from the instance config.
    expect(profile.harness.launchFor('claude')).toEqual({ binaryPath: claudeBin, args: ['--verbose'], env: { FOO: 'bar' } })

    // The disconnected Codex is still signed out: no account read, not listed, nothing admitted.
    const codex = await snapshotOf(profile, 'codex')
    expect(codex.auth).toMatchObject({ state: 'signed_out', message: expect.stringContaining('Signed out in Mousse') })
    expect(codex.settingsNotice).toBeUndefined()
    expect(profile.codexAccount).not.toHaveBeenCalled()
    expect(profile.instanceMap.llmProviders().some((entry) => entry.instanceId === 'codex')).toBe(false)
    await expect(bindTurn(profile, 'codex', 'codex')).rejects.toMatchObject({ code: 'signed_out' })
  })

  it('a second start writes nothing and shows nothing', async () => {
    const dir = home()
    writeVendor(dir, 'claude', { loginPolicy: 'cli', args: ['--verbose'] })
    const store = legacyStore()
    start(dir, store)
    const writes = store.writes.length
    const second = restart(dir, store)
    expect(store.writes.length).toBe(writes)
    expect((await snapshotOf(second, 'claude')).settingsNotice).toBeUndefined()
    expect(second.harness.launchFor('claude')).toEqual({ args: ['--verbose'] })
  })

  it('leaves an unreadable vendor file alone and shows its error', async () => {
    const dir = home()
    writeVendor(dir, 'claude', '{not json')
    const store = legacyStore()
    // A program that answers --version, so the check reaches the sign-in (the settings file).
    setStored(store, 'claude', { binaryPath: process.execPath })
    const profile = start(dir, store)
    expect(storedConfig(store, 'claude')).toEqual({ binaryPath: process.execPath })
    expect(readVendorText(dir, 'claude')).toBe('{not json')
    const claude = await snapshotOf(profile, 'claude')
    expect(`${claude.auth.message ?? ''} ${claude.runs.message ?? ''}`).toMatch(/could not read/)
  })

  it('skips an unreadable instance map and reconciles at the next start', () => {
    const dir = home()
    writeVendor(dir, 'claude', { loginPolicy: 'cli', args: ['--a'] })
    const store: ProfileStore = { ...legacyStore(), unreadable: true }
    start(dir, store)
    expect(store.writes).toEqual([])
    store.unreadable = false
    restart(dir, store)
    expect(storedConfig(store, 'claude')).toMatchObject({ args: ['--a'], vendorMirror: expect.any(String) })
  })
})

describe('an older version changed the vendor file', () => {
  const cases: Array<{ name: string; edit: (settings: Record<string, unknown>, other: string) => void; launch: (other: string) => Record<string, unknown>; label: string }> = [
    { name: 'the executable', edit: (s, other) => { s.binaryPath = other }, launch: (other) => ({ binaryPath: other, args: ['--a'], env: { A: '1' } }), label: 'executable path' },
    { name: 'the args', edit: (s) => { s.args = ['--b'] }, launch: () => ({ args: ['--b'], env: { A: '1' } }), label: 'launch arguments' },
    { name: 'the variables', edit: (s) => { s.env = { B: '2' } }, launch: () => ({ args: ['--a'], env: { B: '2' } }), label: 'environment variables' },
    { name: 'args back to the default', edit: (s) => { delete s.args }, launch: () => ({ env: { A: '1' } }), label: 'launch arguments' }
  ]
  it.each(cases)('upgrade → an older build changes $name → upgrade: the older value wins and the card says so once', async ({ edit, launch, label }) => {
    const dir = home()
    const other = executable(join(dir, 'bin'), 'claude-other')
    writeVendor(dir, 'claude', { loginPolicy: 'cli', args: ['--a'], env: { A: '1' } })
    const store = legacyStore()
    start(dir, store)
    stopAll()
    // The older build edits its settings.json.
    const vendor = readVendor(dir, 'claude')
    edit(vendor, other)
    writeVendor(dir, 'claude', vendor)
    const vendorText = readVendorText(dir, 'claude')
    const second = start(dir, store)
    expect(second.harness.launchFor('claude')).toEqual(launch(other))
    expect((await snapshotOf(second, 'claude')).settingsNotice).toEqual({ kind: 'older_applied', message: `Settings changed in an older Mousse version were applied: ${label}.` })
    expect(readVendorText(dir, 'claude')).toBe(vendorText)
    // Once: the next start is in step.
    const third = restart(dir, store)
    expect((await snapshotOf(third, 'claude')).settingsNotice).toBeUndefined()
    expect(third.harness.launchFor('claude')).toEqual(launch(other))
  })
})

describe('a write that stopped part-way', () => {
  function synced(): { dir: string; store: ProfileStore } {
    const dir = home()
    writeVendor(dir, 'claude', { loginPolicy: 'cli', args: ['--a'] })
    const store = legacyStore()
    start(dir, store)
    stopAll()
    return { dir, store }
  }

  it('a crash after the instance write finishes writing the vendor file at the next start', async () => {
    const { dir, store } = synced()
    const marker = storedConfig(store, 'claude').vendorMirror
    setStored(store, 'claude', { args: ['--new'] })
    const profile = start(dir, store)
    expect(readVendor(dir, 'claude').args).toEqual(['--new'])
    expect(storedConfig(store, 'claude').vendorMirror).not.toBe(marker)
    expect(storedConfig(store, 'claude').vendorMirror).toBe(mirrorHash({ args: ['--new'] }))
    expect((await snapshotOf(profile, 'claude')).settingsNotice).toBeUndefined()
  })

  it('a crash after the vendor write only records the marker', async () => {
    const { dir, store } = synced()
    setStored(store, 'claude', { args: ['--new'] })
    writeVendor(dir, 'claude', { ...readVendor(dir, 'claude'), args: ['--new'] })
    const vendorText = readVendorText(dir, 'claude')
    const profile = start(dir, store)
    expect(readVendorText(dir, 'claude')).toBe(vendorText)
    expect(storedConfig(store, 'claude').vendorMirror).toBe(mirrorHash({ args: ['--new'] }))
    expect(profile.harness.launchFor('claude')).toEqual({ args: ['--new'] })
    expect((await snapshotOf(profile, 'claude')).settingsNotice).toBeUndefined()
  })

  it('both sides changed: this version keeps its own, says so, and "Use the older settings" applies the vendor values', async () => {
    const { dir, store } = synced()
    setStored(store, 'claude', { args: ['--mine'] })
    writeVendor(dir, 'claude', { ...readVendor(dir, 'claude'), args: ['--older'] })
    const vendorText = readVendorText(dir, 'claude')
    const profile = start(dir, store)
    expect(profile.harness.launchFor('claude')).toEqual({ args: ['--mine'] })
    expect(readVendorText(dir, 'claude')).toBe(vendorText)
    expect((await snapshotOf(profile, 'claude')).settingsNotice).toMatchObject({ kind: 'older_conflict' })
    const after = await profile.harness.instances.configure('claude', { useOlderSettings: true })
    expect(after.settingsNotice).toBeUndefined()
    expect(profile.harness.launchFor('claude')).toEqual({ args: ['--older'] })
    expect(readVendorText(dir, 'claude')).toBe(vendorText)
    const next = restart(dir, store)
    expect((await snapshotOf(next, 'claude')).settingsNotice).toBeUndefined()
  })

  it('both sides changed, then Save: the vendor file takes this version and the notice does not come back', async () => {
    const { dir, store } = synced()
    setStored(store, 'claude', { args: ['--mine'] })
    writeVendor(dir, 'claude', { ...readVendor(dir, 'claude'), args: ['--older'] })
    const profile = start(dir, store)
    await profile.harness.instances.configure('claude', { args: ['--mine'] })
    expect(readVendor(dir, 'claude').args).toEqual(['--mine'])
    const next = restart(dir, store)
    expect((await snapshotOf(next, 'claude')).settingsNotice).toBeUndefined()
    const again = restart(dir, store)
    expect((await snapshotOf(again, 'claude')).settingsNotice).toBeUndefined()
    expect(again.harness.launchFor('claude')).toEqual({ args: ['--mine'] })
  })
})

describe('sign-out across versions', () => {
  it('a sign-out here is what an older build reads; a reconnect there clears it here', async () => {
    const dir = home()
    writeVendor(dir, 'codex', { threads: { t: { codexThreadId: 'x', cwd: dir } } })
    const store = legacyStore()
    const profile = start(dir, store)
    await profile.harness.instances.signOut('codex')
    // The older decoder reads `disconnected`.
    expect(readVendor(dir, 'codex')).toMatchObject({ disconnected: true, threads: {} })
    expect(storedConfig(store, 'codex')).toMatchObject({ signedOutInMousse: true, vendorMirror: mirrorHash({ signedOut: true }) })
    stopAll()
    // The older build reconnects: it deletes the flag.
    const vendor = readVendor(dir, 'codex')
    delete vendor.disconnected
    writeVendor(dir, 'codex', vendor)
    const next = start(dir, store)
    expect(storedConfig(store, 'codex').signedOutInMousse).toBe(false)
    expect(next.harness.signedOutInMousse('codex')).toBe(false)
    expect((await snapshotOf(next, 'codex')).settingsNotice).toMatchObject({ kind: 'older_applied', message: expect.stringContaining('sign-out') })
  })

  it('a restart while signed out: no sign-in check runs, nothing is listed, nothing is admitted', async () => {
    const dir = home()
    const bin = executable(join(dir, 'bin'), 'claude')
    writeVendor(dir, 'claude', { loginPolicy: 'cli', binaryPath: bin })
    const store = legacyStore()
    const profile = start(dir, store)
    await profile.harness.instances.signOut('claude')
    const next = restart(dir, store)
    await next.harness.instances.recheck('claude')
    const claude = await snapshotOf(next, 'claude')
    expect(claude.auth).toMatchObject({ state: 'signed_out', message: 'Signed out in Mousse. Your Claude Code sign-in on this computer is unchanged.' })
    expect(next.claudeAuth).not.toHaveBeenCalled()
    expect(next.instanceMap.llmProviders().some((entry) => entry.instanceId === 'claude')).toBe(false)
    expect(next.harness.configuredProviderIds()).not.toContain('claude-subscription')
    await expect(bindTurn(next, 'claude', 'claude-subscription')).rejects.toMatchObject({ code: 'signed_out' })
    expect(profile).not.toBe(next)
  })
})

describe('one writer per vendor file', () => {
  it('a change, then a session save, then a restart: in step, no notice, the change kept', async () => {
    const dir = home()
    writeVendor(dir, 'claude', { loginPolicy: 'cli', sessions: { t: { sessionId: 's', cwd: dir } } })
    const store = legacyStore()
    const profile = start(dir, store)
    await profile.harness.instances.configure('claude', { args: ['--verbose'], env: { A: '1' } })
    // A turn ends and the service saves its sessions: the whole loaded object, the mirror included.
    profile.claude.forgetConversation('t')
    expect(readVendor(dir, 'claude')).toMatchObject({ args: ['--verbose'], env: { A: '1' }, sessions: {} })
    const next = restart(dir, store)
    expect((await snapshotOf(next, 'claude')).settingsNotice).toBeUndefined()
    expect(next.harness.launchFor('claude')).toEqual({ args: ['--verbose'], env: { A: '1' } })
  })

  it('a sign-out, then a session save, then a restart: still signed out, no notice', async () => {
    const dir = home()
    writeVendor(dir, 'claude', { loginPolicy: 'cli', sessions: { t: { sessionId: 's', cwd: dir } } })
    const store = legacyStore()
    const profile = start(dir, store)
    await profile.harness.instances.signOut('claude')
    profile.claude.forgetConversation('t')
    const next = restart(dir, store)
    expect(next.harness.signedOutInMousse('claude')).toBe(true)
    expect((await snapshotOf(next, 'claude')).settingsNotice).toBeUndefined()
  })

  it('a path entered at sign-in lands in the instance config and its mirror', async () => {
    const dir = home()
    const bin = executable(join(dir, 'bin'), 'claude')
    writeVendor(dir, 'claude', { loginPolicy: 'cli' })
    const store = legacyStore()
    const profile = start(dir, store)
    const session = new LoginSession('login')
    session.on('event', (event: { type: string }) => {
      if (event.type === 'prompt') session.respond({ sessionId: session.sessionId, kind: 'prompt', value: bin })
    })
    await expect(profile.claude.login(session, dir)).resolves.toMatchObject({ success: true })
    expect(storedConfig(store, 'claude')).toMatchObject({ binaryPath: bin, vendorMirror: mirrorHash({ binaryPath: bin }) })
    expect(readVendor(dir, 'claude').binaryPath).toBe(bin)
  })

  it('an Antigravity manual path an install drops leaves through the gateway, with its mirror', async () => {
    const dir = home()
    const store = legacyStore()
    const profile = start(dir, store)
    await profile.harness.instances.configure('antigravity', { args: ['--flag'] })
    // What the install's `saveLaunch({ binaryPath: null })` runs.
    await profile.harness.instances.configure('antigravity', { binaryPath: null })
    expect(storedConfig(store, 'antigravity')).toMatchObject({ binaryPath: null, args: ['--flag'] })
    expect(readVendor(dir, 'antigravity')).toMatchObject({ args: ['--flag'] })
    expect(readVendor(dir, 'antigravity').binaryPath).toBeUndefined()
    const next = restart(dir, store)
    expect((await snapshotOf(next, 'antigravity')).settingsNotice).toBeUndefined()
  })
})

describe('a vendor file the service cannot save', () => {
  it.each(['claude', 'codex'] as const)('%s: a change is kept here and written there once the file is fixed, with no notice', async (vendor) => {
    const dir = home()
    const bin = executable(join(dir, 'bin'), vendor)
    const valid = vendor === 'claude' ? { loginPolicy: 'cli' } : { threads: {} }
    writeVendor(dir, vendor, valid)
    const store = legacyStore()
    // Marked while readable, then broken.
    start(dir, store)
    stopAll()
    const marker = storedConfig(store, vendor).vendorMirror
    writeVendor(dir, vendor, '{broken')
    const profile = start(dir, store)
    await expect(profile.harness.instances.configure(vendor, { binaryPath: bin })).rejects.toThrow(/own settings file was not updated/)
    expect(storedConfig(store, vendor)).toMatchObject({ binaryPath: bin, vendorMirror: marker })
    expect(readVendorText(dir, vendor)).toBe('{broken')
    // Fixed by the user; the next start finishes the write.
    writeVendor(dir, vendor, valid)
    const next = restart(dir, store)
    expect(readVendor(dir, vendor).binaryPath).toBe(bin)
    expect(storedConfig(store, vendor).vendorMirror).toBe(mirrorHash({ binaryPath: bin }))
    expect((await snapshotOf(next, vendor)).settingsNotice).toBeUndefined()
  })

  it('no marker yet (unreadable since the upgrade): the configured field is kept and the rest is copied', async () => {
    const dir = home()
    const bin = executable(join(dir, 'bin'), 'claude')
    writeVendor(dir, 'claude', '{broken')
    const store = legacyStore()
    const profile = start(dir, store)
    await expect(profile.harness.instances.configure('claude', { binaryPath: bin })).rejects.toThrow(/not updated/)
    expect(storedConfig(store, 'claude').vendorMirror).toBeUndefined()
    writeVendor(dir, 'claude', { loginPolicy: 'cli', args: ['--older'] })
    const next = restart(dir, store)
    expect(next.harness.launchFor('claude')).toEqual({ binaryPath: bin, args: ['--older'] })
    expect(readVendor(dir, 'claude')).toMatchObject({ binaryPath: bin, args: ['--older'] })
    expect((await snapshotOf(next, 'claude')).settingsNotice).toBeUndefined()
    expect(profile).not.toBe(next)
  })

  it('the mirror throws the settings error before it assigns anything', () => {
    let saves = 0
    const settings: Record<string, unknown> = { args: ['--kept'] }
    const mirror = settingsMirror(['args', 'signedOut'], { settings: () => settings, settingsError: () => 'unreadable', save: () => { saves += 1 }, signedOutKey: 'disconnected' })
    expect(mirror.read()).toBe('unreadable')
    expect(() => mirror.write({ args: ['--new'], signedOut: true })).toThrow('unreadable')
    expect(settings).toEqual({ args: ['--kept'] })
    expect(saves).toBe(0)
  })
})

describe('the mirror follows the settings object the service holds now', () => {
  it('Claude: after a Recheck reloads a fixed file, a change lands in the new object and on disk', async () => {
    const dir = home()
    writeVendor(dir, 'claude', '{broken')
    const store = legacyStore()
    // A program that answers --version, so Recheck reaches the sign-in check (which reloads the file).
    setStored(store, 'claude', { binaryPath: process.execPath })
    const profile = start(dir, store)
    writeVendor(dir, 'claude', { loginPolicy: 'cli', models: [{ id: 'm', label: 'M' }] })
    await profile.harness.instances.recheck('claude')
    await profile.harness.instances.configure('claude', { args: ['--after-recheck'] })
    expect(readVendor(dir, 'claude')).toMatchObject({ args: ['--after-recheck'], models: [{ id: 'm', label: 'M' }] })
  })

  it('Antigravity: after its sign-in replaces the settings object, a change lands on disk', async () => {
    const dir = home()
    writeVendor(dir, 'antigravity', { models: [] })
    const store = legacyStore()
    const profile = start(dir, store)
    // What a sign-in does: a new object spread from the old one.
    const service = profile.antigravity as unknown as { settings: Record<string, unknown> }
    service.settings = { ...service.settings, signedIn: true }
    await profile.harness.instances.configure('antigravity', { args: ['--after-sign-in'] })
    expect(readVendor(dir, 'antigravity')).toMatchObject({ signedIn: true, args: ['--after-sign-in'] })
  })

  it('Antigravity: an unreadable file is never reconciled or overwritten', async () => {
    const dir = home()
    writeVendor(dir, 'antigravity', '{broken')
    const store = legacyStore()
    const profile = start(dir, store)
    expect(profile.antigravity.vendorMirror(['args']).read()).toBe('unreadable')
    expect(storedConfig(store, 'antigravity')).toEqual({})
    await profile.antigravity.logout()
    expect(readVendorText(dir, 'antigravity')).toBe('{broken')
    // A sign-in that could not be saved is refused, and the card's check says why.
    expect(profile.antigravity.settingsProblem()).toMatch(/could not read/)
    await expect(profile.antigravity.login(new LoginSession('agy'), dir)).resolves.toMatchObject({ success: false, error: expect.stringMatching(/could not read/) })
    expect(readVendorText(dir, 'antigravity')).toBe('{broken')
  })
})

describe('the marker is written at creation', () => {
  it('an added Claude instance starts signed in with its marker, and a sign-out survives a restart', async () => {
    const dir = home()
    const store = legacyStore()
    const profile = start(dir, store)
    const added = await profile.harness.instances.add({ driver: 'claude', config: { displayName: 'Work' } })
    expect(storedConfig(store, added.instanceId)).toMatchObject({ signedOutInMousse: false, vendorMirror: mirrorHash({}) })
    await profile.harness.instances.signOut(added.instanceId)
    const next = restart(dir, store)
    expect(next.harness.signedOutInMousse(added.instanceId)).toBe(true)
    expect((await snapshotOf(next, added.instanceId)).settingsNotice).toBeUndefined()
  })

  it('a built-in seeded once the instance map is readable mid-session copies its vendor file and marks it', () => {
    const dir = home()
    writeVendor(dir, 'claude', { loginPolicy: 'cli', args: ['--seeded'], cliDisconnected: true })
    const store: ProfileStore = { instances: undefined, writes: [], unreadable: true }
    const profile = start(dir, store)
    expect(store.writes).toEqual([])
    store.unreadable = false
    profile.instanceMap.list()
    expect(storedConfig(store, 'claude')).toMatchObject({ args: ['--seeded'], signedOutInMousse: true, vendorMirror: mirrorHash({ args: ['--seeded'], signedOut: true }) })
  })

  it('a cleared launch setting is stored as null and stays cleared after a restart', async () => {
    const dir = home()
    writeVendor(dir, 'claude', { loginPolicy: 'cli', args: ['--a'] })
    const store = legacyStore()
    const profile = start(dir, store)
    await profile.harness.instances.configure('claude', { args: [] })
    expect(storedConfig(store, 'claude').args).toBeNull()
    expect(readVendor(dir, 'claude').args).toBeUndefined()
    const next = restart(dir, store)
    expect(storedConfig(store, 'claude').args).toBeNull()
    expect(next.harness.launchFor('claude')).toEqual({})
    expect((await snapshotOf(next, 'claude')).settingsNotice).toBeUndefined()
    expect(profile).not.toBe(next)
  })
})

describe('source guard: only the mirror assigns mirrored keys in a vendor service', () => {
  const FIELDS = '(?:binaryPath|args|env|cliDisconnected|disconnected)'
  const PATTERNS: RegExp[] = [
    new RegExp(`settings\\??\\.${FIELDS}\\s*(?:=(?!=)|\\?\\?=|\\|\\|=)`),
    new RegExp(`delete\\s+[\\w.]*settings\\??\\.${FIELDS}\\b`),
    new RegExp(`settings\\[\\s*['"\`]${FIELDS}['"\`]\\s*\\]\\s*=(?!=)`),
    new RegExp(`delete\\s+[\\w.]*settings\\[\\s*['"\`]${FIELDS}['"\`]\\s*\\]`),
    // A whole-object replace or Object.assign that names a mirrored key (after a spread too).
    new RegExp(`settings\\s*=(?!=)\\s*\\{[^}]*\\b${FIELDS}\\b`),
    new RegExp(`Object\\.assign\\(\\s*[\\w.]*settings\\s*,[^)]*\\b${FIELDS}\\b`),
    // Handing the settings object to a helper that patches it.
    /applyCliConfigPatch\(\s*[\w.]*settings/
  ]
  /** Comments removed, so documentation that names a field is not code. */
  function code(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
  }
  function violations(source: string): string[] {
    const body = code(source)
    return PATTERNS.flatMap((pattern) => {
      const match = pattern.exec(body)
      return match ? [match[0]] : []
    })
  }
  const root = resolve(__dirname, '..', '..', 'src', 'mms', 'providers')
  const SERVICES = [
    join(root, 'claudeSubscription', 'ClaudeSubscriptionProviderService.ts'),
    join(root, 'codex', 'CodexProviderService.ts'),
    join(root, 'antigravity', 'AntigravityProviderService.ts')
  ]

  it('scans the three vendor services', () => {
    for (const file of SERVICES) expect(readdirSync(join(file, '..')).length).toBeGreaterThan(0)
  })

  it.each(SERVICES)('%s assigns no mirrored key outside the mirror', (file) => {
    expect(violations(readFileSync(file, 'utf8'))).toEqual([])
  })

  it.each([
    'this.settings.binaryPath = binary',
    'this.settings.args ??= []',
    'delete this.settings.cliDisconnected',
    "this.settings['disconnected'] = true",
    "delete this.settings['env']",
    'this.settings = { ...this.settings, binaryPath: path }',
    'this.settings = {\n  ...this.settings,\n  disconnected: true\n}',
    'Object.assign(this.settings, { env: next })',
    'applyCliConfigPatch(this.settings, patch, check)'
  ])('catches a planted %s', (planted) => {
    expect(violations(`class S {\n  run() {\n    ${planted}\n  }\n}`)).not.toEqual([])
  })

  it.each([
    'this.settings = { ...this.settings, signedIn: true, models }',
    'this.settings = parsed as Settings',
    'const binaryPath = this.settings.binaryPath',
    'if (this.settings.disconnected === true) return',
    '// this.settings.binaryPath = documented only'
  ])('allows %s', (allowed) => {
    expect(violations(`class S {\n  run() {\n    ${allowed}\n  }\n}`)).toEqual([])
  })
})

describe('review round 1', () => {
  function conflicted(): { dir: string; store: ProfileStore; profile: StartedProfile } {
    const dir = home()
    writeVendor(dir, 'claude', { loginPolicy: 'cli', args: ['--a'] })
    const store = legacyStore()
    start(dir, store)
    stopAll()
    setStored(store, 'claude', { args: ['--mine'] })
    writeVendor(dir, 'claude', { ...readVendor(dir, 'claude'), args: ['--older'] })
    return { dir, store, profile: start(dir, store) }
  }

  it('a sign-out during a conflict mirrors only the flag: the older values stay for "Use the older settings"', async () => {
    const { dir, store, profile } = conflicted()
    const marker = storedConfig(store, 'claude').vendorMirror
    await profile.harness.instances.signOut('claude')
    expect(readVendor(dir, 'claude')).toMatchObject({ args: ['--older'], cliDisconnected: true })
    expect(storedConfig(store, 'claude')).toMatchObject({ args: ['--mine'], signedOutInMousse: true, vendorMirror: marker })
    expect((await snapshotOf(profile, 'claude')).settingsNotice).toMatchObject({ kind: 'older_conflict' })
    await profile.harness.instances.configure('claude', { useOlderSettings: true })
    expect(profile.harness.launchFor('claude')).toEqual({ args: ['--older'] })
    expect(profile.harness.signedOutInMousse('claude')).toBe(true)
  })

  it('a reconnect during a conflict keeps the conflict for the next start', async () => {
    const { dir, store, profile } = conflicted()
    await profile.harness.instances.signOut('claude')
    await profile.harness.instances.signIn('claude')
    expect(readVendor(dir, 'claude').args).toEqual(['--older'])
    expect(readVendor(dir, 'claude').cliDisconnected).toBeUndefined()
    const next = restart(dir, store)
    expect((await snapshotOf(next, 'claude')).settingsNotice).toMatchObject({ kind: 'older_conflict' })
    expect(next.harness.launchFor('claude')).toEqual({ args: ['--mine'] })
    expect(next.harness.signedOutInMousse('claude')).toBe(false)
  })

  it('keeps a configuration saved while the sign-out awaits the runtime', async () => {
    const dir = home()
    writeVendor(dir, 'codex', {})
    const store = legacyStore()
    const profile = start(dir, store)
    let release!: () => void
    vi.spyOn(profile.codex, 'logout').mockImplementation(() => new Promise<void>((resolve) => { release = resolve }))
    const signOut = profile.harness.instances.signOut('codex')
    await profile.harness.instances.configure('codex', { env: { NEW_VALUE: 'keep' } })
    release()
    await signOut
    expect(storedConfig(store, 'codex')).toMatchObject({ env: { NEW_VALUE: 'keep' }, signedOutInMousse: true })
    expect(readVendor(dir, 'codex')).toMatchObject({ env: { NEW_VALUE: 'keep' }, disconnected: true })
    const next = restart(dir, store)
    expect((await snapshotOf(next, 'codex')).settingsNotice).toBeUndefined()
  })

  it('a re-added built-in keeps the launch settings its vendor file holds, readable at the add or not', async () => {
    const dir = home()
    const bin = executable(join(dir, 'bin'), 'claude')
    const vendor = { loginPolicy: 'cli', binaryPath: bin, args: ['--a'], env: { A: '1' }, cliDisconnected: true }
    writeVendor(dir, 'claude', vendor)
    const store = legacyStore()
    const profile = start(dir, store)
    await profile.harness.instances.remove('claude')
    await profile.harness.instances.add({ driver: 'claude' })
    expect(profile.harness.launchFor('claude')).toEqual({ binaryPath: bin, args: ['--a'], env: { A: '1' } })
    expect(profile.harness.signedOutInMousse('claude')).toBe(false)
    // Only the sign-out goes to the vendor file: the add starts signed in.
    expect(readVendor(dir, 'claude')).toMatchObject({ binaryPath: bin, args: ['--a'], env: { A: '1' } })
    expect(readVendor(dir, 'claude').cliDisconnected).toBeUndefined()

    // The same add while the file cannot be read ends the same once it is fixed.
    await profile.harness.instances.remove('claude')
    writeVendor(dir, 'claude', '{broken')
    stopAll()
    const broken = start(dir, store)
    await broken.harness.instances.add({ driver: 'claude' })
    writeVendor(dir, 'claude', vendor)
    const fixed = restart(dir, store)
    expect(fixed.harness.launchFor('claude')).toEqual({ binaryPath: bin, args: ['--a'], env: { A: '1' } })
    expect(fixed.harness.signedOutInMousse('claude')).toBe(false)
    expect(readVendor(dir, 'claude').cliDisconnected).toBeUndefined()
    expect((await snapshotOf(fixed, 'claude')).settingsNotice).toBeUndefined()
  })

  it('Antigravity with a manual agent: Sign in after a sign-out runs its real sign-in', async () => {
    const dir = home()
    writeVendor(dir, 'antigravity', { signedIn: true })
    const store = legacyStore()
    setStored(store, 'antigravity', { binaryPath: join(dir, 'manual', 'agy_acp_server') })
    const profile = start(dir, store)
    const login = vi.spyOn(profile.antigravity, 'login').mockImplementation(async (session) => ({ success: true, sessionId: session.sessionId }))
    await profile.harness.instances.signOut('antigravity')
    expect(profile.antigravity.signedIn()).toBe(false)
    expect((await snapshotOf(profile, 'antigravity')).auth.message).toBe('Signed out in Mousse.')
    await profile.harness.instances.signIn('antigravity')
    await vi.waitFor(() => expect(profile.harness.signedOutInMousse('antigravity')).toBe(false))
    expect(login).toHaveBeenCalledTimes(1)
  })

  it('a deleted vendor file is not an older version\'s change: the instance keeps its values and writes them back', async () => {
    const dir = home()
    writeVendor(dir, 'claude', { loginPolicy: 'cli', args: ['--a'] })
    const store = legacyStore()
    const profile = start(dir, store)
    await profile.harness.instances.signOut('claude')
    stopAll()
    rmSync(settingsPath(dir, 'claude'))
    const next = start(dir, store)
    expect(next.harness.launchFor('claude')).toEqual({ args: ['--a'] })
    expect(next.harness.signedOutInMousse('claude')).toBe(true)
    expect(readVendor(dir, 'claude')).toMatchObject({ args: ['--a'], cliDisconnected: true })
    expect((await snapshotOf(next, 'claude')).settingsNotice).toBeUndefined()
  })

  it('a new name while the vendor file is unreadable saves without a mirror error', async () => {
    const dir = home()
    writeVendor(dir, 'claude', { loginPolicy: 'cli', args: ['--a'] })
    const store = legacyStore()
    start(dir, store)
    stopAll()
    writeVendor(dir, 'claude', '{broken')
    const profile = start(dir, store)
    await expect(profile.harness.instances.configure('claude', { displayName: 'Mine' })).resolves.toMatchObject({ displayName: 'Mine' })
    expect(readVendorText(dir, 'claude')).toBe('{broken')
    // A change to a mirrored value still says it was not mirrored.
    await expect(profile.harness.instances.configure('claude', { args: ['--b'] })).rejects.toThrow(/own settings file was not updated/)
  })
})

describe('an added Claude instance: one service per settings file', () => {
  function addedProfile() {
    const dir = home()
    const questions = new UserQuestionService()
    const services: ClaudeSubscriptionProviderService[] = []
    let stored: Record<string, { driver: string; enabled: boolean; config?: Record<string, unknown> }> = {
      'claude:work': { driver: 'claude', enabled: true, config: { home: 'private', signedOutInMousse: false, vendorMirror: mirrorHash({}) } }
    }
    const map = new ProviderInstanceService({ store: { read: () => ({ instances: stored, seedVersion: 1 }), write: (next) => { stored = next.instances as typeof stored } } })
    const harness = createHarnessGateway({
      profileHome: dir,
      installationHome: dir,
      instanceMap: map,
      questions,
      latest: { get: () => undefined, refresh: async () => false } as never,
      shellPath: async () => ({ entries: [], source: 'failed' }),
      drivers: [claudeCodeDriver({
        createService: (_context, options) => {
          const service = new ClaudeSubscriptionProviderService(dir, questions, {
            ...options,
            live: false,
            runAuth: async () => JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }),
            query: () => { throw new Error('no query in this test') }
          })
          services.push(service)
          return service
        }
      })]
    })
    cleanups.push(() => {
      harness.stop()
      for (const service of services) service.stop()
      questions.shutdown()
    })
    return { dir, harness, services, stored: () => stored }
  }

  it('an executable path entered at sign-in saves the path and the sign-in goes on', async () => {
    const { dir, harness, services, stored } = addedProfile()
    const bin = executable(dir, 'claude-test')
    const session = new LoginSession('added-login')
    session.on('event', (event: { type: string }) => {
      if (event.type === 'prompt') session.respond({ sessionId: session.sessionId, kind: 'prompt', value: bin })
    })
    const result = await services[0]!.login(session, dir)
    expect(stored()['claude:work']!.config!.binaryPath).toBe(bin)
    expect({ result, aborted: session.abort.signal.aborted }).toMatchObject({ result: { success: true }, aborted: false })
    // The rebuilt runtime kept the same service, which now runs the new path.
    expect(services).toHaveLength(1)
    expect(harness.launchFor('claude:work')).toEqual({ binaryPath: bin })
  })

  it('a new home gets its own service, and the old one never writes the file again', async () => {
    const { dir, harness, services } = addedProfile()
    const settings = join(instanceStateDir(dir, 'claude:work'), 'settings.json')
    expect(services).toHaveLength(1)
    await harness.instances.configure('claude:work', { args: ['--x'] })
    expect(services).toHaveLength(1)
    await harness.instances.configure('claude:work', { home: 'default' })
    harness.instances.snapshots({ kind: 'device' }).catch(() => {})
    expect(services).toHaveLength(2)
    await harness.instances.signOut('claude:work')
    const written = readFileSync(settings, 'utf8')
    // The old service's last save (a turn that ends) is dropped: the sign-out stays on disk.
    services[0]!.forgetConversation('any')
    ;(services[0] as unknown as { save(): void }).save()
    expect(readFileSync(settings, 'utf8')).toBe(written)
    expect(JSON.parse(written)).toMatchObject({ cliDisconnected: true })
  })
})
