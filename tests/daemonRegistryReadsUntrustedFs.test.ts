import { closeSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { vi } from 'vitest'
import { createInstallationPaths, ProfileManager } from '../src/mms/profiles'
import { resetProfileRegistryCacheForTests } from '../src/mms/profiles/ProfileManager'
import { ResourceLifecycleStore } from '../src/mms/lifecycle/ResourceLifecycleStore'
import { registerThreadLifecycleGate } from '../src/mms/queue/ThreadLifecycleAdmission'
import { atomicWriteJsonSync } from '../src/mms/data/AtomicFs'
import { cacheSignature, sameFileIdentity } from '../src/mms/data/FileSignature'
import { withFileLock } from '../src/mms/scheduled/fileLock'

/**
 * How `stat` reports files to the code under test:
 * - `real`: as the file system does;
 * - `no-identity`: every file has `ino` 0 (FAT, exFAT, some network drives), with sub-millisecond times;
 * - `coarse-times`: one unchanging identity, with times only in whole seconds;
 * - `trusted-collision`: one unchanging identity with sub-millisecond times, which no real file system gives two
 *   different writes. The control: it shows the files below really do collide.
 * In the three simulated modes the change time is the modification time, as on FAT.
 */
const fsView = vi.hoisted(() => ({ mode: 'real' as 'real' | 'no-identity' | 'coarse-times' | 'trusted-collision', calls: [] as Array<[string, unknown]> }))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const view = (stats: unknown): unknown => {
    const value = stats as { ino?: unknown; mtimeNs?: bigint } | undefined
    if (fsView.mode === 'real' || typeof value?.ino !== 'bigint') return stats
    const ns = fsView.mode === 'coarse-times' ? value.mtimeNs! - (value.mtimeNs! % 1_000_000_000n) : value.mtimeNs! - (value.mtimeNs! % 1_000_000_000n) + 123n
    const copy = Object.create(Object.getPrototypeOf(stats)) as Record<string, unknown>
    Object.assign(copy, stats, { ino: fsView.mode === 'no-identity' ? 0n : 42n, mtimeNs: ns, ctimeNs: ns })
    return copy
  }
  const statLike = (name: 'statSync' | 'lstatSync' | 'fstatSync') => (...args: unknown[]) => {
    fsView.calls.push([name, args[0]])
    return view((actual[name] as (...a: unknown[]) => unknown)(...args))
  }
  const recorded = (name: 'openSync' | 'closeSync' | 'unlinkSync') => (...args: unknown[]) => {
    const result = (actual[name] as (...a: unknown[]) => unknown)(...args)
    fsView.calls.push([name, name === 'openSync' ? { path: args[0], fd: result } : args[0]])
    return result
  }
  const mocked = { statSync: statLike('statSync'), lstatSync: statLike('lstatSync'), fstatSync: statLike('fstatSync'), openSync: recorded('openSync'), closeSync: recorded('closeSync'), unlinkSync: recorded('unlinkSync') }
  return { ...actual, ...mocked, default: { ...actual, ...mocked } }
})

const dirs: string[] = []
beforeEach(() => {
  fsView.mode = 'real'
  fsView.calls = []
  resetProfileRegistryCacheForTests()
})
afterEach(() => {
  fsView.mode = 'real'
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

const SAME_TIME = new Date('2026-03-01T10:00:00.000Z')
/** Replaces `path` by rename with `patch` applied, keeping its size and giving both versions the same times. */
function replaceSameSize(path: string, patch: Record<string, unknown>): void {
  const before = readFileSync(path, 'utf8')
  const after = JSON.stringify({ ...JSON.parse(before), ...patch }, null, 2) + (before.endsWith('\n') ? '\n' : '')
  expect(after.length).toBe(before.length)
  writeFileSync(`${path}.next`, after)
  utimesSync(`${path}.next`, SAME_TIME, SAME_TIME)
  renameSync(`${path}.next`, path)
}

describe('signatures the file system cannot be trusted with', () => {
  it('are not used for caching', () => {
    const stats = { dev: 1n, ino: 7n, size: 10n, mtimeNs: 1_700_000_000_123_456_700n, ctimeNs: 1_700_000_000_123_456_700n }
    expect(cacheSignature(stats)).toBeDefined()
    expect(cacheSignature({ ...stats, ino: 0n })).toBeUndefined()
    expect(cacheSignature({ ...stats, mtimeNs: 1_700_000_000_123_000_000n })).toBeUndefined()
    expect(cacheSignature({ ...stats, mtimeNs: 1_700_000_000_000_000_000n })).toBeUndefined()
    expect(sameFileIdentity({ dev: 1n, ino: 7n }, { dev: 1n, ino: 0n })).toBeUndefined()
  })

  for (const mode of ['no-identity', 'coarse-times'] as const) {
    it(`a profile rewritten with the same size and time is read again (${mode})`, () => {
      const home = join(tempDir('mousse-untrusted-profile-'), 'home')
      const manager = ProfileManager.open(createInstallationPaths(home))
      manager.initializeFresh({ displayName: 'Default' })
      const alice = manager.create({ displayName: 'Alice', slug: 'alice' })
      const profileJson = join(home, 'profiles', alice.id, 'profile.json')
      utimesSync(profileJson, SAME_TIME, SAME_TIME)
      fsView.mode = mode
      expect(manager.get(alice.id).displayName).toBe('Alice')

      replaceSameSize(profileJson, { displayName: 'Alicf' })
      expect(manager.get(alice.id).displayName).toBe('Alicf')
    })

    it(`a lifecycle record rewritten with the same size and time is read again (${mode})`, () => {
      const { store } = lifecycleFixture()
      utimesSync(store.recordPath('task'), SAME_TIME, SAME_TIME)
      fsView.mode = mode
      expect(store.get('task')!.state).toBe('active')

      replaceSameSize(store.recordPath('task'), { state: 'purged' })
      expect(store.get('task')!.state).toBe('purged')
    })
  }

  it('control: the same rewrite collides when the signature is trusted', () => {
    const { store } = lifecycleFixture()
    utimesSync(store.recordPath('task'), SAME_TIME, SAME_TIME)
    fsView.mode = 'trusted-collision'
    expect(store.get('task')!.state).toBe('active')
    replaceSameSize(store.recordPath('task'), { state: 'purged' })
    expect(store.get('task')!.state).toBe('active')
  })
})

function lifecycleFixture() {
  const home = tempDir('mousse-untrusted-lifecycle-')
  const store = new ResourceLifecycleStore({ profileId: 'profile-a', profileHome: home })
  registerThreadLifecycleGate(home, store)
  const location = join(home, 'thread-data', 'standalone', 'task')
  store.registerTask({ taskId: 'task', location, creating: true })
  store.withPathAdmission(location, 'write', () => {
    mkdirSync(location, { recursive: true })
    atomicWriteJsonSync(join(location, 'meta.json'), { id: 'task' })
  })
  return { home, store }
}

describe('releasing a lock', () => {
  /** The lock's descriptor is closed only after its file was checked and removed. */
  function expectClosedAfterRemoval(path: string): void {
    const opened = fsView.calls.findLastIndex(([name, value]) => name === 'openSync' && (value as { path: string }).path === path)
    const fd = (fsView.calls[opened]![1] as { fd: number }).fd
    const checked = fsView.calls.findIndex(([name, value], index) => index > opened && name === 'lstatSync' && value === path)
    const removed = fsView.calls.findIndex(([name, value], index) => index > opened && name === 'unlinkSync' && value === path)
    const closed = fsView.calls.findIndex(([name, value], index) => index > opened && name === 'closeSync' && value === fd)
    expect(checked).toBeGreaterThan(opened)
    expect(removed).toBeGreaterThan(checked)
    expect(closed).toBeGreaterThan(removed)
  }

  it('keeps a file lock open until it is removed', () => {
    const lock = join(tempDir('mousse-release-'), 'registry.lock')
    withFileLock(lock, () => undefined)
    expectClosedAfterRemoval(lock)
    // Free again at once: removing an open file does not leave its name behind.
    withFileLock(lock, () => undefined)
  })

  it('keeps a task gate open until it is removed', () => {
    const { home, store } = lifecycleFixture()
    fsView.calls = []
    store.withGate('task', () => undefined)
    expectClosedAfterRemoval(join(home, 'lifecycle', 'gates', 'task', 'gate.lock'))
    store.withGate('task', () => undefined)
  })

  it('an open file and its path report the same identity on this file system', () => {
    const path = join(tempDir('mousse-identity-'), 'file')
    const fd = openSync(path, 'wx')
    try {
      const open = fstatSync(fd, { bigint: true })
      expect(sameFileIdentity(lstatSync(path, { bigint: true }), open) ?? true).toBe(true)
    } finally {
      closeSync(fd)
    }
  })
})
