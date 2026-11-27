import { sweepPlaces, type LeftoverRule, type SweepReport } from './places'

/** How long after the daemon is ready the places sweep first runs: never on the start path. */
export const PLACE_SWEEP_DELAY_MS = 60_000
/** How often it runs again while the daemon runs: what a sweep kept (young, still running, a removal that failed) is retried. */
export const PLACE_SWEEP_INTERVAL_MS = 30 * 60_000

/**
 * Schedules the sweep of what ended single requests left (`sweepPlaces`) in the daemon's post-ready maintenance pass:
 * {@link PLACE_SWEEP_DELAY_MS} after ready, whether or not anything was named since, then every
 * {@link PLACE_SWEEP_INTERVAL_MS} until stopped. Returns its cancel.
 */
export function schedulePlaceSweep(profileDir: string, options: { stopped(): boolean; rules?: readonly LeftoverRule[]; delayMs?: number; intervalMs?: number; done?(report: SweepReport): void }): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined
  let cancelled = false
  const next = (ms: number) => {
    if (cancelled || options.stopped()) return
    timer = setTimeout(run, ms)
    timer.unref?.()
  }
  const run = () => {
    if (cancelled || options.stopped()) return
    void sweepPlaces(profileDir, options.rules ?? []).then((report) => {
      if (report.kept.length) console.warn('[one-shot] places kept for the next sweep', { kept: report.kept.length })
      options.done?.(report)
    }, (error: unknown) => console.warn('[one-shot] the places sweep failed', { error: error instanceof Error ? error.message : String(error) }))
      .finally(() => next(options.intervalMs ?? PLACE_SWEEP_INTERVAL_MS))
  }
  next(options.delayMs ?? PLACE_SWEEP_DELAY_MS)
  return () => {
    cancelled = true
    if (timer) clearTimeout(timer)
  }
}
