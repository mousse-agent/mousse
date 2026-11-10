/**
 * Reloading the window by hand, for when part of the app failed to load and Retry cannot repair it (a chunk it
 * imports failed, and Chromium keeps that failure until the page reloads). Never automatic: the person chooses it.
 * It never discards edits and never silences the editors' own unload checks.
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
  window.dispatchEvent(probe)
  return probe.defaultPrevented
}

const settleWithin = (work: Promise<unknown>, ms: number) => {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([work.catch(() => undefined), new Promise((done) => { timer = setTimeout(done, ms) })])
    .finally(() => clearTimeout(timer))
}

export type ReloadOutcome = 'reloaded' | 'unsaved'

/**
 * Saves what autosave is holding (waiting at most a few seconds), then reloads if nothing is left unsaved. With
 * unsaved edits left it does nothing and says so; the person saves or closes those files first.
 */
export async function reloadWindow(reload: () => void = () => window.location.reload()): Promise<ReloadOutcome> {
  await settleWithin(Promise.allSettled([...flushers].map((flush) => Promise.resolve().then(flush))), AUTOSAVE_FLUSH_DEADLINE_MS)
  if (hasUnsavedEdits()) return 'unsaved'
  reload()
  return 'reloaded'
}
