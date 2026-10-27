import { useCallback, useEffect, useRef, useState } from 'react'
import type { PlatformRequestMethod } from '../../../shared/platform'

export const errorText = (cause: unknown) => String((cause as Error)?.message ?? cause)

/**
 * One daemon call at a time for a dialog: `busy` while it runs, its rejection as `error`, and
 * nothing set after the dialog unmounts. `call` resolves `{ value }`, or undefined when the call
 * failed or the dialog is gone, so callers stop there.
 */
export function useDaemonCall() {
  const alive = useRef(true)
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const call = useCallback(async <T>(method: PlatformRequestMethod, params: unknown): Promise<{ value: T } | undefined> => {
    setBusy(true); setError('')
    try {
      const result = await window.mousse.platformRequest.request<T>(method, params)
      return alive.current ? { value: result } : undefined
    } catch (cause) {
      if (alive.current) setError(errorText(cause))
      return undefined
    } finally {
      if (alive.current) setBusy(false)
    }
  }, [])
  return { busy, error, setError, call, alive }
}
