/** Protocol limits and timing for Mousse Net. Normative values; see docs/net/protocol.md. */
export const NET_PROTO_MAJOR = 1
export const NET_PROTO_MINOR = 0
export const ENVELOPE_VERSION = 1

export const MAX_INLINE_ENVELOPE_BYTES = 64 * 1024
export const MAX_FRAME_BYTES = 64 * 1024
export const DEFAULT_MAX_BLOB_BYTES = 25 * 1024 * 1024
export const BLOB_CHUNK_BYTES = 48 * 1024
export const REPLAY_BATCH_BYTES = 1024 * 1024
export const OVERLAP_BUFFER_MAX_RECORDS = 1_000
export const OVERLAP_BUFFER_MAX_BYTES = 4 * 1024 * 1024
/** Largest sequence number; sequences are JSON-safe integers. */
export const MAX_SEQ = Number.MAX_SAFE_INTEGER

export const HEARTBEAT_INTERVAL_MS = 20_000
export const PRESENCE_RECONNECTING_AFTER_MS = 45_000
export const PRESENCE_OFFLINE_AFTER_MS = 90_000
export const SESSION_PING_INTERVAL_MS = 20_000
export const SESSION_MISSED_PINGS_TO_CLOSE = 3
export const FRAGMENT_STALL_MS = 30_000

export const DIAL_RESOLVE_DEADLINE_MS = 5_000
export const DIAL_CONNECT_DEADLINE_MS = 10_000
export const DIAL_TLS_DEADLINE_MS = 10_000
export const DIAL_HELLO_DEADLINE_MS = 10_000
export const BACKOFF_MIN_MS = 1_000
export const BACKOFF_MAX_MS = 60_000
export const BACKOFF_RESET_AFTER_SESSION_MS = 30_000

export const NODE_DELEGATION_TTL_MS = 7 * 24 * 60 * 60 * 1000
export const NODE_INVITE_TTL_MS = 10 * 60 * 1000
export const SPACE_INVITE_TTL_MS = 24 * 60 * 60 * 1000

/** A mention runs only if received within this long of the host's receive time. */
export const DELIVERY_WINDOW_MS = 30_000
/** ...and only if the author's clock and the host's receive time are this close. */
export const AUTHOR_DELAY_MAX_MS = 120_000
/** Measured clock offset to the host above which execution is disabled. */
export const CLOCK_OFFSET_MAX_MS = 60_000
/** How fresh the host-confirmed space.meta head must be at admission. */
export const META_HEAD_FRESHNESS_MS = 30_000

export const PREAUTH_MAX_CONNECTIONS = 32
export const PREAUTH_MAX_PER_ADDRESS = 4
export const PREAUTH_MAX_BYTES = 16 * 1024
export const PREAUTH_DEADLINE_MS = 10_000
export const SESSION_MAX_SUBSCRIPTIONS = 256
export const SESSION_MAX_INFLIGHT_RPCS = 64
export const SESSION_MAX_BLOB_TRANSFERS = 8
export const SESSION_MAX_SPACE_PROOFS = 8
export const SPACE_PROOF_DEADLINE_MS = 30_000
export const SPACE_DISCOVERY_MAX_CONTROLS = 64
export const SPACE_DISCOVERY_MAX_CONTROL_BYTES = 128 * 1024

export const STORE_TXN_MAX_ROWS = 500
export const STORE_TXN_MAX_BYTES = 1024 * 1024
export const UPLOAD_PENDING_TTL_MS = 60 * 60 * 1000
export const BLOB_GC_GRACE_MS = 24 * 60 * 60 * 1000

export const BOT_PENDING_PERMISSION_REQUESTS_MAX = 20
export const BOT_PERMISSION_REQUEST_TTL_MS = 24 * 60 * 60 * 1000
export const BOT_DEFAULT_CONCURRENT_RUNS = 2
export const BOT_DEFAULT_RUNS_PER_MEMBER_PER_HOUR = 20
export const MEMBER_RATE_EVENTS = 20
export const MEMBER_RATE_WINDOW_MS = 10_000
export const MEMBER_UPLOAD_BYTES_PER_HOUR = 60 * 1024 * 1024
export const SPACE_DEFAULT_QUOTA_BYTES = 5 * 1024 * 1024 * 1024
