import { useSyncExternalStore } from 'react'

// Mirrors Settings > Appearance > Reply previews so the threads sidebar and the Bots list can read it without loading
// settings. useTheme feeds it from the open profile's settings. It stays off, the default, until they load.
let enabled = false
const listeners = new Set<() => void>()

export function setReplyPreviews(next: boolean): void {
  if (next === enabled) return
  enabled = next
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function snapshot(): boolean {
  return enabled
}

/** Whether thread and bot rows show their latest reply under the title. */
export function useReplyPreviews(): boolean {
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}
