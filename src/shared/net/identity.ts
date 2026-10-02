import type { NodeCapability } from './capabilities'
import type { BotId, InviteId, NodeId, SpaceId, UserId } from './ids'

/** base64url without padding. */
export type Base64Url = string

/**
 * Public keys on the wire, base64url:
 * - `sign`: Ed25519, raw 32 bytes.
 * - `agree`: X25519, raw 32 bytes (sealing to a node).
 * - `transport`: ECDSA P-256, SPKI DER (the TLS certificate key).
 * A fingerprint is SHA-256 over the encoded key bytes.
 */
export interface NodePublicKeys {
  sign: Base64Url
  agree: Base64Url
  transport: Base64Url
}
export interface BotPublicKeys {
  sign: Base64Url
}

/** Signed wrapper: `sig` covers exactly the bytes of `payload` as transmitted. */
export interface Signed {
  /** UTF-8 JSON of the signed document, base64url. Never re-serialized before verifying. */
  payload: Base64Url
  /** Ed25519 signature, base64url. */
  sig: Base64Url
}

export interface NodeDelegation {
  v: 1
  kind: 'node'
  subject: NodeId
  keys: NodePublicKeys
  owner: UserId
  name: string
  caps: NodeCapability[]
  /** Only the current epoch may author new events or open sessions; older ones are verify-only. */
  keyEpoch: number
  issuedAt: number
  expiresAt: number
}

export interface BotDelegation {
  v: 1
  kind: 'bot'
  subject: BotId
  keys: BotPublicKeys
  owner: UserId
  name: string
  /** The single node allowed to execute this bot. */
  hostNode: NodeId
  keyEpoch: number
  issuedAt: number
  expiresAt: number
}

export type Delegation = NodeDelegation | BotDelegation

export interface RosterRevocation {
  subject: NodeId | BotId
  /** Every key epoch up to and including this one is revoked. */
  throughKeyEpoch: number
  revokedAt: number
}

/** Per-user document signed by the root key. Ordered by `(recoveryEpoch, version)`. */
export interface Roster {
  v: 1
  owner: UserId
  rootKey: Base64Url
  recoveryEpoch: number
  /** Random per recovery epoch; two lineages at one epoch are a conflict. */
  lineage: string
  version: number
  authorityNode: NodeId
  /** Signed delegations, current and verify-only. */
  nodes: Signed[]
  bots: Signed[]
  revoked: RosterRevocation[]
  issuedAt: number
}

export const TRANSPORT_IDS = ['memory', 'direct', 'tailscale', 'relay', 'cloudflared'] as const
export type TransportId = (typeof TRANSPORT_IDS)[number] | (string & {})

export interface Route {
  transport: TransportId
  address: string
  /** Lower dials first. */
  priority: number
}

/** Node-signed, so a relay or host cannot substitute routes. */
export interface RoutesRecord {
  v: 1
  node: NodeId
  routes: Route[]
  /** Monotonic per node; the highest wins. */
  version: number
  issuedAt: number
}

/** Owner-signed. Pins which host is the authority for a space and at which epoch. */
export interface SpaceDescriptor {
  v: 1
  space: SpaceId
  owner: UserId
  hostNode: NodeId
  hostTransportKey: Base64Url
  /** Signed RoutesRecord of the host. */
  routes: Signed
  epoch: number
  issuedAt: number
}

export type KeystoreState = 'unlocked' | 'locked' | 'missing'
export type RosterState = 'ok' | 'conflict'

/** Node-signed space admission authorization; bearer tokens never enter history. */
export interface SpaceInviteAuthorization {
  v: 1
  invite: InviteId
  space: SpaceId
  epoch: number
  issuer: { user: UserId; node: NodeId; delegation: Signed }
  /** Meta position at which the issuer's role is proved. */
  auth: { metaEpoch: number; metaSeq: number }
  role: 'member' | 'admin'
  issuedAt: number
  expiresAt: number
  uses: number
  joiner?: UserId
}
