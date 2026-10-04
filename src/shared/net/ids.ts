/** Stable identifiers. Random, never derived from keys or paths. Browser-safe. */
export const ID_PREFIXES = {
  user: 'usr',
  node: 'nod',
  bot: 'bot',
  space: 'spc',
  stream: 'str',
  event: 'evt',
  execution: 'exe',
  rpc: 'rpc',
  invite: 'inv',
  dispatch: 'dsp'
} as const
export type IdKind = keyof typeof ID_PREFIXES

type Prefixed<K extends IdKind> = `${(typeof ID_PREFIXES)[K]}_${string}`
export type UserId = Prefixed<'user'>
export type NodeId = Prefixed<'node'>
export type BotId = Prefixed<'bot'>
export type SpaceId = Prefixed<'space'>
export type StreamId = Prefixed<'stream'>
export type EventId = Prefixed<'event'>
export type ExecutionId = Prefixed<'execution'>
export type RpcId = Prefixed<'rpc'>
export type InviteId = Prefixed<'invite'>
export type DispatchId = Prefixed<'dispatch'>
/** `blb_` + lowercase hex SHA-256 of the stored (possibly encrypted) bytes. */
export type BlobId = `blb_${string}`

const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz'
const BODY_LENGTH = 26
const ID_PATTERN = /^[a-z]{3}_[0-9a-hjkmnp-tv-z]{26}$/
const BLOB_PATTERN = /^blb_[0-9a-f]{64}$/

/** 128 random bits as 26 Crockford base32 characters. */
export function newId<K extends IdKind>(kind: K): Prefixed<K> {
  const bytes = new Uint8Array(16)
  globalThis.crypto.getRandomValues(bytes)
  let value = 0n
  for (const byte of bytes) value = (value << 8n) | BigInt(byte)
  let body = ''
  for (let index = 0; index < BODY_LENGTH; index++) {
    body = ALPHABET[Number(value & 31n)] + body
    value >>= 5n
  }
  return `${ID_PREFIXES[kind]}_${body}` as Prefixed<K>
}

export function isId<K extends IdKind>(kind: K, value: unknown): value is Prefixed<K> {
  return (
    typeof value === 'string' && ID_PATTERN.test(value) && value.startsWith(`${ID_PREFIXES[kind]}_`)
  )
}

export function isBlobId(value: unknown): value is BlobId {
  return typeof value === 'string' && BLOB_PATTERN.test(value)
}
