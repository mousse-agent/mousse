import { useCallback, useSyncExternalStore } from 'react'
import { useAppStore } from '../stores/appStore'
import { profilePreferenceKey } from './profilePreferences'
import type { SendMode } from './steerKey'

/**
 * The send mode (`SendMode`) last chosen in any thread's composer, as a personal preference of the profile on this
 * computer. Every thread follows it, so switching threads or restarting keeps the choice. It changes only what Enter
 * does in the composer, never the run or the agent, so it is not one of a thread's run settings. Until the person
 * picks Steer, every thread queues.
 */
const PREFERENCE_NAME = 'sendMode.v1'

let cached: { key: string; mode: SendMode } | null = null
const listeners = new Set<() => void>()

function storedMode(key: string): SendMode {
  if (cached?.key === key) return cached.mode
  let mode: SendMode = 'queue'
  try {
    if (localStorage.getItem(key) === 'steer') mode = 'steer'
  } catch { /* Unavailable storage: every thread queues. */ }
  cached = { key, mode }
  return mode
}

/** The profile's send mode; `queue` until the person switches it. */
export function profileSendMode(profileId: string): SendMode {
  if (!profileId) return 'queue'
  return storedMode(profilePreferenceKey(profileId, PREFERENCE_NAME))
}

/** Keeps the send mode for every thread of the profile, across restarts. */
export function setProfileSendMode(profileId: string, mode: SendMode): void {
  if (!profileId) return
  const key = profilePreferenceKey(profileId, PREFERENCE_NAME)
  cached = { key, mode }
  try {
    if (mode === 'steer') localStorage.setItem(key, mode)
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

/** The profile's send mode and how to change it; without a thread it is always `queue`. */
export function useThreadSendMode(threadId: string | undefined): [SendMode, (mode: SendMode) => void] {
  const profileId = useAppStore((state) => state.profileId)
  const mode = useSyncExternalStore(subscribe, () => (threadId ? profileSendMode(profileId) : 'queue'))
  const setMode = useCallback((next: SendMode) => {
    if (threadId) setProfileSendMode(profileId, next)
  }, [profileId, threadId])
  return [mode, setMode]
}
