import { resetsLabel, resetsTooltip } from '../lib/subscriptionUsage'
import type { UsageResets } from '../../shared/providerAuth'

/**
 * How many limit resets an account has available, as a small muted chip: "2 resets". Nothing at none.
 * The tooltip lists each credit as the provider names it, with its expiry as a countdown.
 */
export function UsageResetsChip({ resets, now }: { resets: UsageResets | undefined; now: number }) {
  const label = resetsLabel(resets)
  if (!label) return null
  return <span className="usage-resets-chip" data-testid="usage-resets" title={resetsTooltip(resets!, now)}>{label}</span>
}
