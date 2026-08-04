import { describe, expect, it } from 'vitest'
import {
  friendlyOAuthError,
  parseAnthropicUsage,
  parseOpenAiUsage,
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

  it('parses OpenAI codex used_percent windows with resets', () => {
    const windows = parseOpenAiUsage({
      rate_limit: {
        primary_window: { limit_window_seconds: 18000, used_percent: 25, reset_at: 1700000000 },
        secondary_window: { limit_window_seconds: 604800, used_percent: 10 }
      }
    })
    expect(windows).toMatchObject([
      { id: 'five_hour', label: '5-hour', remainingPercent: 75 },
      { id: 'seven_day', label: 'Weekly', remainingPercent: 90 }
    ])
    expect(windows[0]?.resetsAt).toBe(new Date(1700000000 * 1000).toISOString())
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
