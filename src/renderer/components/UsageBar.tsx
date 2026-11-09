import type { CSSProperties } from 'react'
import { usageRedMix } from '../lib/subscriptionUsage'

/**
 * A limit bar filled to the share left: striped, with the theme's specular, taking on a little red as
 * it nears empty. `size` sets its height (the page's rows 8px, the summary 7px, table cells 5px).
 * An unknown share leaves it empty.
 */
export function UsageBar({ remaining, label, size = 'row' }: { remaining: number | undefined; label: string; size?: 'row' | 'summary' | 'cell' }) {
  const red = remaining === undefined ? 0 : usageRedMix(remaining)
  return <div
    className={`usage-bar${size === 'row' ? '' : ` is-${size}`}`}
    role="meter"
    aria-label={`${label} left`}
    aria-valuemin={0}
    aria-valuemax={100}
    {...(remaining === undefined ? {} : { 'aria-valuenow': remaining })}
  >
    {remaining !== undefined && remaining > 0 && <span
      className="usage-bar-fill"
      data-red={red}
      style={{ width: `${remaining}%`, ...(red ? { '--usage-red': `${red}%` } : {}) } as CSSProperties}
    />}
  </div>
}
