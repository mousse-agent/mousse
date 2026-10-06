import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { MousseMainService } from '../src/mms/MousseMainService'
import { ProviderAuthService } from '../src/mms/providers/ProviderAuthService'
import { dispatchMethod } from '../src/mms/protocol/handlers'

it('offers Claude Subscription in the subscription picker and retains it in provider updates', async () => {
  const home = mkdtempSync(join(tmpdir(), 'mousse-claude-settings-'))
  vi.spyOn(ProviderAuthService.prototype, 'init').mockResolvedValue(undefined)
  const main = await MousseMainService.create({ homeDir: home, headless: true, ownerKind: 'test' })
  try {
    const emitEvent = vi.fn()
    const context = { mms: main, globalSequence: () => 0, emitEvent }
    const subscriptions = await dispatchMethod(context, 'providers.getLoginOptions', { authType: 'oauth' }) as { options: Array<{ id: string; label: string }> }
    expect(subscriptions.options).toContainEqual(expect.objectContaining({ id: 'claude-subscription', label: 'Claude Subscription' }))
    const apiKeys = await dispatchMethod(context, 'providers.getLoginOptions', { authType: 'api_key' }) as typeof subscriptions
    expect(apiKeys.options.some((option) => option.id === 'claude-subscription')).toBe(false)
    const configured = { id: 'claude-subscription', label: 'Claude Subscription', authType: 'oauth' as const }
    vi.spyOn(main.claudeSubscription, 'configured').mockReturnValue(true)
    vi.spyOn(main.claudeSubscription, 'configuredProvider').mockReturnValue(configured)
    vi.spyOn(main.providerAuth, 'setApiKey').mockResolvedValue(undefined)
    vi.spyOn(main.providerAuth, 'refreshDynamicModels').mockResolvedValue(undefined)
    const result = await dispatchMethod(context, 'providers.setApiKey', { providerId: 'anthropic', apiKey: 'test-only-key' })
    expect(result).toMatchObject({ providers: expect.arrayContaining([configured]) })
    expect(emitEvent).toHaveBeenCalledWith('providers.changed', expect.objectContaining({ providers: expect.arrayContaining([configured]) }))
    const options = await dispatchMethod(context, 'providers.getLoginOptions', { authType: 'oauth' }) as typeof subscriptions
    expect(options.options.some((option) => option.id === 'claude-subscription')).toBe(false)
    main.settings.set({ provider: { llmProvider: 'claude-subscription', model: 'sonnet' } })
    expect(await main.orchestrator.getContextUsage()).toMatchObject({ limit: 0, modelName: 'sonnet' })
  } finally {
    await main.stop()
    vi.restoreAllMocks()
    rmSync(home, { recursive: true, force: true })
  }
})
