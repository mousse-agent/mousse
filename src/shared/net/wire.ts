import type { SessionCapability } from './capabilities'
import type { NetErrorCode } from './errors'
import type {
  BlobId,
  BotId,
  EventId,
  InviteId,
  NodeId,
  RpcId,
  SpaceId,
  StreamId,
  UserId
} from './ids'
import type { Base64Url, NodePublicKeys, Signed } from './identity'
import type { SnapshotReason, StoredRecord, StreamDescriptor, StreamHead } from './streams'

/**
 * Sync protocol messages. Each mux message is one JSON header, optionally
 * followed by raw binary parts (envelope bytes, signatures, blob chunks). The
 * header's `parts` lists the byte length of each part in order.
 * Normative description: docs/net/protocol.md.
 */
export type Lane = 'control' | 'bulk'

export interface WireError {
  code: NetErrorCode
  message: string
  retryable: boolean
  /** Preserved cause chain, outermost first, for diagnostics. */
  cause?: Array<{ code?: string; message: string }>
}

export interface HelloMessage {
  t: 'hello'
  protoMajor: number
  protoMinor: number
  caps: SessionCapability[]
  node: NodeId
  /** Signed NodeDelegation. Absent only on an enrollment connection. */
  delegation?: Signed
  /** Signed Roster of the node's owner. */
  roster?: Signed
  /** Signed RoutesRecord. */
  routes?: Signed
  /** Sender clock, ms, for offset measurement. */
  now: number
}
export interface HelloAckMessage {
  t: 'helloAck'
  protoMinor: number
  caps: SessionCapability[]
  now: number
}
export interface PingMessage {
  t: 'ping'
  n: number
  now: number
}
export interface PongMessage {
  t: 'pong'
  n: number
  now: number
}
export interface GoAwayMessage {
  t: 'goAway'
  error: WireError
}
export interface ErrorMessage {
  t: 'error'
  re?: string
  error: WireError
}

export interface SubscribeMessage {
  t: 'subscribe'
  stream: StreamId
  after: StreamHead
}
export interface SubscribedMessage {
  t: 'subscribed'
  stream: StreamId
  head: StreamHead
  replayThrough: number
}
export interface RecordHeader {
  seq: number
  epoch: number
  recvTs: number
}
/** Parts: for each record, envelope bytes then signature bytes. */
export interface EventsMessage {
  t: 'events'
  stream: StreamId
  records: RecordHeader[]
  replay: boolean
  parts: number[]
}
export interface CaughtUpMessage {
  t: 'caughtUp'
  stream: StreamId
}
export interface SnapshotRequiredMessage {
  t: 'snapshotRequired'
  stream: StreamId
  reason: SnapshotReason
  head: StreamHead
}
export interface SnapshotGetMessage {
  t: 'snapshot.get'
  stream: StreamId
}
/** Parts: as in `events`. The final chunk carries `done`. */
export interface SnapshotChunkMessage {
  t: 'snapshot.chunk'
  stream: StreamId
  epoch: number
  throughSeq: number
  records: RecordHeader[]
  done: boolean
  parts: number[]
}
export interface UnsubscribeMessage {
  t: 'unsubscribe'
  stream: StreamId
}
export interface MetaHeadGetMessage {
  t: 'metaHead.get'
  stream: StreamId
  n: number
}
export interface MetaHeadMessage {
  t: 'metaHead'
  stream: StreamId
  n: number
  head: StreamHead
  now: number
}

/** Read-only proof queries on an authenticated, current Space authority connection. */
export interface SpaceDiscoveryGetMessage {
  t: 'space.discovery.get'
  n: number
  space: SpaceId
  stream: StreamId
  metaHead: StreamHead
}
export interface SpaceStreamDiscoveryProof {
  descriptor: StreamDescriptor
  metaHead: StreamHead
  head: StreamHead
  parentOpenEvent: StoredRecord
  controllerEvents: StoredRecord[]
}
/** Parts: exact parent opening envelope/signature, then each signed control envelope/signature. */
export type SpaceDiscoveryResultMessage =
  | {
      t: 'space.discovery.result'
      n: number
      space: SpaceId
      stream: StreamId
      metaHead: StreamHead
      descriptor: StreamDescriptor
      head: StreamHead
      parent: RecordHeader
      controls: RecordHeader[]
      parts: number[]
    }
  | {
      t: 'space.discovery.result'
      n: number
      space: SpaceId
      stream: StreamId
      metaHead: StreamHead
      error: WireError
    }
export interface SpaceIdentityGetMessage {
  t: 'space.identity.get'
  n: number
  space: SpaceId
  user: UserId
  metaHead: StreamHead
}
/** Current Space-scoped evidence only; never authorizes global pin/roster adoption. */
export type SpaceIdentityResultMessage =
  | {
      t: 'space.identity.result'
      n: number
      space: SpaceId
      user: UserId
      metaHead: StreamHead
      roster: Signed
    }
  | {
      t: 'space.identity.result'
      n: number
      space: SpaceId
      user: UserId
      metaHead: StreamHead
      error: WireError
    }
export interface SpaceProofCancelMessage {
  t: 'space.proof.cancel'
  n: number
}

/** Parts: envelope bytes, signature bytes. */
export interface AppendMessage {
  t: 'append'
  stream: StreamId
  id: EventId
  parts: [number, number]
}
export type AppendResultMessage =
  | { t: 'appendResult'; stream: StreamId; id: EventId; epoch: number; seq: number; recvTs: number }
  | { t: 'appendResult'; stream: StreamId; id: EventId; error: WireError }

export interface BlobPutBeginMessage {
  t: 'blob.put.begin'
  stream: StreamId
  blob: BlobId
  bytes: number
  sealed: boolean
}
/** Parts: one chunk. */
export interface BlobChunkMessage {
  t: 'blob.chunk'
  blob: BlobId
  offset: number
  parts: [number]
}
export interface BlobPutEndMessage {
  t: 'blob.put.end'
  blob: BlobId
}
export type BlobPutResultMessage = { t: 'blob.put.result'; blob: BlobId; error?: WireError }
export interface BlobGetMessage {
  t: 'blob.get'
  stream: StreamId
  blob: BlobId
  offset: number
}
export interface BlobEndMessage {
  t: 'blob.end'
  blob: BlobId
  error?: WireError
}

export interface RpcRequestMessage {
  t: 'rpc.request'
  id: RpcId
  method: string
  params: unknown
  idem?: string
  deadlineMs: number
}
export interface RpcProgressMessage {
  t: 'rpc.progress'
  id: RpcId
  data: unknown
}
/** Blob lookup carries the authorized stream and signed event reference. */
export interface RpcArtifactRef {
  stream: StreamId
  event: EventId
  blob: BlobId
}

export type RpcResultMessage =
  | { t: 'rpc.result'; id: RpcId; result: unknown; blob?: RpcArtifactRef }
  | { t: 'rpc.result'; id: RpcId; error: WireError }
export interface RpcCancelMessage {
  t: 'rpc.cancel'
  id: RpcId
}
/** Ask for the result of a request that finished while disconnected. */
export interface RpcResultGetMessage {
  t: 'rpc.result.get'
  id: RpcId
}

export type PresenceState = 'idle' | 'working' | 'workingPrivate'
/** Ephemeral. `sig` is over the UTF-8 JSON of the message without `sig`, by the bot or node key. */
export interface PresenceMessage {
  t: 'presence'
  stream: StreamId
  subject: BotId | NodeId
  /** Strictly increasing per subject key; receivers drop anything not newer. */
  counter: number
  ts: number
  state: PresenceState
  activity?: string
  sig: Base64Url
}
export interface EphemeralMessage {
  t: 'ephemeral'
  stream: StreamId
  kind: 'typing' | 'delta'
  data: unknown
}

export interface RevokedMessage {
  t: 'revoked'
  subject: NodeId | BotId
}
export interface RosterUpdateMessage {
  t: 'rosterUpdate'
  roster: Signed
}

export interface EnrollRequestMessage {
  t: 'enroll.request'
  invite: InviteId
  node: NodeId
  keys: NodePublicKeys
  name: string
  /** HMAC-SHA256(proofKey, exporter ‖ inviteId ‖ SHA-256(request without proof)), base64url. */
  proof: Base64Url
}
export type EnrollResultMessage =
  | { t: 'enroll.result'; delegation: Signed; roster: Signed }
  | { t: 'enroll.result'; error: WireError }

/** Different-user join, allowed only in the invite-bound quarantined session. */
export interface SpaceJoinRequestMessage {
  t: 'space.join.request'
  invite: InviteId
  space: SpaceId
  user: UserId
  rootKey: Base64Url
  node: NodeId
  delegation: Signed
  roster: Signed
  name: string
  /** HMAC of the canonical proof-free request bound to the space-join TLS exporter. */
  proof: Base64Url
}

/** Success parts contain the exact host-signed member.joined envelope then its signature. */
export type SpaceJoinResultMessage =
  | {
      t: 'space.join.result'
      space: SpaceId
      descriptor: Signed
      member: RecordHeader
      parts: [number, number]
    }
  | { t: 'space.join.result'; space: SpaceId; error: WireError }

export type WireMessage =
  | HelloMessage
  | HelloAckMessage
  | PingMessage
  | PongMessage
  | GoAwayMessage
  | ErrorMessage
  | SubscribeMessage
  | SubscribedMessage
  | EventsMessage
  | CaughtUpMessage
  | SnapshotRequiredMessage
  | SnapshotGetMessage
  | SnapshotChunkMessage
  | UnsubscribeMessage
  | MetaHeadGetMessage
  | MetaHeadMessage
  | AppendMessage
  | AppendResultMessage
  | BlobPutBeginMessage
  | BlobChunkMessage
  | BlobPutEndMessage
  | BlobPutResultMessage
  | BlobGetMessage
  | BlobEndMessage
  | RpcRequestMessage
  | RpcProgressMessage
  | RpcResultMessage
  | RpcCancelMessage
  | RpcResultGetMessage
  | PresenceMessage
  | EphemeralMessage
  | RevokedMessage
  | RosterUpdateMessage
  | EnrollRequestMessage
  | EnrollResultMessage
  | SpaceJoinRequestMessage
  | SpaceJoinResultMessage
  | SpaceDiscoveryGetMessage
  | SpaceDiscoveryResultMessage
  | SpaceIdentityGetMessage
  | SpaceIdentityResultMessage
  | SpaceProofCancelMessage

export type WireMessageType = WireMessage['t']

/** Which lane a message type travels on. Bulk never delays control. */
export const BULK_MESSAGE_TYPES: ReadonlySet<WireMessageType> = new Set<WireMessageType>([
  'snapshot.chunk',
  'blob.chunk',
  'space.discovery.result'
])

/** Replayed `events` batches go on bulk; live ones on control. */
export function laneFor(message: WireMessage): Lane {
  if (message.t === 'events') return message.replay ? 'bulk' : 'control'
  return BULK_MESSAGE_TYPES.has(message.t) ? 'bulk' : 'control'
}
