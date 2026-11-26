import { BLOB_CHUNK_BYTES, DEFAULT_MAX_BLOB_BYTES, MAX_FRAME_BYTES } from '../../shared/net/limits'
import { DEFAULT_SCAN_INTERVAL_MS } from '../../shared/netEngine/local'

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
  /** How long this computer waits for a pairing that just connected to say its version (`net.info`). */
  peerInfoDeadlineMs: number
  /** How long a cancel waits. */
  cancelDeadlineMs: number
  /** How long a blob fetch or store waits. */
  blobDeadlineMs: number
  /** How long an append waits. */
  appendDeadlineMs: number
  /** The least time a result lookup is given, however little of the call's own deadline is left. */
  resultWaitFloorMs: number
  /**
   * How long the Hub waits for an engine pairing to open a thread's private stream (`bridge.hub.attach`), and for
   * each page of a large answer it fetches.
   */
  hubRoutedDeadlineMs: number
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
  /**
   * Bytes one stream may have queued for the helper before its producer waits (a blob sender, a replay or a
   * snapshot waits between chunks or pages until the queue is below this).
   */
  appStreamQueueBytes: number
  /** Bytes one stream may have queued at all: a write past this resets the stream (`too_large`). */
  appStreamQueueMaxBytes: number
  /** Bytes of requests, credit and resets queued for the helper: a request past this is refused (`rate_limited`). */
  appControlQueueBytes: number
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
  /** How much of what the helper (or its first-run `init`) wrote on stderr is kept, from the end, for the status. */
  helperStderrMaxBytes: number
  /**
   * After the helper exits, how long its stderr may stay open: a process it started (an ssh client) can hold it past
   * its exit, and the stop must not wait on that.
   */
  helperStderrDrainMs: number
  /** How often Scan its code reads a camera frame for a pairing code. */
  scanIntervalMs: number
  /** How long a start keeps trying while another helper still holds the endpoint. */
  helperLockWaitMs: number
  /** How long `init` (a new endpoint, its key into the keystore) may take. */
  helperInitDeadlineMs: number
  /** How long a join waits for the other computer's answer (its owner taps Yes or No there). */
  joinDeadlineMs: number
  /** How long the other direction of a pairing may take to come up once the joiner asked for it (`pairback`). */
  pairbackDeadlineMs: number
  /** How long "Use another computer" waits for its check that the computer answers (`join.probe`). */
  joinProbeDeadlineMs: number
  /** The wait before a pairing step that failed (a grant not saved, a pairback not answered) is tried again. */
  pairingRetryMs: number
  /** How long a renewed path may take to answer hello and give back each live subscription's head (§3.6). */
  pathSwitchDeadlineMs: number
  /**
   * The longest the old path of a switch is kept for the calls still running on it. A call it cuts off is
   * collected on the new path (`result.get`). Within the renewal lead, so the old path's own deadline is later.
   */
  pathDrainMs: number
  /**
   * How long a device's row may read "Finishing pairing…", or one direction of a paired computer be down, before
   * the row says so and offers Retry (design §5.2).
   */
  rowStuckMs: number
  /** Most addresses the user may add for one paired computer (Add address). */
  maxManualAddresses: number
  /** How long Test on one of this computer's routes waits for its helper to reach itself (`routes.test`). */
  routeTestDeadlineMs: number
  /** The deadline for each ssh.* request and one SSH add try (1b §13.3): 1000 to 600000. */
  sshRequestDeadlineMs: number
  /** How long A may repeat one request id, and B refuses older unknown ones (seconds; 60 to 86400, tighten only). */
  sshRequestMaxAgeSecs: number
  /** How long B keeps request records (seconds; at least twice the maximum age). */
  sshRequestKeepSecs: number
  /** How often B drops request records past their keep time. */
  sshRequestPruneMs: number
  /**
   * Largest request `mousse-cli net-engine ssh` reads from stdin, the line another computer sent over SSH.
   * Security-bound: it can only be lowered.
   */
  sshRemoteRequestMaxBytes: number
  /** How long `mousse-cli net-engine ssh` waits for that line. Security-bound: it can only be lowered. */
  sshRemoteReadMs: number
  /** How often a waiting `mousse-cli net-engine invite` or `join` reads the status again when no change was announced. */
  cliStatusReadMs: number
  /**
   * How long the other computer has to end a tunnel's stream after this one let the tunnel go (a close, a refusal, both
   * ends): past it the stream is reset, so it frees its slot on the connection. Peer-bound: it can only be lowered.
   */
  tunnelCloseLingerMs: number
  /** How long `mousse-cli net-engine join` waits for the other computer to let it in (its owner taps Yes there). */
  cliJoinWaitMs: number
  /**
   * Longest `mousse://pair` link main takes from the OS (argv, `open-url`); a ticket is a few hundred bytes. Anyone can
   * hand the app a link, so it can only be lowered.
   */
  pairLinkMaxChars: number
  /** How long adding this computer's own relay (pasting its link, `relay.enroll`) may take: the helper resolves and dials it. */
  relayEnrollDeadlineMs: number
  /** Most relay routes one device's row asks about at once ("<host> can be reached through relay … Allow?"). */
  relayOffersShown: number
  /** How long a burst of relay events is gathered before the relay lists are read again (once each). */
  relayReadDebounceMs: number
  /** The wait before asking a helper for its relays again when the first ask failed (it may be starting). */
  relayReadRetryMs: number
  /** How many times the relays are asked for before the app gives up until the next relay event. */
  relayReadTries: number
  /** Plus (Phase 4): after a failed read of the Plus state or the removals at hello, the wait before the next. */
  plusReadRetryMs: number
  /** How many times the Plus state and the removals are asked for at hello before the app waits for an event. */
  plusReadTries: number
  /**
   * How long a request to use the other computer of a one-way pairing waits for its owner to press Allow or Not now
   * ("Use <name> from here…"); past it the row says it expired and the other computer's prompt closes.
   */
  accessAskMs: number
  /** The least time between two such requests from this computer to one other computer. */
  accessAskGapMs: number
  /**
   * The least time between two Allow prompts one other computer can raise here by asking: a request sooner than this
   * after the last one is dropped without a prompt.
   */
  accessPromptGapMs: number
  /**
   * How long a request id another computer sent is remembered, so a repeat of it never prompts again. Far longer
   * than a request lives (`accessAskMs`); a request is never repeated after it ends.
   */
  accessSeenMs: number
  /**
   * The most request ids remembered per other computer within `accessSeenMs`: while that many are held, a new
   * request is dropped without a prompt, so none is forgotten early. Above what one computer asking no sooner than
   * `accessAskGapMs` can send in that time.
   */
  accessSeenIds: number
  /**
   * How long after a grant's role could not be made to follow its device's level (`grant.set_role` failed) it is
   * tried again, while the row says the change is not applied.
   */
  roleRetryMs: number
  /** Most `grant.set_role` tries in one go when the grant changed in between (`revision_conflict`). */
  roleEditTries: number
}

/** The helper's `APP_READ_AHEAD_BYTES`: a stream's credit must cover it before the helper reads that stream. */
export const HELPER_READ_AHEAD_BYTES = 64 * 1024

export const ENGINE_LIMIT_DEFAULTS: Readonly<EngineLimits> = Object.freeze({
  maxMessageBytes: MAX_FRAME_BYTES,
  headerReserveBytes: 4 * 1024,
  recordsPerMessage: 499,
  blobChunkBytes: BLOB_CHUNK_BYTES,
  maxBlobBytes: DEFAULT_MAX_BLOB_BYTES,
  maxCallDeadlineMs: 24 * 60 * 60_000,
  helloDeadlineMs: 15_000,
  peerInfoDeadlineMs: 10_000,
  cancelDeadlineMs: 15_000,
  blobDeadlineMs: 120_000,
  appendDeadlineMs: 60_000,
  resultWaitFloorMs: 15_000,
  hubRoutedDeadlineMs: 30_000,
  renewIntervalMs: 60 * 60_000,
  renewDueWithinMs: 24 * 60 * 60_000,
  clockSkewMs: 600_000,
  appFrameMaxBytes: 1024 * 1024,
  appDataMaxBytes: 64 * 1024,
  appCreditBudgetBytes: 8 * 1024 * 1024,
  appStreamCreditBytes: 256 * 1024,
  appInteractiveReserveBytes: 1024 * 1024,
  appStreamsPerConnection: 32,
  appStreamQueueBytes: 1024 * 1024,
  appStreamQueueMaxBytes: 16 * 1024 * 1024,
  appControlQueueBytes: 4 * 1024 * 1024,
  appRequestDeadlineMs: 15_000,
  helperRestartFirstMs: 500,
  helperRestartMaxMs: 5 * 60_000,
  helperUpResetMs: 60_000,
  helperFastExits: 3,
  helperShutdownGraceMs: 3_000,
  helperStderrMaxBytes: 4096,
  helperStderrDrainMs: 500,
  scanIntervalMs: DEFAULT_SCAN_INTERVAL_MS,
  helperLockWaitMs: 5_000,
  helperInitDeadlineMs: 60_000,
  joinDeadlineMs: 15 * 60_000,
  pairbackDeadlineMs: 60_000,
  joinProbeDeadlineMs: 15_000,
  pairingRetryMs: 5_000,
  pathSwitchDeadlineMs: 30_000,
  pathDrainMs: 25 * 60_000,
  rowStuckMs: 2 * 60_000,
  maxManualAddresses: 8,
  routeTestDeadlineMs: 20_000,
  sshRequestDeadlineMs: 120_000,
  sshRequestMaxAgeSecs: 86_400,
  sshRequestKeepSecs: 604_800,
  sshRequestPruneMs: 60 * 60_000,
  sshRemoteRequestMaxBytes: 64 * 1024,
  sshRemoteReadMs: 30_000,
  cliStatusReadMs: 2_000,
  tunnelCloseLingerMs: 5_000,
  cliJoinWaitMs: 16 * 60_000,
  pairLinkMaxChars: 4096,
  relayEnrollDeadlineMs: 60_000,
  relayOffersShown: 3,
  relayReadDebounceMs: 100,
  relayReadRetryMs: 1_000,
  relayReadTries: 5,
  plusReadRetryMs: 1_000,
  plusReadTries: 5,
  accessAskMs: 2 * 60_000,
  accessAskGapMs: 30_000,
  accessPromptGapMs: 20_000,
  accessSeenMs: 60 * 60_000,
  accessSeenIds: 256,
  roleRetryMs: 15_000,
  roleEditTries: 3
})

export const ENGINE_LIMIT_VARIABLES: Readonly<Record<keyof EngineLimits, string>> = Object.freeze({
  maxMessageBytes: 'MOUSSE_NET_ENGINE_MAX_MESSAGE_BYTES',
  headerReserveBytes: 'MOUSSE_NET_ENGINE_HEADER_RESERVE_BYTES',
  recordsPerMessage: 'MOUSSE_NET_ENGINE_RECORDS_PER_MESSAGE',
  blobChunkBytes: 'MOUSSE_NET_ENGINE_BLOB_CHUNK_BYTES',
  maxBlobBytes: 'MOUSSE_NET_ENGINE_MAX_BLOB_BYTES',
  maxCallDeadlineMs: 'MOUSSE_NET_ENGINE_MAX_CALL_DEADLINE_MS',
  helloDeadlineMs: 'MOUSSE_NET_ENGINE_HELLO_DEADLINE_MS',
  peerInfoDeadlineMs: 'MOUSSE_NET_ENGINE_PEER_INFO_DEADLINE_MS',
  cancelDeadlineMs: 'MOUSSE_NET_ENGINE_CANCEL_DEADLINE_MS',
  blobDeadlineMs: 'MOUSSE_NET_ENGINE_BLOB_DEADLINE_MS',
  appendDeadlineMs: 'MOUSSE_NET_ENGINE_APPEND_DEADLINE_MS',
  resultWaitFloorMs: 'MOUSSE_NET_ENGINE_RESULT_WAIT_FLOOR_MS',
  hubRoutedDeadlineMs: 'MOUSSE_NET_ENGINE_HUB_ROUTED_DEADLINE_MS',
  renewIntervalMs: 'MOUSSE_NET_ENGINE_RENEW_INTERVAL_MS',
  renewDueWithinMs: 'MOUSSE_NET_ENGINE_RENEW_DUE_WITHIN_MS',
  clockSkewMs: 'MOUSSE_NET_ENGINE_CLOCK_SKEW_MS',
  appFrameMaxBytes: 'MOUSSE_NET_ENGINE_APP_FRAME_MAX_BYTES',
  appDataMaxBytes: 'MOUSSE_NET_ENGINE_APP_DATA_MAX_BYTES',
  appCreditBudgetBytes: 'MOUSSE_NET_ENGINE_APP_CREDIT_BUDGET_BYTES',
  appStreamCreditBytes: 'MOUSSE_NET_ENGINE_APP_STREAM_CREDIT_BYTES',
  appInteractiveReserveBytes: 'MOUSSE_NET_ENGINE_APP_INTERACTIVE_RESERVE_BYTES',
  appStreamsPerConnection: 'MOUSSE_NET_ENGINE_APP_STREAMS_PER_CONNECTION',
  appStreamQueueBytes: 'MOUSSE_NET_ENGINE_APP_STREAM_QUEUE_BYTES',
  appStreamQueueMaxBytes: 'MOUSSE_NET_ENGINE_APP_STREAM_QUEUE_MAX_BYTES',
  appControlQueueBytes: 'MOUSSE_NET_ENGINE_APP_CONTROL_QUEUE_BYTES',
  appRequestDeadlineMs: 'MOUSSE_NET_ENGINE_APP_REQUEST_DEADLINE_MS',
  helperRestartFirstMs: 'MOUSSE_NET_ENGINE_HELPER_RESTART_FIRST_MS',
  helperRestartMaxMs: 'MOUSSE_NET_ENGINE_HELPER_RESTART_MAX_MS',
  helperUpResetMs: 'MOUSSE_NET_ENGINE_HELPER_UP_RESET_MS',
  helperFastExits: 'MOUSSE_NET_ENGINE_HELPER_FAST_EXITS',
  helperShutdownGraceMs: 'MOUSSE_NET_ENGINE_HELPER_SHUTDOWN_GRACE_MS',
  helperStderrMaxBytes: 'MOUSSE_NET_ENGINE_HELPER_STDERR_MAX_BYTES',
  helperStderrDrainMs: 'MOUSSE_NET_ENGINE_HELPER_STDERR_DRAIN_MS',
  scanIntervalMs: 'MOUSSE_NET_ENGINE_SCAN_INTERVAL_MS',
  helperLockWaitMs: 'MOUSSE_NET_ENGINE_HELPER_LOCK_WAIT_MS',
  helperInitDeadlineMs: 'MOUSSE_NET_ENGINE_HELPER_INIT_DEADLINE_MS',
  joinDeadlineMs: 'MOUSSE_NET_ENGINE_JOIN_DEADLINE_MS',
  pairbackDeadlineMs: 'MOUSSE_NET_ENGINE_PAIRBACK_DEADLINE_MS',
  joinProbeDeadlineMs: 'MOUSSE_NET_ENGINE_JOIN_PROBE_DEADLINE_MS',
  pairingRetryMs: 'MOUSSE_NET_ENGINE_PAIRING_RETRY_MS',
  pathSwitchDeadlineMs: 'MOUSSE_NET_ENGINE_PATH_SWITCH_DEADLINE_MS',
  pathDrainMs: 'MOUSSE_NET_ENGINE_PATH_DRAIN_MS',
  rowStuckMs: 'MOUSSE_NET_ENGINE_ROW_STUCK_MS',
  maxManualAddresses: 'MOUSSE_NET_ENGINE_MAX_MANUAL_ADDRESSES',
  routeTestDeadlineMs: 'MOUSSE_NET_ENGINE_ROUTE_TEST_DEADLINE_MS',
  sshRequestDeadlineMs: 'MOUSSE_NET_ENGINE_SSH_REQUEST_DEADLINE_MS',
  sshRequestMaxAgeSecs: 'MOUSSE_NET_ENGINE_SSH_REQUEST_MAX_AGE_SECS',
  sshRequestKeepSecs: 'MOUSSE_NET_ENGINE_SSH_REQUEST_KEEP_SECS',
  sshRequestPruneMs: 'MOUSSE_NET_ENGINE_SSH_REQUEST_PRUNE_MS',
  sshRemoteRequestMaxBytes: 'MOUSSE_NET_ENGINE_SSH_REMOTE_REQUEST_MAX_BYTES',
  sshRemoteReadMs: 'MOUSSE_NET_ENGINE_SSH_REMOTE_READ_MS',
  cliStatusReadMs: 'MOUSSE_NET_ENGINE_CLI_STATUS_READ_MS',
  tunnelCloseLingerMs: 'MOUSSE_NET_ENGINE_TUNNEL_CLOSE_LINGER_MS',
  cliJoinWaitMs: 'MOUSSE_NET_ENGINE_CLI_JOIN_WAIT_MS',
  pairLinkMaxChars: 'MOUSSE_NET_ENGINE_PAIR_LINK_MAX_CHARS',
  relayEnrollDeadlineMs: 'MOUSSE_NET_ENGINE_RELAY_ENROLL_DEADLINE_MS',
  relayOffersShown: 'MOUSSE_NET_ENGINE_RELAY_OFFERS_SHOWN',
  relayReadDebounceMs: 'MOUSSE_NET_ENGINE_RELAY_READ_DEBOUNCE_MS',
  relayReadRetryMs: 'MOUSSE_NET_ENGINE_RELAY_READ_RETRY_MS',
  relayReadTries: 'MOUSSE_NET_ENGINE_RELAY_READ_TRIES',
  plusReadRetryMs: 'MOUSSE_NET_ENGINE_PLUS_READ_RETRY_MS',
  plusReadTries: 'MOUSSE_NET_ENGINE_PLUS_READ_TRIES',
  accessAskMs: 'MOUSSE_NET_ENGINE_ACCESS_ASK_MS',
  accessAskGapMs: 'MOUSSE_NET_ENGINE_ACCESS_ASK_GAP_MS',
  accessPromptGapMs: 'MOUSSE_NET_ENGINE_ACCESS_PROMPT_GAP_MS',
  accessSeenMs: 'MOUSSE_NET_ENGINE_ACCESS_SEEN_MS',
  accessSeenIds: 'MOUSSE_NET_ENGINE_ACCESS_SEEN_IDS',
  roleRetryMs: 'MOUSSE_NET_ENGINE_ROLE_RETRY_MS',
  roleEditTries: 'MOUSSE_NET_ENGINE_ROLE_EDIT_TRIES'
})

/** Limits that guard this computer against another: a value above the default is refused, so they only tighten. */
const TIGHTEN_ONLY: ReadonlySet<keyof EngineLimits> = new Set([
  'sshRemoteRequestMaxBytes',
  'sshRemoteReadMs',
  'tunnelCloseLingerMs',
  'pairLinkMaxChars'
])

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
    else if (TIGHTEN_ONLY.has(key) && value > ENGINE_LIMIT_DEFAULTS[key])
      keep(key, 'can only be lowered')
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
    for (const key of [
      'appCreditBudgetBytes',
      'appStreamCreditBytes',
      'appInteractiveReserveBytes'
    ] as const)
      keep(key, "does not leave a stream's credit beside the interactive reserve")
  // The helper reads a stream only while its credit covers what it buffered plus its read-ahead: less never reads.
  if (limits.appStreamCreditBytes < HELPER_READ_AHEAD_BYTES)
    keep(
      'appStreamCreditBytes',
      `is below the helper's read-ahead (${HELPER_READ_AHEAD_BYTES} bytes)`
    )
  // A stream's hard cap holds its soft one and one whole message past it (the producer checks between messages).
  if (limits.appStreamQueueBytes + limits.maxMessageBytes > limits.appStreamQueueMaxBytes)
    for (const key of ['appStreamQueueBytes', 'appStreamQueueMaxBytes'] as const)
      keep(key, 'leaves no room for a whole message past the soft queue limit')
  if (limits.helperRestartFirstMs > limits.helperRestartMaxMs)
    for (const key of ['helperRestartFirstMs', 'helperRestartMaxMs'] as const)
      keep(key, 'makes the first restart wait longer than the longest')
  // 1b §13.3 bounds: the request deadline within 1 s to 10 min; the maximum age only tightens; records are kept
  // at least twice the maximum age, so a request id is never seen as new a second time.
  if (limits.sshRequestDeadlineMs < 1000 || limits.sshRequestDeadlineMs > 600_000)
    keep('sshRequestDeadlineMs', 'is outside 1000 to 600000')
  if (
    limits.sshRequestMaxAgeSecs < 60 ||
    limits.sshRequestMaxAgeSecs > ENGINE_LIMIT_DEFAULTS.sshRequestMaxAgeSecs
  )
    keep('sshRequestMaxAgeSecs', 'is outside 60 to 86400 (it may only be lowered)')
  if (limits.sshRequestKeepSecs < 2 * limits.sshRequestMaxAgeSecs)
    keep('sshRequestKeepSecs', 'is less than twice the maximum request age')
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
  'no-host-dedupe',
  // phase1a.pair-both-ways
  'no-consent-journal',
  // phase1a.removal
  'keep-engine-work',
  'teardown-on-event-only',
  // phase1a.path-switch
  'abort-on-path-replaced',
  // phase1b.link-app
  'link-pinned-journal',
  'already-grants-back',
  'pin-promotes-kind2',
  'link-approvals-lost',
  'link-scheme-registered',
  // phase1b.routes-app (and phase1b.ssh-add-app)
  'plus-probe',
  'egress-probe',
  'lan-only-candidates',
  'route-leak',
  // phase1b.ssh-add-app
  'refuse-if-paired',
  'ssh-row-pairback',
  'profile-before-journal',
  'grant-id-not-checked',
  'retry-after-connected',
  'overwrite-1a-row',
  'own-row-not-resumed',
  'existing-reply-not-kept',
  'removal-skips-unsaved-grant',
  'ssh-row-not-converted',
  'remote-autostart',
  // phase1b.editor-app, phase1b.no-rpc-without-grant: the engine editor refusal skips the editor switch
  'tunnel-ignores-editor',
  // phase1b.editor-app: engine rights changes do not run reconcile
  'no-reconcile'
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
    return {
      problems: [`${CONTROL_VARIABLE}=${JSON.stringify(raw)} is not a known control; none is on`]
    }
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
