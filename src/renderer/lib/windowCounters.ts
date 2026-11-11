/**
 * The window's own counters for the profiler's window breakdown: mounted turns and rows, and the size of each cache
 * that registers here. Read only when the profiler asks for this window's detail (`diagnostics.provideCounters`),
 * never per frame. A cache registers where it lives, so nothing here loads its module.
 */
import { useEffect } from 'react'

export interface WindowCacheSize {
  entries: number
  limit?: number
}

const caches = new Map<string, () => WindowCacheSize>()

/** Registers a cache by a fixed name (`codeHighlight`); its size is read when the profiler asks. */
export function registerWindowCache(name: string, read: () => WindowCacheSize): void {
  caches.set(name, read)
}

/** Assistant turns and message rows mounted now, and every registered cache's size. */
export function readWindowCounters(root: ParentNode = document): { mountedTurns: number; mountedRows: number; caches: Record<string, WindowCacheSize> } {
  const sizes: Record<string, WindowCacheSize> = {}
  for (const [name, read] of caches) {
    try {
      const size = read()
      sizes[name] = { entries: size.entries, ...(size.limit !== undefined ? { limit: size.limit } : {}) }
    } catch {
      // A cache that cannot say is left out.
    }
  }
  return {
    mountedTurns: root.querySelectorAll('[class~="group/assistant-turn"]').length,
    mountedRows: root.querySelectorAll('[data-message-id]').length,
    caches: sizes
  }
}

/** Gives the window's counters to the preload, which reads them only when the profiler asks. */
export function useWindowCounters(): void {
  useEffect(() => window.mousse?.diagnostics?.provideCounters?.(() => readWindowCounters()), [])
}
