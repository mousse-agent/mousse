import { sweepPlaces, type LeftoverRule, type SweepReport } from './places'

/** How long after the daemon is ready the places sweep runs: never on the start path. */
export const PLACE_SWEEP_DELAY_MS = 60_000

/**
 * Schedules the sweep of what ended single requests left (`sweepPlaces`) in the daemon's post-ready maintenance pass,
 * {@link PLACE_SWEEP_DELAY_MS} after ready, whether or not anything was named since. Returns its cancel.
 */
export function schedulePlaceSweep(profileDir: string, options: { stopped(): boolean; rules?: readonly LeftoverRule[]; delayMs?: number; done?(report: SweepReport): void }): () => void {
  const timer = setTimeout(() => {
    if (options.stopped()) return
    void sweepPlaces(profileDir, options.rules ?? []).then((report) => {
      if (report.kept.length) console.warn('[one-shot] places kept for the next sweep', { kept: report.kept.length })
      options.done?.(report)
    }, (error: unknown) => console.warn('[one-shot] the places sweep failed', { error: error instanceof Error ? error.message : String(error) }))
  }, options.delayMs ?? PLACE_SWEEP_DELAY_MS)
  timer.unref?.()
  return () => clearTimeout(timer)
}
