/**
 * Reloading the window by hand, for when part of the app failed to load and Retry cannot repair it (a chunk it
 * imports failed, and Chromium keeps that failure until the page reloads). Never automatic: the person chooses it.
 */

const AUTOSAVE_FLUSH_DEADLINE_MS = 5_000

const flushers = new Set<() => Promise<unknown>>()

/** An editor that autosaves registers how to save now, so a reload does not drop edits still waiting to be saved. */
export function registerAutosaveFlush(flush: () => Promise<unknown>): () => void {
  flushers.add(flush)
  return () => { flushers.delete(flush) }
}

/**
 * Whether any open editor still has unsaved edits: asks the same `beforeunload` handlers that would stop the window
 * from unloading, without unloading it.
 */
export function hasUnsavedEdits(): boolean {
  const probe = new Event('beforeunload', { cancelable: true })
  probes.add(probe)
  window.dispatchEvent(probe)
  return probe.defaultPrevented
}
const probes = new WeakSet<Event>()

/** How long a confirmed reload's unload may skip the editors' checks; past it the window did not reload. */
const UNLOAD_BYPASS_MS = 5_000

const settleWithin = (work: Promise<unknown>, ms: number) =>
  Promise.race([work.catch(() => undefined), new Promise((done) => setTimeout(done, ms))])

/**
 * Saves what autosave is holding, asks before discarding any edits that are still unsaved, then reloads. Resolves
 * false when the person keeps the window as it is.
 */
export async function reloadWindow(reload: () => void = () => window.location.reload()): Promise<boolean> {
  // A save that hangs does not keep the window from reloading; the question below still covers its edits.
  await settleWithin(Promise.allSettled([...flushers].map((flush) => Promise.resolve().then(flush))), AUTOSAVE_FLUSH_DEADLINE_MS)
  if (hasUnsavedEdits() && !window.confirm("Some edits aren't saved. Reload anyway and lose them?")) return false
  // The person has decided: the editors' own unload checks would otherwise cancel the reload without a word. Only
  // this reload's unload skips them; a check for unsaved edits, or a later unload, still asks the editors.
  const bypass = (event: Event) => {
    if (probes.has(event)) return
    event.stopImmediatePropagation()
    stop()
  }
  const timer = setTimeout(() => stop(), UNLOAD_BYPASS_MS)
  const stop = () => {
    clearTimeout(timer)
    window.removeEventListener('beforeunload', bypass, { capture: true })
  }
  window.addEventListener('beforeunload', bypass, { capture: true })
  reload()
  return true
}
