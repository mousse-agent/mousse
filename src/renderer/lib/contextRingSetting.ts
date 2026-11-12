import { useSyncExternalStore } from 'react'

// Mirrors Settings > Appearance > Composer > Context ring in composer, so the composer can read it without loading
// settings. useTheme feeds it from the open profile's settings. It stays off, the default, until they load.
let enabled = false
const listeners = new Set<() => void>()

export function setContextRingInComposer(next: boolean): void {
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

/** Whether the composer shows the context ring. The Full/Compact chip shows either way. */
export function useContextRingInComposer(): boolean {
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}
