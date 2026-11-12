import { useSyncExternalStore } from 'react'

// Mirrors Settings > Appearance > Thread path in title bar so the title bar and the subagent breadcrumb can read
// it without loading settings. useTheme feeds it from the open profile's settings. It stays on, the default,
// until they load.
let enabled = true
const listeners = new Set<() => void>()

export function setThreadPathInTitleBar(next: boolean): void {
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

/** Whether the title bar shows back, forward and the open thread's path. */
export function useThreadPathInTitleBar(): boolean {
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}
