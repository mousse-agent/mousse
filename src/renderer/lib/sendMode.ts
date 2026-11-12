import { useCallback, useSyncExternalStore } from 'react'
import { useAppStore } from '../stores/appStore'
import { profilePreferenceKey } from './profilePreferences'
import type { SendMode } from './steerKey'

/**
 * Each thread's send mode (`SendMode`): the threads the person set to Steer, newest last, as a personal preference
 * of the profile on this computer. It changes only what Enter does in this composer, never the run or the agent, so
 * it is not one of the thread's run settings. A thread that is not listed queues, so a new thread starts in Queue.
 */
const PREFERENCE_NAME = 'steerThreads.v1'
/** More threads than anyone keeps in Steer; past it the oldest choice is dropped. */
const MAX_STEER_THREADS = 500

let cached: { key: string; ids: readonly string[] } | null = null
const listeners = new Set<() => void>()

function steerThreads(key: string): readonly string[] {
  if (cached?.key === key) return cached.ids
  let ids: string[] = []
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(key) ?? '[]')
    if (Array.isArray(parsed)) ids = parsed.filter((id): id is string => typeof id === 'string')
  } catch { /* Unreadable or unavailable storage: every thread queues. */ }
  cached = { key, ids }
  return ids
}

/** The thread's send mode; `queue` until the person switches it. */
export function threadSendMode(profileId: string, threadId: string): SendMode {
  if (!profileId || !threadId) return 'queue'
  return steerThreads(profilePreferenceKey(profileId, PREFERENCE_NAME)).includes(threadId) ? 'steer' : 'queue'
}

/** Keeps the thread's send mode across restarts. */
export function setThreadSendMode(profileId: string, threadId: string, mode: SendMode): void {
  if (!profileId || !threadId) return
  const key = profilePreferenceKey(profileId, PREFERENCE_NAME)
  const others = steerThreads(key).filter((id) => id !== threadId)
  const ids = mode === 'steer' ? [...others, threadId].slice(-MAX_STEER_THREADS) : others
  cached = { key, ids }
  try {
    if (ids.length) localStorage.setItem(key, JSON.stringify(ids))
    else localStorage.removeItem(key)
  } catch { /* Storage can be unavailable; the mode still holds until the app quits. */ }
  for (const listener of listeners) listener()
}

/** Forgets what was read: a test's fresh start, or storage changed by another window. */
export function forgetSendModes(): void {
  cached = null
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  // Another window of the app changed it.
  const onStorage = (event: StorageEvent) => {
    if (event.key !== null && !event.key.endsWith(`-${PREFERENCE_NAME}`)) return
    forgetSendModes()
    listener()
  }
  window.addEventListener('storage', onStorage)
  return () => {
    listeners.delete(listener)
    window.removeEventListener('storage', onStorage)
  }
}

/** The thread's send mode and how to change it; without a thread it is always `queue`. */
export function useThreadSendMode(threadId: string | undefined): [SendMode, (mode: SendMode) => void] {
  const profileId = useAppStore((state) => state.profileId)
  const mode = useSyncExternalStore(subscribe, () => (threadId ? threadSendMode(profileId, threadId) : 'queue'))
  const setMode = useCallback((next: SendMode) => {
    if (threadId) setThreadSendMode(profileId, threadId, next)
  }, [profileId, threadId])
  return [mode, setMode]
}
