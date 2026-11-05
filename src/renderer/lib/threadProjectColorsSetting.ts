import { useSyncExternalStore } from 'react'

// Mirrors Settings > Appearance > Project colors on threads so the sidebar can read it without loading settings.
// useTheme feeds it from the open profile's settings. It stays on, the default, until they load.
let enabled = true
const listeners = new Set<() => void>()

export function setThreadProjectColors(next: boolean): void {
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

/** Whether Threads tab cards carry their project's tint. */
export function useThreadProjectColors(): boolean {
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}
