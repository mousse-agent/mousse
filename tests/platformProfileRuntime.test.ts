import { mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
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
      expect(bobServices.control).not.toBe(main.control)
      expect(bobServices.projects).not.toBe(main.projects)
      expect(bobServices.integrationContext.profileRoot).toBe(bobServices.getProfileHomeDir())
      const sharedRepository = join(root, 'shared-repository')
      const defaultProject = main.projects.openProject(sharedRepository)
      const bobProject = bobServices.projects.openProject(sharedRepository)
      expect(defaultProject.id).not.toBe(bobProject.id)
      expect(main.projects.listProjects()).toHaveLength(1)
      expect(bobServices.projects.listProjects()).toHaveLength(1)
      expect(defaultProject.path).toBe(bobProject.path)
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

  it('routes live personal events only to their bound profile and freezes admitted request ownership', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mousse-profile-events-'))
    roots.push(root)
    const home = join(root, 'home')
    mkdirSync(home, { recursive: true })
    const main = await MousseMainService.create({ homeDir: home, repoRoot: root, requireOwnership: false })
    const host = main.getInstallationHost()!
    const defaultId = host.getDefaultProfileId()
    const bob = host.manager.create({ displayName: 'Bob', slug: 'bob' })
    const bobServices = await main.getProfileServices(bob.id)
    let entered!: () => void
    let release!: () => void
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve })
    const releasePromise = new Promise<void>((resolve) => { release = resolve })
    main.domains.register({
      method: 'fixture.profileDelay',
      scope: 'profile',
      validate: () => ({}),
      handle: async (ctx, _params, binding) => {
        entered()
        await releasePromise
        return { serviceProfileId: ctx.mms.profileId, admittedProfileId: binding?.profileId }
      }
    })
    const ownerToken = 'fixture-owner-token'
    const server = new MmsProtocolServer({ mms: main, ownerToken })
    const endpoint = await server.start()
    const makeClient = () => new LocalMmsClient({
      homeDir: home,
      endpoint,
      ownerToken,
      requestedCapabilities: ['profiles-v1']
    })
    const aliceClient = makeClient()
    const bobClient = makeClient()
    const aliceEvents: Array<{ type: string; sequence: number; profileId?: string; data?: unknown }> = []
    const bobEvents: Array<{ type: string; sequence: number; profileId?: string; data?: unknown }> = []
    try {
      await Promise.all([aliceClient.connect(), bobClient.connect()])
      await aliceClient.request('profiles.bind', { profile: defaultId })
      await bobClient.request('profiles.bind', { profile: bob.id })
      aliceClient.onEvent((event) => aliceEvents.push(event))
      bobClient.onEvent((event) => bobEvents.push(event))
      await Promise.all([aliceClient.subscribe(0), bobClient.subscribe(0)])

      main.orchestrator.emit('thread-message', { threadId: 'same-thread', message: { content: 'alice-private' } })
      bobServices.orchestrator.emit('thread-message', { threadId: 'same-thread', message: { content: 'bob-private' } })
      main.questions.emit('pending', { requestId: 'alice-question', threadId: 'same-thread', questions: [{ prompt: 'alice?' }] })
      bobServices.questions.emit('pending', { requestId: 'bob-question', threadId: 'same-thread', questions: [{ prompt: 'bob?' }] })
      main.ptyManager.emit('data', { ptyId: 'alice-pty', data: 'alice-pty-private', sequence: 1, threadId: 'same-thread', agentId: 'a' })
      bobServices.ptyManager.emit('data', { ptyId: 'bob-pty', data: 'bob-pty-private', sequence: 1, threadId: 'same-thread', agentId: 'b' })
      await vi.waitFor(() => {
        expect(aliceEvents.filter((event) => ['thread.message', 'questions.pending', 'pty.data'].includes(event.type))).toHaveLength(3)
        expect(bobEvents.filter((event) => ['thread.message', 'questions.pending', 'pty.data'].includes(event.type))).toHaveLength(3)
      })
      expect(JSON.stringify(aliceEvents)).toContain('alice-private')
      expect(JSON.stringify(aliceEvents)).not.toContain('bob-private')
      expect(JSON.stringify(bobEvents)).toContain('bob-private')
      expect(JSON.stringify(bobEvents)).not.toContain('alice-private')
      expect(aliceEvents.every((event) => !event.profileId || event.profileId === defaultId)).toBe(true)
      expect(bobEvents.every((event) => !event.profileId || event.profileId === bob.id)).toBe(true)
      expect(aliceClient.requiresResnapshot).toBe(false)
      expect(bobClient.requiresResnapshot).toBe(false)
      for (const events of [aliceEvents, bobEvents]) {
        const sequences = events.map((event) => event.sequence)
        expect(sequences.every((sequence, index) => index === 0 || sequence === sequences[index - 1] + 1)).toBe(true)
      }

      const admitted = aliceClient.request<{ serviceProfileId: string; admittedProfileId: string }>('fixture.profileDelay')
      await enteredPromise
      await aliceClient.request('profiles.bind', { profile: bob.id })
      release()
      await expect(admitted).resolves.toEqual({ serviceProfileId: defaultId, admittedProfileId: defaultId })
    } finally {
      release()
      await Promise.allSettled([aliceClient.close(), bobClient.close()])
      await server.stop()
      await main.stop()
    }
  })

  it('preserves structured profile revision conflicts without stopping the active runtime', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mousse-profile-conflict-'))
    roots.push(root)
    const home = join(root, 'home')
    mkdirSync(home, { recursive: true })
    const main = await MousseMainService.create({ homeDir: home, repoRoot: root, requireOwnership: false })
    const host = main.getInstallationHost()!
    const bob = host.manager.create({ displayName: 'Bob', slug: 'bob' })
    const bobServices = await main.getProfileServices(bob.id)
    await bobServices.start()
    const ownerToken = 'fixture-owner-token'
    const server = new MmsProtocolServer({ mms: main, ownerToken })
    const endpoint = await server.start()
    const client = new LocalMmsClient({ homeDir: home, endpoint, ownerToken, requestedCapabilities: ['profiles-v1'] })
    try {
      await client.connect()
      await client.request('profiles.update', { profileId: bob.id, expectedRevision: 1, displayName: 'Bob 2' })
      await expect(client.request('profiles.archive', { profileId: bob.id, expectedRevision: 1 })).rejects.toMatchObject({
        code: 'profile_revision_conflict',
        details: { profileId: bob.id, expectedRevision: 1, actualRevision: 2 }
      })
      expect(host.getLive(bob.id)).toBe(bobServices)
    } finally {
      await client.close()
      await server.stop()
      await main.stop()
    }
  })

  it('removes a profile from the live index after moving its owned root to trash', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mousse-profile-remove-'))
    roots.push(root)
    const home = join(root, 'home')
    mkdirSync(home, { recursive: true })
    const main = await MousseMainService.create({ homeDir: home, repoRoot: root, requireOwnership: false })
    const host = main.getInstallationHost()!
    const bob = host.manager.create({ displayName: 'Bob', slug: 'bob' })
    const server = new MmsProtocolServer({ mms: main, ownerToken: 'fixture-owner-token' })
    const endpoint = await server.start()
    const client = new LocalMmsClient({ homeDir: home, endpoint, ownerToken: 'fixture-owner-token', requestedCapabilities: ['profiles-v1'] })
    try {
      await client.connect()
      await client.request('profiles.remove', { profileId: bob.id, expectedRevision: bob.revision })
      const listed = await client.request<{ profiles: Array<{ id: string }> }>('profiles.list')
      expect(listed.profiles.some((profile) => profile.id === bob.id)).toBe(false)
      expect(() => host.manager.get(bob.id)).toThrow()
      expect(readdirSync(join(home, 'trash', 'profiles')).some((name) => name.startsWith(`${bob.id}-`))).toBe(true)
    } finally {
      await client.close()
      await server.stop()
      await main.stop()
    }
  })

  it('recovers a deletion interrupted after the owned root moved but before index cleanup', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mousse-profile-remove-recovery-'))
    roots.push(root)
    const home = join(root, 'home')
    mkdirSync(home, { recursive: true })
    const main = await MousseMainService.create({ homeDir: home, repoRoot: root, requireOwnership: false })
    const host = main.getInstallationHost()!
    const bob = host.manager.create({ displayName: 'Bob', slug: 'bob' })
    const profileRoot = host.installation.profileRoot(bob.id)
    const token = '11111111-1111-4111-8111-111111111111'
    const destinationName = `${bob.id}-${token}`
    const trashRoot = join(home, 'trash', 'profiles')
    const pendingRoot = join(trashRoot, '.pending')
    const destination = join(trashRoot, destinationName)
    mkdirSync(pendingRoot, { recursive: true })
    host.manager.archive(bob.id, bob.revision)
    const archivedRecord = JSON.parse(readFileSync(join(profileRoot, 'profile.json'), 'utf8'))
    renameSync(profileRoot, destination)
    writeFileSync(join(pendingRoot, `${destinationName}.json`), JSON.stringify({
      version: 1,
      profileId: bob.id,
      destinationName,
      archivedRevision: bob.revision + 1,
      archivedRecord,
      createdAt: new Date().toISOString()
    }))
    await main.stop()

    const restarted = await MousseMainService.create({ homeDir: home, repoRoot: root, requireOwnership: false })
    try {
      expect(() => restarted.getInstallationHost()!.manager.get(bob.id)).toThrow(/not found/)
      expect(readdirSync(trashRoot)).toContain(destinationName)
      expect(readdirSync(pendingRoot)).toHaveLength(0)
      expect(readFileSync(join(destination, 'profile.json'), 'utf8')).toContain(bob.id)
    } finally {
      await restarted.stop()
    }
  })
})
