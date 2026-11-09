import type { ProviderUsage, ProviderUsageWindow } from '../../../../shared/providerAuth'

/** The overall windows, in the order the page shows them. */
const OVERALL = [
  ['five_hour', '5-hour limit'],
  ['seven_day', 'Weekly limit']
] as const

/**
 * Display names of the weekly windows Claude scopes to a model or surface (`seven_day_<name>`, or a
 * code name for one not yet released under its own key). Any other `seven_day_<name>` is named from
 * its key ("seven_day_haiku" → "Haiku").
 */
const SCOPED_NAMES: Readonly<Record<string, string>> = {
  oauth_apps: 'OAuth apps',
  opus: 'Opus',
  sonnet: 'Sonnet',
  haiku: 'Haiku',
  fable: 'Fable',
  cowork: 'Cowork',
  iguana_necktie: 'Fable'
}
/** Keys next to the windows that are not windows of their own. */
const NOT_WINDOWS = new Set(['seven_day_breakdown'])
const MAX_SCOPED = 16

function scopedName(key: string): string {
  return SCOPED_NAMES[key] ?? key.split('_').filter(Boolean).map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ')
}

/** A model or surface weekly window's label: "Weekly · Fable". */
export function scopedWeeklyLabel(name: string): string {
  return `Weekly · ${name}`
}

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
    label: 'Claude subscription',
    status: 'unavailable',
    windows: [],
    message: 'Claude account usage limits are unavailable.'
  }
  const root = object(value)
  if (root?.rate_limits_available !== true) return result
  const limits = object(root.rate_limits)
  if (!limits) return result
  result.windows.push(...claudeLimitWindows(limits))
  if (result.windows.length) {
    result.status = 'available'
    delete result.message
  }
  return result
}

/**
 * The windows of Claude's account limits object: the overall 5-hour and weekly windows, then every
 * weekly window scoped to a model or surface that is present and not null (`seven_day_<name>`, the
 * `limits` list's `weekly_scoped` entries, the SDK's `model_scoped`), each once, then extra usage.
 * The shape of the official SDK's `rate_limits` and of the account usage a local proxy reads for
 * its Claude sign-ins. New model keys need no change here.
 */
export function claudeLimitWindows(limits: Record<string, unknown>): ProviderUsageWindow[] {
  const windows: ProviderUsageWindow[] = []
  for (const [id, label] of OVERALL) {
    const parsed = parseWindow(id, label, limits[id])
    if (parsed) windows.push(parsed)
  }
  const named = new Set<string>()
  const scoped = (id: string, name: string, row: unknown, used?: unknown) => {
    const key = name.trim().toLowerCase()
    if (!key || named.has(key) || named.size >= MAX_SCOPED) return
    const parsed = parseWindow(id, scopedWeeklyLabel(name.trim()), used === undefined ? row : { ...object(row), utilization: used })
    if (!parsed) return
    named.add(key)
    windows.push(parsed)
  }
  for (const [key, value] of Object.entries(limits)) {
    if (value === null || NOT_WINDOWS.has(key)) continue
    const match = /^seven_day_([a-z0-9_]{1,40})$/.exec(key)
    if (match) scoped(key, scopedName(match[1]!), value)
    else if (key in SCOPED_NAMES) scoped(key, SCOPED_NAMES[key]!, value)
  }
  // The usage endpoint's own list: a weekly limit scoped to a model names it (`scope.model.display_name`).
  if (Array.isArray(limits.limits)) {
    for (const item of limits.limits.slice(0, 32)) {
      const row = object(item)
      if (row?.kind !== 'weekly_scoped') continue
      const name = object(object(row.scope)?.model)?.display_name
      if (typeof name !== 'string' || name.length > 64) continue
      scoped(`model_${name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_')}`, name, row, row.percent)
    }
  }
  if (Array.isArray(limits.model_scoped)) {
    // Keep a bounded display even if an experimental SDK returns an unexpected payload.
    for (const [index, item] of limits.model_scoped.slice(0, MAX_SCOPED).entries()) {
      const row = object(item)
      const name = row?.display_name
      if (typeof name !== 'string' || name.length > 128) continue
      scoped(`model_scoped_${index}`, name, row)
    }
  }
  const extra = object(limits.extra_usage)
  if (extra?.is_enabled === true) {
    const parsed = parseWindow('extra_usage', 'Extra usage', extra)
    if (parsed) windows.push(parsed)
  }
  return windows
}
