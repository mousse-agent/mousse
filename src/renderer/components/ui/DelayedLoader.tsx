import { useEffect, useState } from 'react'
import '../../styles/loader.css'

/** How long data may take before a loader appears, so quick loads never flash one. */
export const LOADER_DELAY_MS = 160

/**
 * The app's one loading indicator: a lit bead with an arc orbiting it, and no text. It appears only
 * after `delayMs`; until then the slot is empty. `label` is read by screen readers once it shows.
 */
export function DelayedLoader({ label, size = 'large', delayMs = LOADER_DELAY_MS, className, 'data-testid': testId }: {
  label: string
  /** `large` for a page or panel, `small` (16px) inline in a row or a group. */
  size?: 'large' | 'small'
  delayMs?: number
  className?: string
  'data-testid'?: string
}) {
  const [shown, setShown] = useState(delayMs <= 0)
  useEffect(() => {
    if (delayMs <= 0) return
    const timer = window.setTimeout(() => setShown(true), delayMs)
    return () => window.clearTimeout(timer)
  }, [delayMs])
  return <span className={`ui-loader-slot${className ? ` ${className}` : ''}`} data-testid={testId}>
    {shown && <span className={`ui-loader ${size}`} role="status" aria-label={label}>
      <span className="ui-loader-ring icon-spin" />
      <span className="ui-loader-core" />
    </span>}
  </span>
}
