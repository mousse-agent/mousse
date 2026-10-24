import { useCallback, useEffect, useRef, useState } from 'react'
import type { CliProviderConfig } from '../../../shared/providerAuth'
import { errorText } from './parts'

/** An agent download Mousse runs for a provider (Antigravity), as the rows and the add step show it. */
export interface CliInstall {
  /** A download is running. It survives leaving the page, so state lives above the rows. */
  busy: boolean
  /** The latest progress line while `busy`. */
  progress: string | null
  /** Why the last attempt failed; a cancel is not a failure. */
  error: string | null
  /** Resolves with the new config, or undefined when it failed or was cancelled. Never signs in. */
  start: () => Promise<CliProviderConfig | undefined>
  cancel: () => Promise<void>
}

export function useCliInstall(): CliInstall {
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const cancelled = useRef(false)

  useEffect(
    () =>
      window.mousse.providers.onInstallEvent((event) => {
        if (event.instanceId === 'antigravity' && event.type === 'progress') setProgress(event.message)
      }),
    []
  )

  const start = useCallback(async () => {
    cancelled.current = false
    setBusy(true)
    setError(null)
    setProgress('Starting…')
    try {
      return await window.mousse.providers.installAntigravity()
    } catch (failure) {
      if (!cancelled.current) setError(errorText(failure))
      return undefined
    } finally {
      setBusy(false)
      setProgress(null)
    }
  }, [])

  const cancel = useCallback(async () => {
    cancelled.current = true
    try {
      await window.mousse.providers.cancelAntigravityInstall()
    } catch (failure) {
      cancelled.current = false
      setError(errorText(failure))
    }
  }, [])

  return { busy, progress, error, start, cancel }
}
