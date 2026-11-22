import { STORE_TXN_MAX_BYTES, STORE_TXN_MAX_ROWS } from '../../shared/net/limits'

/**
 * Limits of the copies this computer keeps of the display streams of the user's other computers (their threads
 * and lists), and of how often a computer publishes its lists. Each is a named default here, overridable by one
 * environment variable, read once, the first time a limit is needed. A value that is not a whole number keeps its
 * default; one outside its range is held to the range. Either is reported.
 */
export interface CopyLimits {
  /**
   * Records one step drops from a copy, in one transaction. Held below the transaction's row bound, which the
   * step's tombstones and blob references share.
   */
  dropBatchRows: number
  /**
   * Bytes of records one step drops (at least one record). Freeing a record costs in proportion to its size, so
   * this, more than the row count, is what keeps a step short. Held to a transaction's byte bound.
   */
  dropBatchBytes: number
  /** Pause between two steps, so other work on the database and the event loop runs in between. */
  dropPauseMs: number
  /** How long after the Bridge starts the copies on disk are tidied, so a start is never slowed by it. */
  sweepDelayMs: number
  /**
   * Records whose author signature this computer remembers having checked, so a stream read again (a second
   * window, a reconnect, a new snapshot) is not checked again. Forgotten whenever the roster changes. 0 keeps none.
   */
  verifiedRecords: number
  /**
   * A change to the lists that only moves threads' last-update times (a running turn saves every second or so) is
   * published at most this often; any other change is published at once, with the times.
   */
  listsTimesIntervalMs: number
}

export const COPY_LIMIT_DEFAULTS: Readonly<CopyLimits> = Object.freeze({
  dropBatchRows: 200,
  dropBatchBytes: 256 * 1024,
  dropPauseMs: 5,
  sweepDelayMs: 30_000,
  verifiedRecords: 4096,
  listsTimesIntervalMs: 15_000
})

const RANGES: Readonly<Record<keyof CopyLimits, readonly [number, number]>> = Object.freeze({
  dropBatchRows: [1, STORE_TXN_MAX_ROWS - 100],
  dropBatchBytes: [1024, STORE_TXN_MAX_BYTES],
  dropPauseMs: [0, 10_000],
  sweepDelayMs: [0, 60 * 60_000],
  verifiedRecords: [0, 65_536],
  listsTimesIntervalMs: [1_000, 10 * 60_000]
})

export const COPY_LIMIT_VARIABLES: Readonly<Record<keyof CopyLimits, string>> = Object.freeze({
  dropBatchRows: 'MOUSSE_NET_COPY_DROP_BATCH_ROWS',
  dropBatchBytes: 'MOUSSE_NET_COPY_DROP_BATCH_BYTES',
  dropPauseMs: 'MOUSSE_NET_COPY_DROP_PAUSE_MS',
  sweepDelayMs: 'MOUSSE_NET_COPY_SWEEP_DELAY_MS',
  verifiedRecords: 'MOUSSE_NET_VERIFIED_RECORDS',
  listsTimesIntervalMs: 'MOUSSE_NET_LISTS_TIMES_INTERVAL_MS'
})

/** Reads the limits from `env`; each problem names the variable, the value and what was used. */
export function readCopyLimits(env: NodeJS.ProcessEnv): { limits: CopyLimits; problems: string[] } {
  const limits: CopyLimits = { ...COPY_LIMIT_DEFAULTS }
  const problems: string[] = []
  for (const key of Object.keys(COPY_LIMIT_VARIABLES) as (keyof CopyLimits)[]) {
    const name = COPY_LIMIT_VARIABLES[key],
      raw = env[name]
    if (raw === undefined || raw.trim() === '') continue
    const value = Number(raw.trim()),
      [low, high] = RANGES[key]
    if (!Number.isSafeInteger(value)) {
      problems.push(`${name}=${JSON.stringify(raw)} is not a whole number; using ${limits[key]}`)
      continue
    }
    limits[key] = Math.min(high, Math.max(low, value))
    if (limits[key] !== value)
      problems.push(`${name}=${value} is outside ${low}..${high}; using ${limits[key]}`)
  }
  return { limits, problems }
}

let loaded: { limits: CopyLimits; problems: string[] } | undefined

/** The process's limits, read from the environment the first time. */
export function copyLimits(): CopyLimits {
  if (!loaded) {
    loaded = readCopyLimits(process.env)
    for (const problem of loaded.problems) console.warn(`[net] ${problem}`)
  }
  return loaded.limits
}
