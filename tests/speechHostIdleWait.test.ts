import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MousseMainService } from '../src/mms/MousseMainService'
import { ProviderAuthService } from '../src/mms/providers/ProviderAuthService'

const roots: string[] = []
const previousHome = process.env.MOUSSE_HOME

afterEach(() => {
  vi.restoreAllMocks()
  if (previousHome === undefined) delete process.env.MOUSSE_HOME
  else process.env.MOUSSE_HOME = previousHome
  for (const root of roots.splice(0)) {
    const path = relative(realpathSync(tmpdir()), realpathSync(root))
    if (isAbsolute(path) || !path.startsWith('mousse-speech-idle-') || path.includes('..'))
      throw new Error('Unexpected fixture root')
    rmSync(root, { recursive: true, force: true, maxRetries: 5 })
  }
})

describe('idle phone speech wait', () => {
  it('is not owned profile work, so storage changes and shutdown do not wait on it', async () => {
    vi.spyOn(ProviderAuthService.prototype, 'init').mockResolvedValue(undefined)
    const root = mkdtempSync(join(tmpdir(), 'mousse-speech-idle-'))
    roots.push(root)
    process.env.MOUSSE_HOME = root
    const main = await MousseMainService.create({
      homeDir: join(root, 'home'),
      repoRoot: root,
      requireOwnership: false
    })
    const host = main.getInstallationHost()!
    const profile = host.manager.create({ displayName: 'Speech idle', slug: 'speech-idle' })
    const services = await host.getProfileServices(profile.id)
    try {
      let release!: () => void
      const open = new Promise<void>((resolve) => (release = resolve))
      const wait = services.runOwnedRequest('speech.host.wait', () => open)
      expect(services.getOwnedActivity()).not.toHaveProperty('rpc:speech.host.wait')

      // A storage lifecycle request still runs while the window's wait is open.
      await expect(services.runOwnedRequest('threads.trash', () => 'trashed')).resolves.toBe('trashed')

      // Other requests stay owned work.
      let finish!: () => void
      const held = services.runOwnedRequest('fixture.write', () => new Promise<void>((resolve) => (finish = resolve)))
      expect(services.getOwnedActivity()).toMatchObject({ 'rpc:fixture.write': 1 })
      finish()
      await held

      // Once the profile drains, a new wait is refused like any other request.
      services.beginShutdown()
      await expect(
        Promise.resolve().then(() => services.runOwnedRequest('speech.host.wait', async () => ({})))
      ).rejects.toMatchObject({ code: 'profile_draining' })
      release()
      await wait
    } finally {
      await main.stop()
    }
  }, 20_000)
})
