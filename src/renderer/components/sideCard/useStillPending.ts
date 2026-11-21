import { useEffect, useState } from 'react'

/**
 * How long the Git section looks up a thread's folder and reads its first status, together, before it stops saying
 * "Checking…" and offers Retry: under the 3 s after which a drive that does not answer counts as stalled.
 */
export const GIT_LOOKUP_BUDGET_MS = 2_500

/**
 * Whether `pending` has stayed true for `ms` since it last became true or `scope` last changed. It turns false again
 * as soon as `pending` does, so an answer that comes late still replaces whatever the caller showed meanwhile.
 */
export function useStillPending(pending: boolean, scope: string, ms: number): boolean {
  const [slow, setSlow] = useState<{ scope: string } | null>(null)
  useEffect(() => {
    if (!pending) return
    const timer = setTimeout(() => setSlow({ scope }), ms)
    return () => {
      clearTimeout(timer)
      setSlow(null)
    }
  }, [pending, scope, ms])
  return pending && slow?.scope === scope
}
