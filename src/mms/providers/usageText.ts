import type { ProviderUsage } from '../../shared/providerAuth'

/** A provider's usage as lines of text (channel `/usage`): what it reported, never an estimate. */
export function usageText(label: string, usage: Pick<ProviderUsage, 'status' | 'windows' | 'message'>): string {
  if (usage.status !== 'available' || usage.windows.length === 0) return usage.message ?? `Subscription usage is not available for ${label}.`
  const lines = usage.windows.map((window) => {
    const usedPercent = Math.max(0, Math.min(100, 100 - window.remainingPercent))
    const reset = window.resetsAt ? ` (${formatUsageResetCountdown(window.resetsAt)})` : ''
    return `${window.label}: ${usedPercent}% used${reset}`
  })
  return [`${label} usage:`, ...lines.map((line) => `- ${line}`)].join('\n')
}

/** Compact countdown down to the minute for channel `/usage` text (`45m`, `5h 12m`, `4d 3h 12m`). */
export function formatUsageResetCountdown(resetsAt: string): string {
  const date = new Date(resetsAt)
  if (Number.isNaN(date.getTime())) return 'reset unknown'
  const deltaMs = date.getTime() - Date.now()
  if (deltaMs <= 0) return 'resets soon'
  const totalMinutes = Math.floor(deltaMs / 60_000)
  if (totalMinutes < 1) return 'resets soon'
  if (totalMinutes < 60) return `resets in ${totalMinutes}m`
  const days = Math.floor(totalMinutes / 1440)
  const hours = Math.floor((totalMinutes % 1440) / 60)
  const mins = totalMinutes % 60
  if (days === 0) return `resets in ${hours}h ${mins}m`
  return `resets in ${days}d ${hours}h ${mins}m`
}
