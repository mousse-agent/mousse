/** What another computer is told about the permission mode its turns will run in here. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup } from '../hub/fixture'
import { cleanupAll } from './routerFixture'
import { routedOwner } from './routedFixture'

afterEach(async () => {
  vi.restoreAllMocks()
  await cleanup()
  await cleanupAll()
})

describe('composer.options for a device', () => {
  it('names this computer\'s default mode and the most it lets that device have, and follows a change of the limit', async () => {
    const o = await routedOwner()
    // The models and skills are not what is asked here; reading them opens sign-in and skill folders this test does not need.
    vi.spyOn(o.f.mms.providerAuth, 'init').mockResolvedValue(undefined as never)
    if (o.f.mms.harness) vi.spyOn(o.f.mms.harness, 'llmProviders').mockResolvedValue([])
    vi.spyOn(o.f.mms.skillsRegistry, 'discover').mockResolvedValue({ skills: [] } as never)
    const first = await o.ok('composer.options', {})
    // A new computer starts at Auto-accept edits.
    expect(first.permission).toEqual({ defaultMode: expect.stringMatching(/^(ask|accept_edits|full)$/), limit: 'accept_edits' })
    o.policy.set(o.f.callerNode, { maxPermissionMode: 'full' })
    expect((await o.ok('composer.options', {})).permission.limit).toBe('full')
    o.policy.set(o.f.callerNode, { maxPermissionMode: 'ask' })
    expect((await o.ok('composer.options', {})).permission.limit).toBe('ask')
  }, 120_000)
})
