import { usageLevel } from '../lib/subscriptionUsage'

/**
 * A limit bar filled to the share left, in its level's colour (plenty, getting low, low, critical) over a
 * track tinted with the same colour, so the bar's full length and how much is gone read at any fill.
 * `size` sets its height (the page's rows 8px, the summary 7px, table cells 5px). An unknown share
 * leaves it empty, on a neutral track.
 */
export function UsageBar({ remaining, label, size = 'row' }: { remaining: number | undefined; label: string; size?: 'row' | 'summary' | 'cell' }) {
  return <div
    className={`usage-bar${size === 'row' ? '' : ` is-${size}`}`}
    role="meter"
    aria-label={`${label} left`}
    aria-valuemin={0}
    aria-valuemax={100}
    {...(remaining === undefined ? {} : { 'aria-valuenow': remaining, 'data-usage-level': usageLevel(remaining) })}
  >
    {remaining !== undefined && remaining > 0 && <span className="usage-bar-fill" style={{ width: `${remaining}%` }} />}
  </div>
}
