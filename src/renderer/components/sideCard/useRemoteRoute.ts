import { useCallback, useEffect, useState } from 'react'
import type { RemoteRouteKind } from '../../../shared/remoteEditor'

/**
 * How this computer reaches the computer that runs a thread, for an editor: an SSH address it approved,
 * one of Mousse's own SSH names, or none yet. A failed read counts as none. Only the kind is read here;
 * the address itself is read again by the main process when an editor is opened.
 */
export function useRemoteRoute(threadId: string): { kind: RemoteRouteKind | 'loading'; reload: () => void } {
  const [answer, setAnswer] = useState<{ threadId: string; kind: RemoteRouteKind } | null>(null)
  const [round, setRound] = useState(0)
  useEffect(() => {
    let cancelled = false
    void window.mousse.editors
      .remoteRoute(threadId)
      .then((route): RemoteRouteKind => route.kind)
      .catch((): RemoteRouteKind => 'none')
      .then((kind) => { if (!cancelled) setAnswer({ threadId, kind }) })
    return () => { cancelled = true }
  }, [threadId, round])
  const reload = useCallback(() => setRound((value) => value + 1), [])
  // A connection set up in Devices, or by the CLI, shows up when the window is back in front.
  useEffect(() => {
    window.addEventListener('focus', reload)
    return () => window.removeEventListener('focus', reload)
  }, [reload])
  return { kind: answer && answer.threadId === threadId ? answer.kind : 'loading', reload }
}
