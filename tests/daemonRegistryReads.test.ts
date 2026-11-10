import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createInstallationPaths, ProfileManager } from '../src/mms/profiles'
import { ResourceLifecycleStore } from '../src/mms/lifecycle/ResourceLifecycleStore'
import { registerThreadLifecycleGate } from '../src/mms/queue/ThreadLifecycleAdmission'
import { atomicWriteJsonSync } from '../src/mms/data/AtomicFs'
import { FileLockBusyError, withFileLock } from '../src/mms/scheduled/fileLock'
import { PROCESS_INSTANCE_ID } from '../src/mms/queue/processLiveness'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

/** Replaces a JSON file the way Mousse writes one (a temporary file renamed over it), from another OS process. */
function rewriteFromAnotherProcess(path: string, patch: Record<string, unknown>): void {
  const script = `
    const fs = require('node:fs')
    const [path, patch] = [process.argv[1], JSON.parse(process.argv[2])]
    const value = { ...JSON.parse(fs.readFileSync(path, 'utf8')), ...patch }
    fs.writeFileSync(path + '.other', JSON.stringify(value, null, 2))
    fs.renameSync(path + '.other', path)
  `
  execFileSync(process.execPath, ['-e', script, path, JSON.stringify(patch)], { windowsHide: true })
}

/** A lock or gate file held by a live owner that is not this code path. */
function heldByAnotherOwner(path: string): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, JSON.stringify({ pid: process.pid, processInstanceId: PROCESS_INSTANCE_ID, token: 'another-owner', acquiredAt: new Date().toISOString() }))
}

describe('profile registry reads', () => {
  function installation() {
    const home = join(tempDir('mousse-registry-reads-'), 'home')
    const manager = ProfileManager.open(createInstallationPaths(home))
    const original = manager.initializeFresh({ displayName: 'Default' })
    const alice = manager.create({ displayName: 'Alice', slug: 'alice' })
    return { home, manager, original, alice }
  }

  it('reads without the registry lock, so a held lock blocks only writes', () => {
    const { home, manager, original, alice } = installation()
    heldByAnotherOwner(join(home, '.profiles.lock'))

    expect(manager.list().map((profile) => profile.slug)).toEqual(['default', 'alice'])
    expect(manager.get('alice').id).toBe(alice.id)
    expect(manager.getDefaultProfileId()).toBe(original.id)
    expect(() => manager.update(alice.id, { displayName: 'Alice B' }, alice.revision)).toThrow(FileLockBusyError)
  })

  it('sees a change another process made, and gives each caller its own copy', () => {
    const { home, manager, alice } = installation()
    const first = manager.get(alice.id)
    first.displayName = 'Changed by the caller'
    expect(manager.get(alice.id).displayName).toBe('Alice')

    const profileJson = join(home, 'profiles', alice.id, 'profile.json')
    rewriteFromAnotherProcess(profileJson, { displayName: 'Alicf', revision: 2 })
    expect(manager.get(alice.id)).toMatchObject({ displayName: 'Alicf', revision: 2 })

    // Another process archives the profile: the record first, then the index, as `ProfileManager` does.
    const manifest = JSON.parse(readFileSync(join(home, 'installation.json'), 'utf8')) as { profiles: Array<{ id: string; status: string }> }
    rewriteFromAnotherProcess(profileJson, { status: 'archived', revision: 3 })
    rewriteFromAnotherProcess(join(home, 'installation.json'), {
      profiles: manifest.profiles.map((entry) => (entry.id === alice.id ? { ...entry, status: 'archived' } : entry))
    })
    expect(manager.get(alice.id).status).toBe('archived')
    expect(manager.list().filter((profile) => profile.status === 'active')).toHaveLength(1)
  })

  it('reads again under the lock when the two files of one change disagree', () => {
    const { home, manager, alice } = installation()
    manager.get(alice.id)
    // Only the first file of a slug change has landed.
    rewriteFromAnotherProcess(join(home, 'profiles', alice.id, 'profile.json'), { slug: 'alice-b', revision: 2 })
    expect(() => manager.get(alice.id)).toThrow('Profile index and profile.json disagree')
    expect(existsSync(join(home, '.profiles.lock'))).toBe(false)
  })
})

describe('lifecycle record reads', () => {
  function fixture() {
    const home = tempDir('mousse-lifecycle-reads-')
    const store = new ResourceLifecycleStore({ profileId: 'profile-a', profileHome: home })
    registerThreadLifecycleGate(home, store)
    const location = join(home, 'thread-data', 'standalone', 'task')
    store.registerTask({ taskId: 'task', location, creating: true })
    store.withPathAdmission(location, 'write', () => {
      mkdirSync(location, { recursive: true })
      atomicWriteJsonSync(join(location, 'meta.json'), { id: 'task' })
    })
    return { home, store, location }
  }

  it('checks an unchanged record once and gives each caller its own copy', () => {
    const { store } = fixture()
    store.get('task')
    const validate = vi.spyOn(store as unknown as { validateRecord: () => void }, 'validateRecord')
    const first = store.get('task')!
    first.state = 'trashed'
    expect(store.get('task')!.state).toBe('active')
    expect(validate).not.toHaveBeenCalled()
  })

  it('sees a fence another process wrote, in reads and admissions', () => {
    const { store, location } = fixture()
    const admission = store.captureAdmission('task', location)
    store.assertPathAdmission(location, 'write')

    rewriteFromAnotherProcess(store.recordPath('task'), { state: 'blocked' })
    expect(store.get('task')!.state).toBe('blocked')
    expect(() => store.assertPathAdmission(location, 'write')).toThrow('fenced')
    expect(() => store.assertAdmission(admission)).toThrow('fenced')
    expect(() => store.captureAdmission('task', location)).toThrow('fenced')

    rewriteFromAnotherProcess(store.recordPath('task'), { state: 'active', generation: 2 })
    expect(() => store.assertAdmission(admission)).toThrow('generation or location changed')
    expect(() => store.assertPathAdmission(location, 'write')).not.toThrow()
  })

  it('checks admission without the task gate, which work under admission still takes', () => {
    const { home, store, location } = fixture()
    const gate = join(home, 'lifecycle', 'gates', 'task', 'gate.lock')
    heldByAnotherOwner(gate)

    const admission = store.captureAdmission('task', location)
    expect(() => store.assertAdmission(admission)).not.toThrow()
    expect(() => store.assertPathAdmission(location, 'write')).not.toThrow()
    expect(() => store.withPathAdmission(location, 'write', () => undefined)).toThrow('busy')
    unlinkSync(gate)
  })

  it('removes its own gate on release, but not one that replaced it', () => {
    const { home, store } = fixture()
    const gate = join(home, 'lifecycle', 'gates', 'task', 'gate.lock')
    store.withGate('task', () => expect(existsSync(gate)).toBe(true))
    expect(existsSync(gate)).toBe(false)

    store.withGate('task', () => {
      unlinkSync(gate)
      heldByAnotherOwner(gate)
    })
    expect(JSON.parse(readFileSync(gate, 'utf8')).token).toBe('another-owner')
  })
})

describe('file lock release', () => {
  it('removes its own lock, but not one that replaced it', () => {
    const lock = join(tempDir('mousse-file-lock-'), 'registry.lock')
    withFileLock(lock, () => expect(existsSync(lock)).toBe(true))
    expect(existsSync(lock)).toBe(false)

    withFileLock(lock, () => {
      unlinkSync(lock)
      heldByAnotherOwner(lock)
    })
    expect(JSON.parse(readFileSync(lock, 'utf8')).token).toBe('another-owner')
  })
})
