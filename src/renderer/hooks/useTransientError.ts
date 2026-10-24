import { useEffect, useState } from 'react'

/** How long an inline action error stays before it clears itself. */
export const TRANSIENT_ERROR_MS = 6000

/** An error message that clears itself after `ms`. Setting a new one restarts the timer. */
export function useTransientError(ms = TRANSIENT_ERROR_MS): [string | null, (message: string | null) => void] {
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!error) return
    const timer = window.setTimeout(() => setError(null), ms)
    return () => window.clearTimeout(timer)
  }, [error, ms])

  return [error, setError]
}
