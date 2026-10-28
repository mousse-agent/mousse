import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { MousseMainService } from '../../../src/mms/MousseMainService'

/** What the loader of the version before the routing flag does with the stored Net configuration. */
function olderVersionAccepts(stored: { features?: Record<string, unknown> }): boolean {
  const features = stored.features
  return (
    features === undefined ||
    (!!features &&
      typeof features.netBridge === 'boolean' &&
      typeof features.netSpaces === 'boolean' &&
      !Object.keys(features).some((key) => !['netBridge', 'netSpaces'].includes(key)))
  )
}

type Config = { features: { netBridgeThreads: boolean } }

it('stores the routing flag only while it is off, so an earlier version still loads the saved Net configuration', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'net-stored-flags-')))
  const main = await MousseMainService.create({
    homeDir: join(root, 'home'),
    repoRoot: root,
    headless: true,
    requireOwnership: false
  })
  try {
    await main.net.request('net.init', { listen: true })
    await main.net.request('net.protect', { passphrase: 'stored-flags-passphrase' })
    const stored = (): { features: Record<string, unknown> } =>
      JSON.parse(
        main.net.runtime().db.database.prepare('SELECT value FROM net_service_config').get()!.value as string
      )
    // On, the default: the saved configuration is what the earlier version wrote, and it reads it.
    expect(stored().features).toEqual({ netBridge: true, netSpaces: true })
    expect(olderVersionAccepts(stored())).toBe(true)
    // The flag is on in memory, and a later save (any setting) keeps the stored form.
    expect(main.net.status().features).toEqual({ netBridge: true, netSpaces: true, netBridgeThreads: true })
    await main.net.request('bridge.workOnThreads', { enabled: true })
    expect(olderVersionAccepts(stored())).toBe(true)
    // Off: it is stored (a tester who turned it off goes back at their own risk), and read back.
    ;(main.net as unknown as { config: Config }).config.features.netBridgeThreads = false
    await main.net.request('bridge.workOnThreads', { enabled: false })
    expect(stored().features.netBridgeThreads).toBe(false)
    ;(main.net as unknown as { config: Config }).config.features.netBridgeThreads = true
    await main.net.request('bridge.workOnThreads', { enabled: true })
    expect(olderVersionAccepts(stored())).toBe(true)
  } finally {
    await main.stop()
    rmSync(root, { recursive: true, force: true })
  }
}, 60_000)

it('has both switches for other computers on by default, and keeps a choice to turn them off', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'net-default-on-')))
  const main = await MousseMainService.create({
    homeDir: join(root, 'home'),
    repoRoot: root,
    headless: true,
    requireOwnership: false
  })
  try {
    await main.net.request('net.init', { listen: true })
    // Nothing was ever stored for them, so a profile from before this change gets the defaults.
    expect(main.net.status()).toMatchObject({ workOnThreads: true, features: { netBridgeThreads: true } })
    expect(await main.net.request('bridge.workOnThreads', {})).toEqual({ enabled: true })
    // Turning the owner switch off is kept, and is the kill switch.
    expect(await main.net.request('bridge.workOnThreads', { enabled: false })).toEqual({ enabled: false })
    expect(main.net.status().workOnThreads).toBe(false)
    expect(await main.net.request('bridge.workOnThreads', { enabled: true })).toEqual({ enabled: true })
    expect(main.net.status().workOnThreads).toBe(true)
  } finally {
    await main.stop()
    rmSync(root, { recursive: true, force: true })
  }
}, 60_000)
