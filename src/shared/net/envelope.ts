import type { BotAudiencePolicy, BotProfile, SpaceRole } from './capabilities'
import type { BlobId, BotId, EventId, ExecutionId, NodeId, StreamId, UserId } from './ids'
import type { Base64Url, Signed } from './identity'

export interface EnvelopeAuthor {
  user?: UserId
  bot?: BotId
  node: NodeId
  keyEpoch: number
}

/** The author's applied `space.meta` position. Required in every `space.*` stream. */
export interface EnvelopeAuthRef {
  metaSeq: number
  metaEpoch: number
}

export interface EnvelopeRefs {
  replyTo?: EventId
  thread?: StreamId
  mentions?: BotId[]
  execution?: ExecutionId
  /** The event a status or run event is about. */
  subject?: EventId
}

export interface EnvelopeBlobRef {
  id: BlobId
  bytes: number
  mime: string
  /** True when the blob is encrypted with the stream's content key. */
  sealed?: boolean
}

/** Payload of a `space.private` stream: AES-256-GCM under the stream content key. */
export interface SealedBody {
  keyEpoch: number
  nonce: Base64Url
  ct: Base64Url
}

/**
 * The signed unit. The detached signature covers the exact UTF-8 bytes of this
 * object as transmitted; receivers verify those bytes and never re-serialize.
 */
export interface Envelope<T extends EventType = EventType> {
  v: 1
  id: EventId
  stream: StreamId
  type: T
  /** Sender's claim. Readers decide criticality from their own registry (see isCritical). */
  crit: boolean
  author: EnvelopeAuthor
  /** Author clock, ms. */
  ts: number
  auth?: EnvelopeAuthRef
  refs?: EnvelopeRefs
  body?: T extends keyof EventBodies ? EventBodies[T] : unknown
  sealed?: SealedBody
  blobs?: EnvelopeBlobRef[]
  /** Reserved for a future provenance-carrying handoff design. Unused in v1. */
  origin?: unknown
}

export interface MemberRecord {
  user: UserId
  rootKey: Base64Url
  role: SpaceRole
  displayName: string
}

export interface BotRecord {
  bot: BotId
  owner: UserId
  /** Signed BotDelegation. */
  delegation: Signed
  displayName: string
  profile: BotProfile
  policy: BotAudiencePolicy
}

export interface SpaceSettings {
  name: string
  membersMayAddBots: boolean
  maxBlobBytes: number
  /** Nodes below this protocol minor can read but not write. */
  minProtoMinor: number
}

export type BotRunFailure = { code: string; message: string }

/** Body shapes per event type. Types absent here carry no body. */
export interface EventBodies {
  'space.created': { descriptor: Signed; settings: SpaceSettings; owner: MemberRecord }
  'space.descriptor': { descriptor: Signed }
  'space.frozen': { reason: string }
  'settings.changed': { settings: Partial<SpaceSettings> }
  'member.joined': { member: MemberRecord; invite?: string }
  'member.left': { user: UserId }
  'member.removed': { user: UserId }
  'member.roleChanged': { user: UserId; role: SpaceRole }
  'bot.added': { record: BotRecord }
  'bot.removed': { bot: BotId }
  'bot.policyChanged': { bot: BotId; profile?: BotProfile; policy?: BotAudiencePolicy }
  'channel.created': { stream: StreamId; name: string }
  'channel.renamed': { stream: StreamId; name: string }
  'channel.archived': { stream: StreamId }
  'message.posted': { text: string }
  'message.edited': { text: string }
  'message.deleted': Record<string, never>
  'thread.opened': { stream: StreamId; title: string; private: boolean }
  'thread.closed': { stream: StreamId }
  'participants.changed': {
    participants: Array<UserId | BotId>
    keyEpoch: number
    /** Content key wrapped to each participant node's agreement key. */
    wrapped: Array<{ node: NodeId; ephemeral: Base64Url; nonce: Base64Url; ct: Base64Url }>
  }
  'bot.run.accepted': { title: string }
  'bot.run.progress': { text: string }
  'bot.run.toolSummary': { tool: string; summary: string }
  'bot.run.waitingApproval': { summary: string }
  'bot.run.completed': { text: string }
  'bot.run.failed': BotRunFailure
  'bot.run.cancelled': { by: UserId }
  'bot.run.uncertain': { summary: string }
  'bot.run.expired': Record<string, never>
  'bot.permission.requested': { requester: UserId; summary: string; expiresAt: number }
  'bot.permission.granted': { request: EventId }
  'bot.permission.denied': { request: EventId }
}

/** Events that change who may do or read what. Unknown members of this family are critical too. */
export const META_EVENT_TYPES = [
  'space.created',
  'space.descriptor',
  'space.frozen',
  'settings.changed',
  'member.joined',
  'member.left',
  'member.removed',
  'member.roleChanged',
  'bot.added',
  'bot.removed',
  'bot.policyChanged',
  'channel.created',
  'channel.renamed',
  'channel.archived'
] as const
export type MetaEventType = (typeof META_EVENT_TYPES)[number]

export const CONTENT_EVENT_TYPES = [
  'message.posted',
  'message.edited',
  'message.deleted',
  'thread.opened',
  'thread.closed',
  'participants.changed',
  'bot.run.accepted',
  'bot.run.progress',
  'bot.run.toolSummary',
  'bot.run.waitingApproval',
  'bot.run.completed',
  'bot.run.failed',
  'bot.run.cancelled',
  'bot.run.uncertain',
  'bot.run.expired',
  'bot.permission.requested',
  'bot.permission.granted',
  'bot.permission.denied'
] as const
export type ContentEventType = (typeof CONTENT_EVENT_TYPES)[number]

export type KnownEventType = MetaEventType | ContentEventType
/** Unknown types must survive decoding, so the wire type is any string. */
export type EventType = KnownEventType | (string & {})

const KNOWN = new Set<string>([...META_EVENT_TYPES, ...CONTENT_EVENT_TYPES])
const CRITICAL = new Set<string>([...META_EVENT_TYPES, 'participants.changed'])

export function isKnownEventType(type: string): type is KnownEventType {
  return KNOWN.has(type)
}

/**
 * Whether a reader must understand this event to stay safe. Decided by the
 * reader: every event in a `space.meta` stream is critical whatever its flag,
 * known critical types are critical whatever their flag, and an unknown type
 * is critical if the sender says so.
 */
export function isCritical(envelope: Pick<Envelope, 'type' | 'crit'>, inMetaStream: boolean): boolean {
  if (inMetaStream || CRITICAL.has(envelope.type)) return true
  return !KNOWN.has(envelope.type) && envelope.crit === true
}

/** Ephemeral messages are relayed and never stored. */
export const EPHEMERAL_TYPES = ['presence.heartbeat', 'presence.activity', 'typing', 'delta'] as const
export type EphemeralType = (typeof EPHEMERAL_TYPES)[number]
