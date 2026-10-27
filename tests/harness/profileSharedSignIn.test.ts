import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MousseMainService } from '../../src/mms/MousseMainService'
import type { Harness } from '../../src/mms/harness/gateway'
import type { MoveResult } from '../../src/shared/harness/move'

/**
 * The `openai-codex` sign-in is one credential for the whole device. A profile composed by the
 * profile host (the default one and every other) must ask the host whether another profile still
 * uses it before a move deletes it; with no host to ask, it is kept.
 */

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** The gateway's step that deletes a moved entry's old sign-in, after the move is saved. */
async function dropOldSignIn(harness: Harness): Promise<MoveResult['oldSignIn']> {
  const internals = harness as unknown as {
    record(instanceId: string, options: { allowDisabled: boolean }): unknown
    dropOldSignIn(record: unknown): Promise<MoveResult['oldSignIn']>
  }
  return internals.dropOldSignIn(internals.record('pi:openai-codex', { allowDisabled: true }))
}

describe('a move keeps the shared openai-codex sign-in while another profile uses it', () => {
  it('in a non-default profile composed by the profile host, and in the default one', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mousse-shared-signin-'))
    roots.push(root)
    const home = join(root, 'home')
    mkdirSync(home, { recursive: true })
    const main = await MousseMainService.create({ homeDir: home, repoRoot: root, headless: true, requireOwnership: false })
    try {
      const host = main.getInstallationHost()!
      const work = host.manager.create({ displayName: 'Work', slug: 'work' })
      const workServices = await main.getProfileServices(work.id)
      expect(workServices).not.toBe(main)
      // A plain profile has no host of its own: the hook must still come from the profile host.
      expect(workServices.getInstallationHost()).toBeNull()
      // One credential for the device; both profiles list an unmoved `pi:openai-codex` from it.
      await main.providerAuth.setApiKey('openai-codex', 'dummy-shared-credential')
      const entry = (services: typeof main) => services.providerInstances.list()['pi:openai-codex']
      expect(entry(main)).toBeDefined()
      expect(entry(workServices)).toBeDefined()

      // The work profile moves while the default profile's entry is unmoved: the credential stays.
      expect(await dropOldSignIn(workServices.harness!)).toBe('kept_shared')
      expect(main.providerAuth.has('openai-codex')).toBe(true)

      // The default profile, while the work profile's entry is unmoved: kept too.
      expect(await dropOldSignIn(main.harness!)).toBe('kept_shared')
      expect(main.providerAuth.has('openai-codex')).toBe(true)

      // Both entries moved: nothing uses the sign-in any more, and the last mover deletes it.
      const moved = { driver: 'pi', enabled: false, config: { movedTo: 'codex' } } as never
      main.providerInstances.setEntry('pi:openai-codex', moved)
      expect(await dropOldSignIn(workServices.harness!)).toBe('removed')
      expect(main.providerAuth.has('openai-codex')).toBe(false)
    } finally {
      await main.stop()
    }
  })

  it('with no host to ask, the sign-in is kept', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mousse-shared-signin-nohost-'))
    roots.push(root)
    const home = join(root, 'home')
    mkdirSync(home, { recursive: true })
    const main = await MousseMainService.create({ homeDir: home, repoRoot: root, headless: true, requireOwnership: false })
    try {
      await main.providerAuth.setApiKey('openai-codex', 'dummy-shared-credential')
      // The default profile loses its host (a profile built outside the host).
      ;(main as unknown as { profileHost: null }).profileHost = null
      expect(await dropOldSignIn(main.harness!)).toBe('kept_shared')
      expect(main.providerAuth.has('openai-codex')).toBe(true)
    } finally {
      await main.stop()
    }
  })
})
