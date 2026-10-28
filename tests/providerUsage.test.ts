import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import type { ConfiguredProvider, ProviderUsage } from '../src/shared/providerAuth'
import {
  friendlyOAuthError,
  ProviderAuthService,
  parseAnthropicUsage,
  parseXaiCreditsUsage,
  parseXaiMonthlyUsage,
  percentRemainingFromUtilization
} from '../src/mms/providers/ProviderAuthService'

describe('provider usage parsers', () => {
  it('treats Anthropic utilization as a 0-1 fraction', () => {
    expect(percentRemainingFromUtilization(0.25)).toBe(75)
    expect(percentRemainingFromUtilization(1)).toBe(0)
    expect(percentRemainingFromUtilization(40)).toBe(60)
  })

  it('parses nested Anthropic rate_limits windows with resets', () => {
    const windows = parseAnthropicUsage({
      rate_limits: {
        five_hour: { utilization: 0.2, resets_at: '2026-01-01T00:00:00Z' },
        seven_day: { utilization: 0.5, resets_at: '2026-01-07T00:00:00Z' }
      }
    })

    expect(windows).toEqual([
      {
        id: 'five_hour',
        label: '5-hour',
        remainingPercent: 80,
        resetsAt: '2026-01-01T00:00:00Z'
      },
      {
        id: 'seven_day',
        label: 'Weekly',
        remainingPercent: 50,
        resetsAt: '2026-01-07T00:00:00Z'
      }
    ])
  })

  it('parses Grok SuperGrok weekly credits usage (used percent → remaining)', () => {
    const windows = parseXaiCreditsUsage({
      config: {
        creditUsagePercent: 15,
        currentPeriod: {
          type: 'USAGE_PERIOD_TYPE_WEEKLY',
          start: '2026-08-04T03:44:05.897818+00:00',
          end: '2026-08-11T03:44:05.897818+00:00'
        },
        billingPeriodEnd: '2026-08-11T03:44:05.897818+00:00'
      }
    })
    expect(windows).toEqual([
      {
        id: 'weekly',
        label: 'Weekly',
        remainingPercent: 85,
        resetsAt: '2026-08-11T03:44:05.897818+00:00'
      }
    ])
  })

  it('parses wrapped Grok usage and numeric strings', () => {
    expect(parseXaiCreditsUsage({ data: { credit_usage_percent: '20', current_period: { end: '2026-08-11T00:00:00Z' } } })).toEqual([
      { id: 'weekly', label: 'Weekly', remainingPercent: 80, resetsAt: '2026-08-11T00:00:00Z' }
    ])
    expect(parseXaiMonthlyUsage({ result: { config: { monthly_limit: { val: '100' }, used: { val: '30' } } } })).toEqual([
      { id: 'monthly', label: 'Monthly', remainingPercent: 70, resetsAt: undefined }
    ])
  })

  it('parses Grok credit totals when percent fields are absent', () => {
    expect(
      parseXaiCreditsUsage({
        config: {
          totalCredits: { val: 200 },
          usedCredits: { val: 50 },
          billingPeriodEnd: '2026-08-20T00:00:00Z'
        }
      })
    ).toEqual([
      { id: 'weekly', label: 'Weekly', remainingPercent: 75, resetsAt: '2026-08-20T00:00:00Z' }
    ])
  })

  it('ignores zero monthly caps so credits-tier accounts are not misread', () => {
    expect(
      parseXaiMonthlyUsage({
        config: {
          monthlyLimit: { val: 0 },
          used: { val: 0 },
          billingPeriodEnd: '2026-09-01T00:00:00+00:00'
        }
      })
    ).toEqual([])
  })

  it('parses Grok monthly included usage with period end', () => {
    const windows = parseXaiMonthlyUsage({
      config: {
        monthlyLimit: { val: 1000 },
        used: { val: 250 },
        billingPeriodEnd: '2026-09-01T00:00:00+00:00'
      }
    })
    expect(windows).toEqual([
      {
        id: 'monthly',
        label: 'Monthly',
        remainingPercent: 75,
        resetsAt: '2026-09-01T00:00:00+00:00'
      }
    ])
  })

  it('turns verbose OAuth refresh failures into short reconnect copy', () => {
    const message = friendlyOAuthError(
      'Anthropic',
      new Error(
        'OAuth refresh failed for anthropic: Anthropic token refresh request failed. url=https://platform.claude.com/v1/oauth/token; details=Error: HTTP request failed. status=400; body={"error": "invalid_grant", "error_description": "Refresh token not found or invalid"}; stack=Error: HTTP request failed'
      )
    )
    expect(message).toBe('Anthropic session expired. Reconnect it in Settings.')
    expect(message).not.toContain('stack=')
    expect(message).not.toContain('invalid_grant')
  })
})

describe('provider usage dispatch', () => {
  let dir: string
  let auth: ProviderAuthService
  let readers: { xai: MockInstance; go: MockInstance }
  const fetchSpy = vi.fn(async () => {
    throw new Error('no request leaves this test')
  })
  const reading = (provider: ConfiguredProvider): ProviderUsage => ({ ...provider, status: 'available', windows: [{ id: 'week', label: 'Weekly', remainingPercent: 40 }] })

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mousse-usage-dispatch-'))
    vi.stubGlobal('fetch', fetchSpy)
    auth = new ProviderAuthService(join(dir, 'auth.json'))
    const spied = auth as unknown as Record<'fetchXaiUsage' | 'fetchOpenCodeGoUsage', (provider: ConfiguredProvider) => Promise<ProviderUsage>>
    readers = {
      xai: vi.spyOn(spied, 'fetchXaiUsage').mockImplementation(async (provider) => reading(provider)),
      go: vi.spyOn(spied, 'fetchOpenCodeGoUsage').mockImplementation(async (provider) => reading(provider))
    }
    vi.spyOn(auth, 'getConfiguredProviders').mockReturnValue([
      { id: 'xai', label: 'xAI', authType: 'oauth' },
      { id: 'opencode-go', label: 'OpenCode Go', authType: 'api_key' },
      { id: 'openrouter', label: 'OpenRouter', authType: 'api_key' }
    ])
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    rmSync(dir, { recursive: true, force: true })
  })

  it('reaches the xai and opencode-go readers and marks every other provider unavailable', async () => {
    const { providers } = await auth.getUsage()
    expect(providers.map(({ id, status }) => [id, status])).toEqual([['xai', 'available'], ['opencode-go', 'available'], ['openrouter', 'unavailable']])
    expect(providers[2].message).toBe('Usage information is not available for this provider.')
    expect(readers.xai).toHaveBeenCalledTimes(1)
    expect(readers.go).toHaveBeenCalledTimes(1)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('subscription usage reads only providers with a reader', async () => {
    expect(await auth.getSubscriptionUsage('xai')).toContain('60% used')
    expect(await auth.getSubscriptionUsage('opencode-go')).toContain('60% used')
    for (const id of ['openrouter', 'anthropic', 'constructor', 'unknown-provider']) expect(await auth.getSubscriptionUsage(id)).toBeUndefined()
    expect(readers.xai).toHaveBeenCalledTimes(1)
    expect(readers.go).toHaveBeenCalledTimes(1)
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
