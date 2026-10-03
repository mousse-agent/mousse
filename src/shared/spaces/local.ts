import type { Envelope, EventId, MemberRecord, NetErrorCode, SpaceId, StreamHead, StreamId, UserId } from '../net'

export const SPACES_LOCAL_CAPABILITY = 'net.v1'
export const SPACES_LOCAL_METHODS = ['spaces.create','spaces.invite','spaces.join','spaces.list','spaces.channels','spaces.post','spaces.tail','spaces.members','spaces.leave','spaces.outbox'] as const
export type SpacesLocalMethod = typeof SPACES_LOCAL_METHODS[number]
export interface SpacesLocalParams {
  'spaces.create': { name: string; channelName?: string }
  'spaces.invite': { space: SpaceId; role?: 'member'|'admin'; uses?: number; ttlMs?: number; joiner?: UserId }
  'spaces.join': { invite: string; name?: string }
  'spaces.list': Record<string, never>
  'spaces.channels': { space: SpaceId; name?: string }
  'spaces.post': { stream: StreamId; text: string }
  'spaces.tail': { stream: StreamId; after?: StreamHead; limit?: number }
  'spaces.members': { space: SpaceId }
  'spaces.leave': { space: SpaceId }
  'spaces.outbox': { stream: StreamId; id?: EventId; after?: number; limit?: number }
}
export interface SpaceLocalDelivery { id: EventId; stream: StreamId; state: 'pending'|'unknown'|'sent'|'failed'; attempts: number; createdAt: number; position?: StreamHead; error?: NetErrorCode }
export interface SpaceLocalSummary { space: SpaceId; name: string; host: boolean; offline: boolean; readonly: boolean; member: boolean; leave?: SpaceLocalDelivery; error?: NetErrorCode }
export interface SpaceLocalChannel { stream: StreamId; name: string; archived: boolean }
export interface SpaceLocalRecord { epoch: number; seq: number; recvTs: number; envelope: Envelope }
export interface SpaceLocalTail { stream: StreamId; head: StreamHead; cursor: StreamHead; records: SpaceLocalRecord[]; done: boolean; offline: boolean; readonly: boolean }
export interface SpacesLocalResults {
  'spaces.create': { space: SpaceId; meta: StreamId; channel: StreamId }
  'spaces.invite': { invite: string; inviteId: string; expiresAt: number }
  'spaces.join': SpaceLocalSummary
  'spaces.list': { spaces: SpaceLocalSummary[] }
  'spaces.channels': { channels: SpaceLocalChannel[]; created?: StreamId }
  'spaces.post': SpaceLocalDelivery
  'spaces.tail': SpaceLocalTail
  'spaces.members': { members: MemberRecord[] }
  'spaces.leave': SpaceLocalDelivery
  'spaces.outbox': { entries: SpaceLocalDelivery[]; total: number; nextAfter?: number }
}
