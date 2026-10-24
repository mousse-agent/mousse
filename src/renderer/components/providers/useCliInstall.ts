import { useCallback, useEffect, useRef, useState } from 'react'
import type { CliProviderConfig } from '../../../shared/providerAuth'
import { errorText } from './parts'

/** An agent download Mousse runs for a provider (Antigravity), as the rows and the add step show it. */
export interface CliInstall {
  /** A download is running in the daemon, started here or before this page opened. */
  busy: boolean
  /** The latest progress line while `busy`. */
  progress: string | null
  /** Why the last attempt failed; a cancel is not a failure. */
  error: string | null
  /** Resolves with the new config, or undefined when it failed or was cancelled. Never signs in. */
  start: () => Promise<CliProviderConfig | undefined>
  cancel: () => Promise<void>
}

/**
 * The daemon owns the download, so `config.installing` is the truth: the page can close and reopen,
 * or the request can give up, and the row still shows (and can cancel) the running download.
 * `reload` re-reads the config when an attempt ends here.
 */
export function useCliInstall(config: CliProviderConfig | undefined, reload: () => void): CliInstall {
  const [starting, setStarting] = useState(false)
  const [latest, setLatest] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const cancelled = useRef(false)
  const reloadRef = useRef(reload)
  reloadRef.current = reload
  const busy = starting || config?.installing === true

  useEffect(
    () =>
      window.mousse.providers.onInstallEvent((event) => {
        if (event.instanceId === 'antigravity' && event.type === 'progress') setLatest(event.message)
      }),
    []
  )
  // A finished download leaves no progress line behind for the next one.
  useEffect(() => {
    if (!busy) setLatest(null)
  }, [busy])

  const start = useCallback(async () => {
    cancelled.current = false
    setStarting(true)
    setError(null)
    setLatest(null)
    try {
      return await window.mousse.providers.installAntigravity()
    } catch (failure) {
      if (!cancelled.current) setError(errorText(failure))
      return undefined
    } finally {
      setStarting(false)
      reloadRef.current()
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

  const progress = busy ? (latest ?? config?.installProgress ?? (starting ? 'Starting…' : 'Installing…')) : null
  return { busy, progress, error, start, cancel }
}
