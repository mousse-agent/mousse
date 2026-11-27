import { useSyncExternalStore } from 'react'
import type { ThreadProjectColorStyle } from '../../shared/settings'

// Mirrors Settings > Appearance > Project colors on threads so the sidebar can read it without loading settings.
// useTheme feeds it from the open profile's settings. It keeps the default (off) until they load.
let style: ThreadProjectColorStyle = 'off'
const listeners = new Set<() => void>()

export function setThreadProjectColors(next: ThreadProjectColorStyle): void {
  if (next === style) return
  style = next
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function snapshot(): ThreadProjectColorStyle {
  return style
}

/** How Threads tab cards carry their project's color. */
export function useThreadProjectColors(): ThreadProjectColorStyle {
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}
