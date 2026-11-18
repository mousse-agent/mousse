import type { UsageAgentId, UsageHistoryRange, UsageHistoryResponse, UsageTokens } from '../../shared/usageHistory'

export type UsageMeasure = 'tokens' | 'cost'

/** Each agent's colour, from the identity hues; Claude Code keeps its own warm orange. */
export const AGENT_COLOR: Record<UsageAgentId, string> = {
  'claude-code': 'var(--usage-agent-claude)',
  codex: 'var(--hue-5)',
  grok: 'var(--hue-1)',
  pi: 'var(--hue-2)',
  opencode: 'var(--hue-4)'
}

/** The provider icon each agent is drawn with. */
export const AGENT_ICON: Record<UsageAgentId, string> = {
  'claude-code': 'claude',
  codex: 'codex',
  grok: 'xai',
  pi: 'pi',
  opencode: 'opencode'
}

export const RANGE_WORDS: Record<UsageHistoryRange, string> = {
  '24h': 'last 24 hours',
  '7d': 'last 7 days',
  '30d': 'last 30 days',
  '90d': 'last 90 days'
}

export const tokenSum = (tokens: UsageTokens) => tokens.input + tokens.cacheRead + tokens.cacheWrite + tokens.output

/** 38.4B, 836M, 7.85M, 12.3K, 940. */
export function compactNumber(value: number): string {
  const abs = Math.abs(value)
  const unit = abs >= 1e9 ? ['B', 1e9] as const : abs >= 1e6 ? ['M', 1e6] as const : abs >= 1e3 ? ['K', 1e3] as const : null
  if (!unit) return String(Math.round(value))
  const scaled = value / unit[1]
  const digits = Math.abs(scaled) >= 100 ? 0 : Math.abs(scaled) >= 10 ? 1 : 2
  return `${Number(scaled.toFixed(digits))}${unit[0]}`
}

/** $14,159 above a hundred dollars, $44.11 below, <$0.01 for crumbs. */
export function money(value: number): string {
  if (value > 0 && value < 0.01) return '<$0.01'
  return value >= 100
    ? `$${Math.round(value).toLocaleString('en-US')}`
    : `$${value.toFixed(2)}`
}

export function compactMoney(value: number): string {
  if (value >= 10_000) return `$${compactNumber(value)}`
  return money(value)
}

export function percent(part: number, whole: number): string {
  if (whole <= 0 || part <= 0) return '0%'
  const share = (part / whole) * 100
  if (share < 0.1) return '<0.1%'
  return `${share >= 10 ? share.toFixed(0) : share.toFixed(1)}%`
}

export const measureValue = (measure: UsageMeasure, value: number) => (measure === 'cost' ? compactMoney(value) : compactNumber(value))

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** `2026-11-18` → `Nov 18`. */
export function dayLabel(key: string): string {
  const [, month, day] = key.split('-')
  return `${MONTHS[Number(month) - 1] ?? ''} ${Number(day)}`
}

export function bucketLabel(history: UsageHistoryResponse, index: number): string {
  if (history.bucket === 'day') return dayLabel(history.dayKeys[index] ?? '')
  const at = new Date(history.buckets[index] ?? 0)
  return `${String(at.getHours()).padStart(2, '0')}:00`
}

/** A round top for the chart's scale and its three gridlines. */
export function niceScale(max: number): number[] {
  if (max <= 0) return [0]
  const rough = max / 3
  const power = 10 ** Math.floor(Math.log10(rough))
  const step = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].map((factor) => factor * power).find((candidate) => candidate >= rough) ?? 10 * power
  return [step, step * 2, step * 3]
}
