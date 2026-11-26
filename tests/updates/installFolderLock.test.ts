/** One update at a time per install folder, across Mousse homes and processes (#476). Real lock files. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { installFolderLockPath, takeInstallFolderLock } from '../../src/main/updates/installFolderLock'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'update-lock-'))
  dirs.push(directory)
  let now = 1_000_000
  const alive = new Set<number>()
  const lock = (pid: number, purpose: 'download' | 'install') =>
    takeInstallFolderLock({ folder: '/Apps/Mousse', directory, pid, now: () => now, staleMs: 60_000, alive: (p) => alive.has(p) }, purpose)
  return { directory, alive, lock, advance: (ms: number) => (now += ms) }
}

it('lets one process at a time update a folder, and the next once it lets go', () => {
  const { alive, lock } = setup()
  alive.add(1).add(2)
  const release = lock(1, 'download')
  expect(release).toBeTypeOf('function')
  expect(lock(2, 'download')).toBeNull()
  expect(lock(2, 'install')).toBeNull()
  release!()
  expect(lock(2, 'install')).toBeTypeOf('function')
})

it('takes over a crashed download at once, but waits out an install whose process quit for the installer', () => {
  const { alive, lock } = setup()
  alive.add(2)
  // Process 1 downloaded and crashed.
  expect(lock(1, 'download')).toBeTypeOf('function')
  expect(lock(2, 'download')).toBeTypeOf('function')

  const other = setup()
  other.alive.add(2)
  // Process 1 quit to run the installer: the installer may still be replacing the files.
  expect(other.lock(1, 'install')).toBeTypeOf('function')
  expect(other.lock(2, 'download')).toBeNull()
  other.advance(60_000)
  expect(other.lock(2, 'download')).toBeTypeOf('function')
})

it('keeps one lock per folder, whatever the home, and takes over an unreadable one', () => {
  const { directory, alive, lock } = setup()
  alive.add(2)
  writeFileSync(installFolderLockPath(directory, '/Apps/Mousse'), '{')
  expect(lock(2, 'download')).toBeTypeOf('function')
  // Another folder has its own lock.
  expect(installFolderLockPath(directory, '/Apps/Other')).not.toBe(installFolderLockPath(directory, '/Apps/Mousse'))
})
