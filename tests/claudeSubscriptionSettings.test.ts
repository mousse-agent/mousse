import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { MousseMainService } from '../src/mms/MousseMainService'
import { ProviderAuthService } from '../src/mms/providers/ProviderAuthService'

it('reads the context usage of a Claude Subscription default model without a token limit', async () => {
  const home = mkdtempSync(join(tmpdir(), 'mousse-claude-settings-'))
  vi.spyOn(ProviderAuthService.prototype, 'init').mockResolvedValue(undefined)
  const main = await MousseMainService.create({ homeDir: home, headless: true, ownerKind: 'test' })
  try {
    vi.spyOn(main.claudeSubscription, 'configured').mockReturnValue(true)
    vi.spyOn(main.claudeSubscription, 'configuredProvider').mockReturnValue({ id: 'claude-subscription', label: 'Claude Subscription', authType: 'oauth' })
    main.settings.set({ provider: { llmProvider: 'claude-subscription', model: 'sonnet' } })
    expect(await main.orchestrator.getContextUsage()).toMatchObject({ limit: 0, modelName: 'sonnet' })
  } finally {
    await main.stop()
    vi.restoreAllMocks()
    rmSync(home, { recursive: true, force: true })
  }
})
