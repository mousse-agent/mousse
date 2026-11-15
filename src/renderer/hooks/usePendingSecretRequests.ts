import { useCallback, useEffect, useState } from 'react'
import type { SecretRequestView } from '../../shared/secretRequests'
import type { SecretsClient } from '../services/secretsClient'

/**
 * The open secret cards of the thread on screen (#595). They are read from the daemon when the thread changes and
 * whenever it says that thread's cards changed; a thread another computer runs has none here.
 */
export function usePendingSecretRequests(threadId: string | null | undefined, client: SecretsClient): { requests: SecretRequestView[]; refresh(): void } {
  const [requests, setRequests] = useState<SecretRequestView[]>([])
  const [generation, setGeneration] = useState(0)
  const refresh = useCallback(() => setGeneration((value) => value + 1), [])

  useEffect(() => {
    if (!threadId) {
      setRequests([])
      return
    }
    let live = true
    client.requests(threadId).then(
      (next) => { if (live) setRequests(next) },
      () => { if (live) setRequests([]) }
    )
    return () => { live = false }
  }, [client, threadId, generation])

  useEffect(() => {
    const off = window.mousse?.orchestrator?.onSecretRequestsChanged?.((payload) => {
      if (payload.threadId === threadId) refresh()
    })
    return () => off?.()
  }, [threadId, refresh])

  return { requests, refresh }
}
