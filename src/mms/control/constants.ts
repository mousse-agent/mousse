/**
 * Control Protocol 2.0 constants and operational limits.
 * Aligned with docs/WIRE_PROTOCOL.md and mousse-plus/packages/protocol/src/constants.ts.
 */

export const PROTOCOL_MAJOR = 2 as const
export const PROTOCOL_MINOR = 0 as const

/** Encrypted transport chunk size before reassembly (64 KiB). */
export const CHUNK_MAX_BYTES = 64 * 1024

/** Maximum reassembled application message size (4 MiB). */
export const MESSAGE_MAX_BYTES = 4 * 1024 * 1024

/** WebSocket / session heartbeat interval (20s). */
export const HEARTBEAT_INTERVAL_MS = 20_000

/** Mark peer offline after this many ms without proof of life (60s). */
export const OFFLINE_AFTER_MS = 60_000

/** Unauthenticated relay socket authentication deadline (5s). */
export const AUTH_DEADLINE_MS = 5_000

/** One-time relay admission credential TTL (30s). */
export const ADMISSION_TTL_MS = 30_000

/** QR pairing payload lifetime (2 minutes). */
export const QR_TTL_MS = 2 * 60_000

/** Maximum QR / deep-link payload size in bytes (4 KiB). */
export const QR_MAX_PAYLOAD_BYTES = 4 * 1024

/** Pairing bootstrap secret length (256-bit / 32 bytes). */
export const PAIRING_SECRET_BYTES = 32

/** Headless CLI login transaction lifetime (10 minutes). */
export const LOGIN_TRANSACTION_TTL_MS = 10 * 60_000

/** Self-hosted operator enrollment code lifetime (10 minutes). */
export const ENROLLMENT_CODE_TTL_MS = 10 * 60_000

/** Crockford Base32 enrollment code character count (80 bits). */
export const ENROLLMENT_CODE_LENGTH = 16

/** Maximum failed submissions per enrollment code. */
export const ENROLLMENT_CODE_MAX_FAILURES = 5

/** Concurrent in-flight RPCs per pairing. */
export const MAX_CONCURRENT_RPCS = 64

/** Per-connection outbound queued ciphertext bytes (2 MiB). */
export const MAX_OUTBOUND_QUEUED_BYTES = 2 * 1024 * 1024

/** Hosted route authorization lease renewal window (60s). */
export const AUTHORIZATION_LEASE_MS = 60_000

/** Mutation idempotency record retention (24h). */
export const IDEMPOTENCY_RETENTION_MS = 24 * 60 * 60 * 1000

/** Local event ring size reused for remote replay. */
export const EVENT_RING_SIZE = 512

/** Reconnect backoff bounds (with jitter). */
export const RECONNECT_BACKOFF_MIN_MS = 1_000
export const RECONNECT_BACKOFF_MAX_MS = 30_000

/** X25519 / Ed25519 public key length (32 bytes). */
export const PUBLIC_KEY_BYTES = 32

/** Opaque identifier maximum length. */
export const ID_MAX_LENGTH = 128

/** Idempotency key maximum length. */
export const IDEMPOTENCY_KEY_MAX_LENGTH = 128

/** Method name maximum length. */
export const METHOD_MAX_LENGTH = 96

/** Default hosted API origin. */
export const DEFAULT_HOSTED_CONTROL_ORIGIN = 'https://api.mousse.plus'

/** Default hosted Dashboard URL. */
export const DEFAULT_HOSTED_DASHBOARD_URL = 'https://mousse.plus'

// --- Binary Framing Constants ---

/** Canonical relay binary frame magic 'MP' (0x4D50). */
export const FRAME_MAGIC = 0x4d50 as const
export const FRAME_VERSION = 1 as const
export const FRAME_HEADER_BYTES = 8 as const
export const FRAME_FLAG_FIN = 0x01 as const
export const FRAME_FLAG_CONTROL = 0x02 as const
export const FRAME_MAX_PAYLOAD_BYTES = CHUNK_MAX_BYTES

/** Maximum plaintext bytes fitting in one encrypted transport frame (64 KiB - 16 Poly1305 tag). */
export const MAX_PLAINTEXT_CHUNK_BYTES = FRAME_MAX_PAYLOAD_BYTES - 16

export const LIMITS = {
  PROTOCOL_MAJOR,
  PROTOCOL_MINOR,
  CHUNK_MAX_BYTES,
  MESSAGE_MAX_BYTES,
  HEARTBEAT_INTERVAL_MS,
  OFFLINE_AFTER_MS,
  AUTH_DEADLINE_MS,
  ADMISSION_TTL_MS,
  QR_TTL_MS,
  QR_MAX_PAYLOAD_BYTES,
  PAIRING_SECRET_BYTES,
  LOGIN_TRANSACTION_TTL_MS,
  ENROLLMENT_CODE_TTL_MS,
  ENROLLMENT_CODE_LENGTH,
  ENROLLMENT_CODE_MAX_FAILURES,
  MAX_CONCURRENT_RPCS,
  MAX_OUTBOUND_QUEUED_BYTES,
  AUTHORIZATION_LEASE_MS,
  IDEMPOTENCY_RETENTION_MS,
  EVENT_RING_SIZE,
  RECONNECT_BACKOFF_MIN_MS,
  RECONNECT_BACKOFF_MAX_MS,
  PUBLIC_KEY_BYTES,
  ID_MAX_LENGTH,
  IDEMPOTENCY_KEY_MAX_LENGTH,
  METHOD_MAX_LENGTH,
} as const

