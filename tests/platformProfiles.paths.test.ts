import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { INVALID_PROFILE_IDS } from '../src/shared/profiles'
import {
  assertOwnedPath,
  canonicalizeAbsolutePath,
  createInstallationPaths,
  createProfilePaths,
  isPathInsideRoot,
  joinOwnedPath
} from '../src/mms/profiles'
import { ProfilePathError } from '../src/shared/profiles/errors'

const tempDirs: string[] = []

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mousse-profiles-paths-'))
  tempDirs.push(dir)
  mkdirSync(join(dir, 'home'), { recursive: true })
  return join(dir, 'home')
}

/** Canonical base, so the only links in a fixture are the ones the test creates. */
function tempRoot(): string {
  const dir = mkdtempSync(join(realpathSync.native(tmpdir()), 'mousse-owned-paths-'))
  tempDirs.push(dir)
  mkdirSync(join(dir, 'root'))
  return join(dir, 'root')
}

/** Returns false when the platform cannot create the link, so the caller can skip. */
function link(target: string, path: string): boolean {
  try {
    symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir')
    return true
  } catch {
    return false
  }
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('InstallationPaths and ProfilePaths', () => {
  it('preserves installation endpoint identity and shared provider root across profiles', () => {
    const home = tempHome()
    writeFileSync(join(home, 'auth.json'), '{"openrouter":{"type":"api_key","key":"shared"}}')
    writeFileSync(join(home, 'mms.owner.json'), '{"pid":1}')
    writeFileSync(join(home, 'mms.runtime.json'), '{"ready":true}')
    const installation = createInstallationPaths(home)
    const profileA = createProfilePaths(installation, '7f1d3a2c-4b90-4e11-a8c3-0d5e6f7a8b9c')
    const profileB = createProfilePaths(installation, 'e9c8b7a6-5544-4f33-b221-100998877665')

    expect(profileA.root).not.toBe(profileB.root)
    expect(profileA.root.startsWith(installation.profilesDir)).toBe(true)
    expect(profileB.root.startsWith(installation.profilesDir)).toBe(true)
    expect(installation.authJson).toBe(join(installation.homeDir, 'auth.json'))
    expect(installation.ownerJson).toBe(join(installation.homeDir, 'mms.owner.json'))
    expect(installation.runtimeJson).toBe(join(installation.homeDir, 'mms.runtime.json'))
    expect(installation.endpoint.canonicalHome).toBe(installation.homeDir)
    expect(installation.endpoint.homeHash).toHaveLength(32)
    expect(installation.endpoint.windowsNamedPipePath).toContain(installation.endpoint.homeHash)
    expect(installation.unixSocket).toBe(join(installation.homeDir, 'mms.sock'))
    expect(profileA.threadStorageHome).toBe(profileA.root)
    expect(profileA.controlStoreHome).toBe(profileA.root)
    expect(existsSync(installation.authJson)).toBe(true)
  })

  it('rejects invalid ids and traversal segments', () => {
    const installation = createInstallationPaths(tempHome())
    for (const value of INVALID_PROFILE_IDS) {
      expect(() => createProfilePaths(installation, value)).toThrow()
    }
    expect(() => joinOwnedPath(installation.homeDir, '..', 'etc')).toThrow(ProfilePathError)
    expect(() => joinOwnedPath(installation.homeDir, 'profiles', '..', '..', 'Windows')).toThrow(
      ProfilePathError
    )
  })

  it('rejects symlink escapes when the platform can create them', () => {
    const home = tempHome()
    const installation = createInstallationPaths(home)
    const outside = join(home, '..', 'outside-secret')
    mkdirSync(outside, { recursive: true })
    writeFileSync(join(outside, 'secret.txt'), 'nope')
    const bait = join(home, 'escape-link')
    try {
      symlinkSync(outside, bait, process.platform === 'win32' ? 'junction' : 'dir')
    } catch {
      return
    }
    expect(() => joinOwnedPath(home, 'escape-link', 'secret.txt')).toThrow(ProfilePathError)
  })

  it('rejects a profiles directory reparse point outside the installation home', () => {
    const home = tempHome()
    const outside = join(home, '..', 'outside-profiles')
    mkdirSync(outside, { recursive: true })
    try {
      symlinkSync(outside, join(home, 'profiles'), process.platform === 'win32' ? 'junction' : 'dir')
    } catch {
      return
    }
    const installation = createInstallationPaths(home)
    expect(() => createProfilePaths(
      installation,
      '7f1d3a2c-4b90-4e11-a8c3-0d5e6f7a8b9c'
    )).toThrow(ProfilePathError)
  })
})

describe('owned-path containment', () => {
  it('accepts a not-yet-created path under a root reached through a symlink', () => {
    const base = join(tempRoot(), '..')
    const realProject = join(base, 'real', 'project')
    mkdirSync(realProject, { recursive: true })
    if (!link(join(base, 'real'), join(base, 'alias'))) return
    const aliasProject = join(base, 'alias', 'project')
    const candidate = join(aliasProject, '.mousse', 'skills')
    const canonical = join(realProject, '.mousse', 'skills')

    expect(canonicalizeAbsolutePath(candidate)).toBe(canonical)
    for (const root of [aliasProject, realProject]) {
      expect(isPathInsideRoot(root, candidate)).toBe(true)
      expect(assertOwnedPath(root, candidate)).toBe(canonical)
    }
  })

  it('accepts a child whose name starts with two dots', () => {
    const root = tempRoot()
    const candidate = join(root, '..cache', 'child')

    expect(isPathInsideRoot(root, candidate)).toBe(true)
    expect(assertOwnedPath(root, candidate)).toBe(candidate)
  })

  it('rejects a dangling symlink that leads outside the root, directly or through another link', () => {
    const root = tempRoot()
    const outside = join(root, '..', 'outside')
    mkdirSync(join(outside, 'dir'), { recursive: true })
    // direct -> outside/missing
    // indirect -> root/via/missing, where via -> outside/missing
    if (!link(join(outside, 'missing'), join(root, 'direct'))) return
    if (!link(join(outside, 'missing'), join(root, 'via'))) return
    if (!link(join(root, 'via', 'missing'), join(root, 'indirect'))) return
    const names = ['direct', 'indirect']
    // climb -> root/up/../missing, where up -> outside/dir. The filesystem follows
    // `up` before `..`, so the target is outside/missing. Junctions store a
    // normalized absolute target, so this fixture only exists off Windows.
    if (process.platform !== 'win32') {
      link(join(outside, 'dir'), join(root, 'up'))
      symlinkSync(`${root}/up/../missing`, join(root, 'climb'))
      names.push('climb')
    }

    for (const name of names) {
      expect(() => assertOwnedPath(root, join(root, name, 'child'))).toThrow(ProfilePathError)
      expect(() => joinOwnedPath(root, name, 'child')).toThrow(ProfilePathError)
    }
  })

  it('resolves a dangling symlink that stays inside the root to its target', () => {
    const root = tempRoot()
    if (!link(join(root, 'missing'), join(root, 'link'))) return

    expect(assertOwnedPath(root, join(root, 'link', 'child'))).toBe(join(root, 'missing', 'child'))
  })

  it('rejects a symlink cycle under the root', () => {
    const root = tempRoot()
    if (!link(join(root, 'b'), join(root, 'a'))) return
    if (!link(join(root, 'a'), join(root, 'b'))) return

    expect(() => assertOwnedPath(root, join(root, 'a', 'child'))).toThrow(ProfilePathError)
  })
})
