import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { INVALID_PROFILE_IDS } from '../src/shared/profiles'
import {
  createInstallationPaths,
  createProfilePaths,
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
})
