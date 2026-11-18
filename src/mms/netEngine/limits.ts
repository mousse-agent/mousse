import {
  BLOB_CHUNK_BYTES,
  DEFAULT_MAX_BLOB_BYTES,
  MAX_FRAME_BYTES
} from '../../shared/net/limits'

/**
 * Every limit of the network engine: a named default here, each overridable by one environment variable. The
 * variables are read once, the first time a limit is needed (the engine's start reads them); a value that is not
 * a positive whole number, or that breaks a rule below, keeps its default and is reported.
 */
export interface EngineLimits {
  /** Largest message on an engine stream, header and parts together. Both computers must agree. */
  maxMessageBytes: number
  /** Room a record batch leaves in its message for the header. */
  headerReserveBytes: number
  /** Most records in one snapshot message. */
  recordsPerMessage: number
  /** Size of each `bytes` message of a blob fetched or stored. */
  blobChunkBytes: number
  /** Largest blob fetched or stored. */
  maxBlobBytes: number
  /** Longest deadline a caller may give a call. */
  maxCallDeadlineMs: number
  /** How long a pairing's client waits for `mousse.hello` to be answered. */
  helloDeadlineMs: number
  /** How long a cancel waits. */
  cancelDeadlineMs: number
  /** How long a blob fetch or store waits. */
  blobDeadlineMs: number
  /** How long an append waits. */
  appendDeadlineMs: number
  /** The least time a result lookup is given, however little of the call's own deadline is left. */
  resultWaitFloorMs: number
  /** How often this profile's own delegation is checked for renewal while the engine is on. */
  renewIntervalMs: number
  /** The own delegation is renewed once it is due within this long. */
  renewDueWithinMs: number
}

export const ENGINE_LIMIT_DEFAULTS: Readonly<EngineLimits> = Object.freeze({
  maxMessageBytes: MAX_FRAME_BYTES,
  headerReserveBytes: 4 * 1024,
  recordsPerMessage: 499,
  blobChunkBytes: BLOB_CHUNK_BYTES,
  maxBlobBytes: DEFAULT_MAX_BLOB_BYTES,
  maxCallDeadlineMs: 24 * 60 * 60_000,
  helloDeadlineMs: 15_000,
  cancelDeadlineMs: 15_000,
  blobDeadlineMs: 120_000,
  appendDeadlineMs: 60_000,
  resultWaitFloorMs: 15_000,
  renewIntervalMs: 60 * 60_000,
  renewDueWithinMs: 24 * 60 * 60_000
})

export const ENGINE_LIMIT_VARIABLES: Readonly<Record<keyof EngineLimits, string>> = Object.freeze({
  maxMessageBytes: 'MOUSSE_NET_ENGINE_MAX_MESSAGE_BYTES',
  headerReserveBytes: 'MOUSSE_NET_ENGINE_HEADER_RESERVE_BYTES',
  recordsPerMessage: 'MOUSSE_NET_ENGINE_RECORDS_PER_MESSAGE',
  blobChunkBytes: 'MOUSSE_NET_ENGINE_BLOB_CHUNK_BYTES',
  maxBlobBytes: 'MOUSSE_NET_ENGINE_MAX_BLOB_BYTES',
  maxCallDeadlineMs: 'MOUSSE_NET_ENGINE_MAX_CALL_DEADLINE_MS',
  helloDeadlineMs: 'MOUSSE_NET_ENGINE_HELLO_DEADLINE_MS',
  cancelDeadlineMs: 'MOUSSE_NET_ENGINE_CANCEL_DEADLINE_MS',
  blobDeadlineMs: 'MOUSSE_NET_ENGINE_BLOB_DEADLINE_MS',
  appendDeadlineMs: 'MOUSSE_NET_ENGINE_APPEND_DEADLINE_MS',
  resultWaitFloorMs: 'MOUSSE_NET_ENGINE_RESULT_WAIT_FLOOR_MS',
  renewIntervalMs: 'MOUSSE_NET_ENGINE_RENEW_INTERVAL_MS',
  renewDueWithinMs: 'MOUSSE_NET_ENGINE_RENEW_DUE_WITHIN_MS'
})

/** Reads the limits from `env`; each problem names the variable, the value and the default kept. */
export function readEngineLimits(env: NodeJS.ProcessEnv): {
  limits: EngineLimits
  problems: string[]
} {
  const limits: EngineLimits = { ...ENGINE_LIMIT_DEFAULTS }
  const problems: string[] = []
  const keep = (key: keyof EngineLimits, why: string): void => {
    problems.push(
      `${ENGINE_LIMIT_VARIABLES[key]}=${JSON.stringify(env[ENGINE_LIMIT_VARIABLES[key]])} ${why}; using ${ENGINE_LIMIT_DEFAULTS[key]}`
    )
    limits[key] = ENGINE_LIMIT_DEFAULTS[key]
  }
  for (const key of Object.keys(ENGINE_LIMIT_VARIABLES) as (keyof EngineLimits)[]) {
    const raw = env[ENGINE_LIMIT_VARIABLES[key]]
    if (raw === undefined || raw.trim() === '') continue
    const value = Number(raw.trim())
    if (!Number.isSafeInteger(value) || value <= 0) keep(key, 'is not a positive whole number')
    else limits[key] = value
  }
  // A message must hold its header and a whole blob chunk; when it cannot, the three sizes keep their defaults,
  // which fit together.
  if (limits.headerReserveBytes + limits.blobChunkBytes > limits.maxMessageBytes)
    for (const key of ['maxMessageBytes', 'headerReserveBytes', 'blobChunkBytes'] as const)
      keep(key, 'does not fit a header and a blob chunk in one message')
  return { limits, problems }
}

let loaded: { limits: EngineLimits; problems: string[] } | undefined

/** The process's engine limits, read from the environment the first time. */
export function engineLimits(): EngineLimits {
  loaded ??= readEngineLimits(process.env)
  return loaded.limits
}

/** What was wrong with the environment's limits, for the engine's start to report. */
export function engineLimitProblems(): readonly string[] {
  engineLimits()
  return loaded!.problems
}
