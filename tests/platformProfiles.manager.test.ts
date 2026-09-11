import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ProfileRevisionConflictError } from '../src/shared/profiles/errors'
import { FIXTURE_PROFILE_A_ID } from '../src/shared/profiles'
import { createInstallationPaths, ProfileManager } from '../src/mms/profiles'

const tempDirs: string[] = []

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mousse-profiles-manager-'))
  tempDirs.push(dir)
  const home = join(dir, 'home')
  mkdirSync(home, { recursive: true })
  return home
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('ProfileManager registry', () => {
  it('creates isolated A/B identities with revision-checked metadata and a shared provider root', () => {
    const previousHome = process.env.MOUSSE_HOME
    const home = tempHome()
    writeFileSync(join(home, 'auth.json'), '{"openai":{"type":"api_key","key":"shared-key"}}')
    const manager = ProfileManager.open(createInstallationPaths(home))
    const original = manager.initializeFresh({ displayName: 'Default' })
    const alice = manager.create({ displayName: 'Alice', slug: 'alice', color: '#4f46e5' })
    const bob = manager.create({ displayName: 'Bob', slug: 'bob' })

    expect(alice.id).not.toBe(bob.id)
    expect(alice.id).not.toBe(original.id)
    expect(alice.revision).toBe(1)
    expect(manager.list()).toHaveLength(3)

    const aliceRuntime = manager.bind('alice')
    const bobRuntime = manager.bind(bob.id)
    expect(aliceRuntime.binding.epoch).toBe(1)
    expect(bobRuntime.binding.epoch).toBe(2)
    expect(aliceRuntime.paths.root).not.toBe(bobRuntime.paths.root)
    expect(aliceRuntime.installation.authJson).toBe(bobRuntime.installation.authJson)
    expect(readFileSync(aliceRuntime.installation.authJson, 'utf8')).toContain('shared-key')
    expect(existsSync(join(aliceRuntime.paths.root, 'profile.json'))).toBe(true)
    expect(existsSync(aliceRuntime.paths.mcpOAuthDir)).toBe(true)
    expect(existsSync(aliceRuntime.paths.agentConfigsDir)).toBe(true)

    expect(() => aliceRuntime.access.assertResourceProfileId(bob.id)).toThrow(/does not match/)
    expect(() =>
      aliceRuntime.access.resolveOwnedPath('..', 'profiles', bob.id, 'profile.json')
    ).toThrow()

    const renamed = manager.update(alice.id, { displayName: 'Alice Prime' }, 1)
    expect(renamed.revision).toBe(2)
    expect(renamed.displayName).toBe('Alice Prime')
    expect(() => manager.update(alice.id, { displayName: 'stale' }, 1)).toThrow(
      ProfileRevisionConflictError
    )

    const archived = manager.archive(bob.id, 1)
    expect(archived.status).toBe('archived')
    expect(() => manager.bind(bob.id)).toThrow(/not active/)
    const restored = manager.restore(bob.slug, 2)
    expect(restored.status).toBe('active')
    expect(restored.revision).toBe(3)

    expect(process.env.MOUSSE_HOME).toBe(previousHome)
    expect(existsSync(join(home, 'mms.owner.json'))).toBe(false)
  })

  it('rejects invalid ids, slug conflicts, and last-active archive', () => {
    const home = tempHome()
    const manager = ProfileManager.open(createInstallationPaths(home))
    const def = manager.initializeFresh()
    expect(() => manager.get(FIXTURE_PROFILE_A_ID)).toThrow(/not found/)
    expect(() => manager.create({ displayName: 'Clone', slug: 'default' })).toThrow(/already exists/)
    expect(() => manager.archive(def.id, 1)).toThrow(/last active profile|default profile/)
    expect(() => manager.get('../etc/passwd')).toThrow()
  })

  it('returns a runtime whose nested profile metadata cannot be mutated', () => {
    const manager = ProfileManager.open(createInstallationPaths(tempHome()))
    const created = manager.initializeFresh({
      displayName: 'Default',
      appearanceSeed: { theme: 'dark', acrylic: true }
    })
    const runtime = manager.bind(created.id)
    expect(Object.isFrozen(runtime.record)).toBe(true)
    expect(Object.isFrozen(runtime.record.appearanceSeed)).toBe(true)
    expect(() => {
      runtime.record.appearanceSeed!.theme = 'light'
    }).toThrow()
    expect(runtime.record.appearanceSeed?.theme).toBe('dark')
  })

  it('rejects a manifest whose default profile or indexed root is inconsistent', () => {
    const home = tempHome()
    const installation = createInstallationPaths(home)
    const manager = ProfileManager.open(installation)
    const created = manager.initializeFresh()
    const manifest = JSON.parse(readFileSync(installation.installationManifest, 'utf8'))
    manifest.profiles[0].rootRelativePath = `profiles/${FIXTURE_PROFILE_A_ID}`
    writeFileSync(installation.installationManifest, JSON.stringify(manifest))
    expect(() => manager.list()).toThrow(/root does not match/)
    manifest.profiles[0].rootRelativePath = `profiles/${created.id}`
    manifest.defaultProfileId = FIXTURE_PROFILE_A_ID
    writeFileSync(installation.installationManifest, JSON.stringify(manifest))
    expect(() => manager.getDefaultProfileId()).toThrow(/default profile must exist/)
  })
})
