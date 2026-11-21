/**
 * Where the daemon's start spends its time: each step before ready is timed (`performance.now()`) and the list is
 * logged once at ready, as `[info:startup] ready in 812 ms {"create.lease":3,…}`. Work started after ready, in the
 * background, is logged the same way when it ends (`startupBackgroundTimed`). Measurements only: nothing reads them back.
 *
 * Only a recording begun with `startupTimingBegin` collects steps; without one (tests, the window's own profile work)
 * a timed step costs one check.
 */

export interface StartupTimingRecord {
  readonly startedAt: number
  readonly phases: Array<[string, number]>
}

let current: StartupTimingRecord | null = null

/** Starts a recording for this start; the steps timed from now on are kept in it. */
export function startupTimingBegin(): StartupTimingRecord {
  current = { startedAt: performance.now(), phases: [] }
  return current
}

/** Ends the recording and returns it; steps timed after this are not kept. */
export function startupTimingEnd(): StartupTimingRecord | null {
  const record = current
  current = null
  return record
}

function keep(name: string, startedAt: number): void {
  if (!current) return
  // A second profile's start times the same steps: each keeps its own entry.
  let key = name
  for (let n = 2; current.phases.some(([seen]) => seen === key); n++) key = `${name}#${n}`
  current.phases.push([key, Math.round(performance.now() - startedAt)])
}

/** Times a step of the start. A step that throws is still timed. */
export function startupPhase<T>(name: string, step: () => T): T {
  if (!current) return step()
  const startedAt = performance.now()
  let result: T
  try {
    result = step()
  } catch (error) {
    keep(name, startedAt)
    throw error
  }
  if (result instanceof Promise) return result.finally(() => keep(name, startedAt)) as T
  keep(name, startedAt)
  return result
}

/** The line logged at ready: the whole start, then each step in the order it ended. */
export function formatStartupTiming(record: StartupTimingRecord, totalMs: number): string {
  return `ready in ${Math.round(totalMs)} ms ${JSON.stringify(Object.fromEntries(record.phases))}`
}

/** How long background startup work runs before it lets requests in. */
const SLICE_MS = 15

/**
 * `step` for each item, giving the event loop back every {@link SLICE_MS}, so requests are answered while a pass over
 * every thread runs in the background. Stops early once `shouldStop` says so (the service is stopping).
 */
export async function forEachYielding<T>(items: Iterable<T>, step: (item: T) => void, shouldStop: () => boolean = () => false): Promise<void> {
  let sliceStart = performance.now()
  for (const item of items) {
    if (shouldStop()) return
    step(item)
    if (performance.now() - sliceStart >= SLICE_MS) {
      await new Promise<void>((resolve) => setImmediate(resolve))
      sliceStart = performance.now()
    }
  }
}

/** Runs work after ready, in the background, and logs how long it took when it ends. Errors are left to `work`. */
export function startupBackgroundTimed(name: string, work: () => Promise<unknown>, log: (line: string) => void): Promise<void> {
  const startedAt = performance.now()
  return work().then(
    () => log(`after ready: ${name} took ${Math.round(performance.now() - startedAt)} ms`),
    () => log(`after ready: ${name} failed after ${Math.round(performance.now() - startedAt)} ms`)
  )
}
