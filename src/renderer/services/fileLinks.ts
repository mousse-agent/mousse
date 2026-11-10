/**
 * File links (`mousse:open-file`) are opened by the Files tab, which loads as its own chunk and mounts after the
 * first paint. This is the one listener for them. While no Files tab has registered its opener (not mounted yet,
 * or its chunk failed to load), links are held in order; once it registers, the held ones are opened one at a
 * time, each to completion before the next, because an open that starts later replaces one still in progress.
 */

export type FileLinkOpener = (detail: unknown) => Promise<void>

const queued: unknown[] = []
let opener: FileLinkOpener | null = null
let draining = false
const heldListeners = new Set<() => void>()

async function drain(): Promise<void> {
  if (draining) return
  draining = true
  try {
    while (opener && queued.length > 0) {
      const detail = queued.shift()
      await opener(detail).catch((error: unknown) => console.error('Failed to open file link', error))
    }
  } finally {
    draining = false
  }
}

/** A link from anywhere in the window: opened at once by the Files tab, or held until it can be. */
export function receiveFileLink(detail: unknown): void {
  // A link that arrives while held ones are still opening waits its turn, so the opens stay in order.
  if (opener && !draining && queued.length === 0) {
    void opener(detail).catch((error: unknown) => console.error('Failed to open file link', error))
    return
  }
  queued.push(detail)
  if (opener) void drain()
  else for (const listener of heldListeners) listener()
}

/**
 * Called when a link is held because no Files tab can open it yet (the panel area mounts the tab), and at once if
 * links were held before it subscribed.
 */
export function onFileLinkHeld(listener: () => void): () => void {
  heldListeners.add(listener)
  if (!opener && queued.length > 0) listener()
  return () => { heldListeners.delete(listener) }
}

/**
 * The Files tab registers how it opens a link, resolving when the open has finished or given way. Held links are
 * opened now; the returned function is called when the tab stops opening links.
 */
export function registerFileLinkOpener(open: FileLinkOpener): () => void {
  opener = open
  void drain()
  return () => {
    if (opener === open) opener = null
  }
}

if (typeof window !== 'undefined') {
  const listen = (event: Event) => receiveFileLink((event as CustomEvent).detail)
  window.addEventListener('mousse:open-file', listen)
  // A development hot reload replaces this module; the old listener goes with it.
  import.meta.hot?.dispose(() => window.removeEventListener('mousse:open-file', listen))
}
