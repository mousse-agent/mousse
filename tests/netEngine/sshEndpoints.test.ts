/**
 * What B's side of Add over SSH says about this installation (1b §3.3, §3.4): `endpoints.json`, which
 * `mousse-helper pipe --profile <selector>` reads, follows each profile's networking switch and the profiles that
 * come and go; `starts_at_login` is whether Mousse's startup entry is installed.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { dispatchMethod } from '../../src/mms/protocol/handlers'
import { PROFILES_V1_CAPABILITY } from '../../src/shared/profiles/types'
import { Fabric, type Computer } from './checks/harness'

// The startup entry is this test's, never the computer's.
const startup = vi.hoisted(() => ({ installed: false }))
vi.mock('../../src/mms/startup', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/mms/startup')>()),
  startupStatus: async () => ({ installed: startup.installed })
}))

describe("B's endpoints.json and starts_at_login", () => {
  const fabric = new Fabric()
  let b: Computer
  beforeAll(async () => {
    b = await fabric.computer('b')
    await b.mms.sshRemote()!.afterReady()
  }, 120_000)
  afterAll(() => fabric.close(), 120_000)

  const endpoints = (): Record<string, { networking: boolean }> =>
    JSON.parse(readFileSync(join(b.home, 'net-engine', 'endpoints.json'), 'utf8')).profiles
  const selector = (root: string) => b.mms.sshRemote()!.selectorOf(root)
  /** The profiles window's call (installation methods, with the profiles capability). */
  const profiles = (method: string, params: unknown): Promise<any> =>
    dispatchMethod(
      {
        mms: b.mms,
        connection: { id: 'profiles', clientType: 'gui', capabilities: new Set([PROFILES_V1_CAPABILITY]) },
        globalSequence: () => b.mms.protocolSequence()
      } as never,
      method,
      params
    )

  it('says each switch of networking as it happens', async () => {
    const own = selector(b.mms.netEngine.profileDir)
    expect(endpoints()[own]).toMatchObject({ networking: true })
    await b.dispatch('netEngine.disable', {}, true)
    expect(endpoints()[own]).toMatchObject({ networking: false })
    await b.dispatch('netEngine.enable', {}, true)
    expect(endpoints()[own]).toMatchObject({ networking: true })
  }, 120_000)

  it('lists a profile once it is made, and drops it when it is archived or removed', async () => {
    const host = b.mms.getInstallationHost()!
    const made = await profiles('profiles.create', { displayName: 'Second' })
    const id: string = made.profile.id
    const root = host.manager.getPaths(id).root
    expect(Object.keys(endpoints())).toContain(selector(root))
    const revision = () => host.manager.get(id).revision
    await profiles('profiles.archive', { profileId: id, expectedRevision: revision() })
    expect(Object.keys(endpoints())).not.toContain(selector(root))
    await profiles('profiles.restore', { profileId: id, expectedRevision: revision() })
    expect(Object.keys(endpoints())).toContain(selector(root))
    await profiles('profiles.remove', { profileId: id, expectedRevision: revision() })
    expect(Object.keys(endpoints())).not.toContain(selector(root))
  }, 120_000)

  it('starts_at_login is whether the startup entry is installed', async () => {
    const remote = b.mms.sshRemote()!
    startup.installed = true
    expect(await remote.serve({ op: 'profiles' })).toMatchObject({ starts_at_login: true })
    startup.installed = false
    expect(await remote.serve({ op: 'profiles' })).toMatchObject({ starts_at_login: false })
  }, 120_000)
})
