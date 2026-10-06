import type { ProviderUsage, ProviderUsageWindow } from '../../../shared/providerAuth'

const windows = [
  ['five_hour', '5-hour limit'],
  ['seven_day', 'Weekly limit'],
  ['seven_day_oauth_apps', 'Weekly OAuth apps limit'],
  ['seven_day_opus', 'Weekly Opus limit'],
  ['seven_day_sonnet', 'Weekly Sonnet limit']
] as const

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function parseWindow(id: string, label: string, value: unknown): ProviderUsageWindow | undefined {
  const row = object(value)
  const used = row?.utilization
  if (typeof used !== 'number' || !Number.isFinite(used) || used < 0 || used > 100) return
  const reset = row?.resets_at
  return {
    id,
    label,
    remainingPercent: 100 - used,
    ...(typeof reset === 'string' && reset.length <= 128 && Number.isFinite(Date.parse(reset))
      ? { resetsAt: reset }
      : {})
  }
}

/** Only the official SDK's account quotas belong here; session tokens do not measure plan limits. */
export function parseClaudeSubscriptionUsage(value: unknown): ProviderUsage {
  const result: ProviderUsage = {
    id: 'claude-subscription',
    label: 'Claude Subscription',
    status: 'unavailable',
    windows: [],
    message: 'Claude account usage limits are unavailable.'
  }
  const root = object(value)
  if (root?.rate_limits_available !== true) return result
  const limits = object(root.rate_limits)
  if (!limits) return result
  for (const [id, label] of windows) {
    const parsed = parseWindow(id, label, limits[id])
    if (parsed) result.windows.push(parsed)
  }
  if (Array.isArray(limits.model_scoped)) {
    // Keep a bounded display even if an experimental SDK returns an unexpected payload.
    for (const [index, item] of limits.model_scoped.slice(0, 16).entries()) {
      const row = object(item)
      const name = row?.display_name
      if (typeof name !== 'string' || !name.trim() || name.length > 128) continue
      const parsed = parseWindow(`model_scoped_${index}`, `Weekly ${name.trim()} limit`, row)
      if (parsed) result.windows.push(parsed)
    }
  }
  const extra = object(limits.extra_usage)
  if (extra?.is_enabled === true) {
    const parsed = parseWindow('extra_usage', 'Extra usage', extra)
    if (parsed) result.windows.push(parsed)
  }
  if (result.windows.length) {
    result.status = 'available'
    delete result.message
  }
  return result
}
