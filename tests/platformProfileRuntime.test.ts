import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { MousseMainService } from '../src/mms/MousseMainService'
import { createProfileSecretAdapter, writeProfileSecret } from '../src/mms/profiles/secrets'
import { MmsProtocolServer, LocalMmsClient } from '../src/mms/protocol'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('production profile runtime composition', () => {
  it('creates one installation owner with lazy isolated profile services', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mousse-profile-runtime-'))
    roots.push(root)
    const home = join(root, 'home')
    mkdirSync(home, { recursive: true })
    const main = await MousseMainService.create({
      homeDir: home,
      repoRoot: root,
      headless: true,
      requireOwnership: false
    })
    try {
      const host = main.getInstallationHost()
      expect(host).not.toBeNull()
      const bob = host!.manager.create({ displayName: 'Bob', slug: 'bob' })
      const alice = await main.getProfileServices(host!.getDefaultProfileId())
      const bobServices = await main.getProfileServices(bob.id)
      expect(alice).toBe(main)
      expect(bobServices).not.toBe(main)
      expect(bobServices.profileId).toBe(bob.id)
      expect(bobServices.getProfileHomeDir()).toContain(join('profiles', bob.id))
      expect(bobServices.providerAuth).toBe(main.providerAuth)
      expect(bobServices.questions).not.toBe(main.questions)
      expect(bobServices.modeRegistry).not.toBe(main.modeRegistry)
      expect(bobServices.integrationContext.profileRoot).toBe(bobServices.getProfileHomeDir())
    } finally {
      await main.stop()
    }
  })

  it('does not let a new profile resolve installation environment secrets', () => {
    const root = mkdtempSync(join(tmpdir(), 'mousse-profile-secrets-'))
    roots.push(root)
    const profileRoot = join(root, 'profiles', 'bob')
    const previous = process.env.MOUSSE_TEST_PROFILE_SECRET
    process.env.MOUSSE_TEST_PROFILE_SECRET = 'installation-secret'
    try {
      writeProfileSecret(profileRoot, 'profile-secret', 'profile-value')
      const adapter = createProfileSecretAdapter({ profileRoot, inheritProcessEnv: false })
      expect(adapter.resolveEnv('$MOUSSE_TEST_PROFILE_SECRET')).toBe('')
      expect(adapter.resolveSecretRef('profile-secret')).toBe('profile-value')
    } finally {
      if (previous === undefined) delete process.env.MOUSSE_TEST_PROFILE_SECRET
      else process.env.MOUSSE_TEST_PROFILE_SECRET = previous
    }
  })

  it('binds a framed client to a profile and routes personal reads to that runtime', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mousse-profile-protocol-'))
    roots.push(root)
    const home = join(root, 'home')
    mkdirSync(home, { recursive: true })
    const main = await MousseMainService.create({ homeDir: home, repoRoot: root, requireOwnership: false })
    const host = main.getInstallationHost()!
    const bob = host.manager.create({ displayName: 'Bob', slug: 'bob' })
    const ownerToken = 'fixture-owner-token'
    const server = new MmsProtocolServer({ mms: main, ownerToken })
    const endpoint = await server.start()
    const client = new LocalMmsClient({
      homeDir: home,
      endpoint,
      ownerToken,
      requestedCapabilities: ['profiles-v1']
    })
    try {
      const hello = await client.connect()
      expect(hello.capabilities).toContain('profiles-v1')
      const bound = await client.request<{ profile: { id: string }; epoch: number }>('profiles.bind', { profile: 'bob' })
      expect(bound.profile.id).toBe(bob.id)
      const projects = await client.request<{ projects: unknown[] }>('projects.list')
      expect(projects.projects).toEqual([])
      await expect(client.request('threads.get', { threadId: 'default-only-thread' })).rejects.toThrow()
      host.manager.archive(bob.id, 1)
      await expect(client.request('profiles.bind', { profile: bob.id })).rejects.toMatchObject({
        code: 'profile_archived'
      })
    } finally {
      await client.close()
      await server.stop()
      await main.stop()
    }
  })
})
