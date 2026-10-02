import type { NodeCapability } from './capabilities'
import type { BotId, NodeId, RpcId, SpaceId, StreamId, UserId } from './ids'

export const STREAM_KINDS = ['node.thread', 'node.artifact', 'space.meta', 'space.channel', 'space.thread', 'space.private'] as const
export type StreamKind = (typeof STREAM_KINDS)[number]

export interface StreamDescriptor {
  id: StreamId
  kind: StreamKind
  /** The single node that assigns sequence numbers. */
  authority: NodeId
  /** Present for every `space.*` stream. */
  space?: SpaceId
  /** `space.thread` and `space.private` hang off a parent channel or thread. */
  parent?: StreamId
  /** Explicit readers of a `space.private` stream. Other kinds follow current membership. */
  participants?: Array<UserId | BotId>
  /** Required only for node.artifact: immutable request-bound authorization scope. */
  artifact?: { user: UserId; caller: NodeId; rpc: RpcId; method: string; capability: NodeCapability }
  createdAt: number
}

/** Position of the last record of a durably stored, gap-free prefix. `seq` 0 means nothing yet. */
export interface Cursor {
  stream: StreamId
  epoch: number
  seq: number
}

export interface StreamHead {
  epoch: number
  seq: number
}

/** A record as stored and served by the authority. */
export interface StoredRecord {
  seq: number
  epoch: number
  /** Authority receive time, ms. */
  recvTs: number
  /** Exact signed bytes of the envelope. */
  envelope: Uint8Array
  /** Detached Ed25519 signature over `envelope`. */
  sig: Uint8Array
}

export type SnapshotReason = 'cursorTooOld' | 'cursorAhead' | 'epochChanged' | 'gapOverBudget'
