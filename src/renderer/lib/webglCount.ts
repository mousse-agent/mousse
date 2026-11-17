/**
 * Live WebGL contexts in this window, for the memory monitor: each one holds GPU memory. The count sits on the
 * document element (`data-mousse-webgl-contexts`), where the preload reads it once a minute.
 */
let live = 0

function publish(doc: Document | undefined): void {
  const root = doc?.documentElement
  if (root) root.dataset.mousseWebglContexts = String(live)
}

/** Counts a context until the returned function is called (once). */
export function noteWebGlContext(doc: Document | undefined = typeof document === 'undefined' ? undefined : document): () => void {
  live += 1
  publish(doc)
  let open = true
  return () => {
    if (!open) return
    open = false
    live -= 1
    publish(doc)
  }
}

export function liveWebGlContexts(): number {
  return live
}
