/**
 * File links (`mousse:open-file`) are handled by the Files tab, which loads as its own chunk and mounts after the
 * first paint. Until it is listening, links are held here, in order, and handed to it the moment it starts.
 */

const queued: unknown[] = []
let listening = 0

/** True while a mounted Files tab handles file links itself. */
export function fileLinksHandled(): boolean {
  return listening > 0
}

/** Holds a link that arrived while no Files tab was listening. */
export function holdFileLink(detail: unknown): void {
  queued.push(detail)
}

/**
 * Called by the Files tab right after its link listener is registered: from now on links reach it directly, and
 * the held ones are sent again, once each. The returned function is called when it stops listening.
 */
export function fileLinksListening(): () => void {
  listening += 1
  for (const detail of queued.splice(0)) window.dispatchEvent(new CustomEvent('mousse:open-file', { detail }))
  let stopped = false
  return () => {
    if (stopped) return
    stopped = true
    listening -= 1
  }
}
