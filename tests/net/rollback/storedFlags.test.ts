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

it('stores the routing flag only while it is on, so an earlier version still loads the saved Net configuration', async () => {
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
    // Off: the saved configuration is what the earlier version wrote, and it reads it.
    expect(stored().features).toEqual({ netBridge: true, netSpaces: true })
    expect(olderVersionAccepts(stored())).toBe(true)
    // The flag is still false in memory, and a later save (any setting) keeps the stored form.
    expect(main.net.status().features).toEqual({ netBridge: true, netSpaces: true, netBridgeThreads: false })
    await main.net.request('bridge.workOnThreads', { enabled: true })
    expect(olderVersionAccepts(stored())).toBe(true)
    // On: it is stored (a tester who turned it on goes back at their own risk), and read back.
    ;(main.net as unknown as { config: { features: { netBridgeThreads: boolean } } }).config.features.netBridgeThreads = true
    await main.net.request('bridge.workOnThreads', { enabled: false })
    expect(stored().features.netBridgeThreads).toBe(true)
    ;(main.net as unknown as { config: { features: { netBridgeThreads: boolean } } }).config.features.netBridgeThreads = false
    await main.net.request('bridge.workOnThreads', { enabled: true })
    expect(olderVersionAccepts(stored())).toBe(true)
  } finally {
    await main.stop()
    rmSync(root, { recursive: true, force: true })
  }
}, 60_000)
