import { useEffect } from 'react'
import type { ThreadBackgroundWork } from '../../shared/backgroundWork'
import { useAppStore } from '../stores/appStore'

let unsubscribe: (() => void) | null = null
/** How many pictures the daemon pushed per thread, so a read sent before a push never overwrites it. */
const pushes = new Map<string, number>()

/** Takes every picture the daemon pushes (`thread.backgroundWork`), for any thread, once per window. */
function listen(): void {
  if (unsubscribe || !window.mousse?.threads?.onBackgroundWork) return
  unsubscribe = window.mousse.threads.onBackgroundWork((work) => {
    pushes.set(work.threadId, (pushes.get(work.threadId) ?? 0) + 1)
    useAppStore.getState().setBackgroundWork(work)
  })
}

/**
 * What `threadId` runs in the background besides its subagents, or undefined when nothing does. Read once when the
 * thread is shown; after that the daemon pushes each change, so nothing polls.
 */
export function useBackgroundWork(threadId: string | null | undefined): ThreadBackgroundWork | undefined {
  const work = useAppStore((state) => (threadId ? state.backgroundWorkByThread[threadId] : undefined))
  useEffect(() => {
    listen()
    if (!threadId || !window.mousse?.threads?.backgroundWork) return
    let live = true
    const pushed = pushes.get(threadId) ?? 0
    void window.mousse.threads.backgroundWork(threadId).then(
      (latest) => {
        if (live && (pushes.get(threadId) ?? 0) === pushed) useAppStore.getState().setBackgroundWork(latest)
      },
      () => undefined // an older daemon without `threads.backgroundWork` shows no row
    )
    return () => { live = false }
  }, [threadId])
  return work
}
