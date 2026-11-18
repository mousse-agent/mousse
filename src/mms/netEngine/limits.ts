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
  /** Clock difference allowed between a delegation's start and this computer's clock, as the engine allows. */
  clockSkewMs: number
  /** Largest frame on the channel to the helper (§2.1). Both sides must agree. */
  appFrameMaxBytes: number
  /** Largest payload of one DATA frame to or from the helper. */
  appDataMaxBytes: number
  /** All the credit this computer grants the helper at once, over every stream (§2.2). */
  appCreditBudgetBytes: number
  /** Most credit one stream holds from that budget. */
  appStreamCreditBytes: number
  /** Part of the budget only interactive streams may hold. */
  appInteractiveReserveBytes: number
  /** Streams one connection may have open, both directions counted; this computer queues its own opens past it. */
  appStreamsPerConnection: number
  /** How long a request to the helper (`dial`, `stream.open`, ...) waits for its answer. */
  appRequestDeadlineMs: number
  /** The first wait before a helper that exited is started again; each exit in a row doubles it. */
  helperRestartFirstMs: number
  /** The longest wait between restarts: once reached, the helper is started again this often. */
  helperRestartMaxMs: number
  /** A helper up this long has started well: the next exit starts the waits from the first again. */
  helperUpResetMs: number
  /** Exits in a row, each before `helperUpResetMs`, after which the status says the helper keeps stopping. */
  helperFastExits: number
  /** How long a helper asked to shut down has before it is killed. */
  helperShutdownGraceMs: number
  /** How long a start keeps trying while another helper still holds the endpoint. */
  helperLockWaitMs: number
  /** How long `init` (a new endpoint, its key into the keystore) may take. */
  helperInitDeadlineMs: number
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
  renewDueWithinMs: 24 * 60 * 60_000,
  clockSkewMs: 600_000,
  appFrameMaxBytes: 1024 * 1024,
  appDataMaxBytes: 64 * 1024,
  appCreditBudgetBytes: 8 * 1024 * 1024,
  appStreamCreditBytes: 256 * 1024,
  appInteractiveReserveBytes: 1024 * 1024,
  appStreamsPerConnection: 32,
  appRequestDeadlineMs: 15_000,
  helperRestartFirstMs: 500,
  helperRestartMaxMs: 5 * 60_000,
  helperUpResetMs: 60_000,
  helperFastExits: 3,
  helperShutdownGraceMs: 3_000,
  helperLockWaitMs: 5_000,
  helperInitDeadlineMs: 60_000
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
  renewDueWithinMs: 'MOUSSE_NET_ENGINE_RENEW_DUE_WITHIN_MS',
  clockSkewMs: 'MOUSSE_NET_ENGINE_CLOCK_SKEW_MS',
  appFrameMaxBytes: 'MOUSSE_NET_ENGINE_APP_FRAME_MAX_BYTES',
  appDataMaxBytes: 'MOUSSE_NET_ENGINE_APP_DATA_MAX_BYTES',
  appCreditBudgetBytes: 'MOUSSE_NET_ENGINE_APP_CREDIT_BUDGET_BYTES',
  appStreamCreditBytes: 'MOUSSE_NET_ENGINE_APP_STREAM_CREDIT_BYTES',
  appInteractiveReserveBytes: 'MOUSSE_NET_ENGINE_APP_INTERACTIVE_RESERVE_BYTES',
  appStreamsPerConnection: 'MOUSSE_NET_ENGINE_APP_STREAMS_PER_CONNECTION',
  appRequestDeadlineMs: 'MOUSSE_NET_ENGINE_APP_REQUEST_DEADLINE_MS',
  helperRestartFirstMs: 'MOUSSE_NET_ENGINE_HELPER_RESTART_FIRST_MS',
  helperRestartMaxMs: 'MOUSSE_NET_ENGINE_HELPER_RESTART_MAX_MS',
  helperUpResetMs: 'MOUSSE_NET_ENGINE_HELPER_UP_RESET_MS',
  helperFastExits: 'MOUSSE_NET_ENGINE_HELPER_FAST_EXITS',
  helperShutdownGraceMs: 'MOUSSE_NET_ENGINE_HELPER_SHUTDOWN_GRACE_MS',
  helperLockWaitMs: 'MOUSSE_NET_ENGINE_HELPER_LOCK_WAIT_MS',
  helperInitDeadlineMs: 'MOUSSE_NET_ENGINE_HELPER_INIT_DEADLINE_MS'
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
    // Skew alone may be none.
    if (!Number.isSafeInteger(value) || value < 0 || (value === 0 && key !== 'clockSkewMs'))
      keep(key, 'is not a positive whole number')
    else limits[key] = value
  }
  // A message must hold its header and a whole blob chunk; when it cannot, the three sizes keep their defaults,
  // which fit together.
  if (limits.headerReserveBytes + limits.blobChunkBytes > limits.maxMessageBytes)
    for (const key of ['maxMessageBytes', 'headerReserveBytes', 'blobChunkBytes'] as const)
      keep(key, 'does not fit a header and a blob chunk in one message')
  // A DATA frame (its handle and flags too) fits a frame; a stream's credit fits the budget, beside the reserve.
  if (limits.appDataMaxBytes + 10 > limits.appFrameMaxBytes)
    for (const key of ['appFrameMaxBytes', 'appDataMaxBytes'] as const)
      keep(key, 'does not fit a DATA frame in a frame')
  if (limits.appStreamCreditBytes + limits.appInteractiveReserveBytes > limits.appCreditBudgetBytes)
    for (const key of ['appCreditBudgetBytes', 'appStreamCreditBytes', 'appInteractiveReserveBytes'] as const)
      keep(key, "does not leave a stream's credit beside the interactive reserve")
  if (limits.helperRestartFirstMs > limits.helperRestartMaxMs)
    for (const key of ['helperRestartFirstMs', 'helperRestartMaxMs'] as const)
      keep(key, 'makes the first restart wait longer than the longest')
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

/**
 * The deliberate defects the owner checks switch on (`MOUSSE_NET_ENGINE_CONTROL`), each proving its check fails
 * when the thing it guards is broken. Read only by an unpackaged build: an installed app never breaks itself.
 */
export const ENGINE_CONTROLS = [
  // phase1a.picker-v1-off
  'roster-only-directory',
  'no-renewal',
  // phase1a.private-streams
  'second-reader',
  // phase1a.once-or-unknown
  'no-host-dedupe'
] as const
export type EngineControl = (typeof ENGINE_CONTROLS)[number]

const CONTROL_VARIABLE = 'MOUSSE_NET_ENGINE_CONTROL'

/** Whether this code runs from an installed app (inside its `app.asar`). */
export function packagedBuild(): boolean {
  try {
    return /[\/]app\.asar(?:\.unpacked)?[\/]/iu.test(new URL(import.meta.url).pathname)
  } catch {
    return true
  }
}

/** Reads the control from `env`; a name that is not a known control, or any control in an installed app, is reported. */
export function readEngineControl(
  env: NodeJS.ProcessEnv,
  packaged = packagedBuild()
): { control?: EngineControl; problems: string[] } {
  const raw = env[CONTROL_VARIABLE]?.trim()
  if (!raw) return { problems: [] }
  if (packaged) return { problems: [`${CONTROL_VARIABLE} is ignored by an installed app`] }
  if (!(ENGINE_CONTROLS as readonly string[]).includes(raw))
    return { problems: [`${CONTROL_VARIABLE}=${JSON.stringify(raw)} is not a known control; none is on`] }
  return { control: raw as EngineControl, problems: [] }
}

let control: { control?: EngineControl; problems: string[] } | undefined

/** Whether the owner check's control `name` is on in this process (read once). */
export function engineControl(name: EngineControl): boolean {
  control ??= readEngineControl(process.env)
  return control.control === name
}

/** What was wrong with the control variable, reported with the limits. */
export function engineControlProblems(): readonly string[] {
  control ??= readEngineControl(process.env)
  return control.problems
}
