/**
 * PR 5a-2: with `providers.changed` gone, two background changes reach clients only through the
 * gateway's snapshots event. The profile services wire them there: Antigravity's own state change
 * (a revoked sign-in, an install finishing) and a model catalogue refresh.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { MousseMainService } from '../src/mms/MousseMainService'
import { ProviderAuthService } from '../src/mms/providers/ProviderAuthService'
import type { Harness } from '../src/mms/harness/gateway'

it('Antigravity changes and catalogue refreshes go to the gateway, which publishes the snapshots', async () => {
  const home = mkdtempSync(join(tmpdir(), 'mousse-provider-events-'))
  vi.spyOn(ProviderAuthService.prototype, 'init').mockResolvedValue(undefined)
  const main = await MousseMainService.create({ homeDir: home, headless: true, ownerKind: 'test' })
  try {
    const harness = main.harness as unknown as Harness
    const vendorStateChanged = vi.spyOn(harness, 'vendorStateChanged').mockImplementation(() => {})
    const catalogChanged = vi.spyOn(harness, 'catalogChanged')
    main.antigravity.hooks.changed?.()
    expect(vendorStateChanged).toHaveBeenCalledWith('antigravity')
    // A background refresh announces itself to every listener of the shared catalogue.
    const listeners = (main.providerAuth as unknown as { catalogListeners: Set<() => void> }).catalogListeners
    for (const listener of listeners) listener()
    expect(catalogChanged).toHaveBeenCalledTimes(1)
  } finally {
    await main.stop()
    vi.restoreAllMocks()
    rmSync(home, { recursive: true, force: true })
  }
})
