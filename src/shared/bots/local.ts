import type {
  Base64Url,
  BotAudiencePolicy,
  BotId,
  BotProfile,
  EventId,
  NodeId,
  RpcId,
  SpaceId,
  StreamId,
  UserId
} from '../net'
import type { SpaceLocalDelivery } from '../spaces/local'

export const BOTS_LOCAL_CAPABILITY = 'net.v1'
export const BOTS_LOCAL_METHODS = [
  'bots.add',
  'bots.list',
  'bots.configure',
  'bots.qualify',
  'bots.stop',
  'bots.resume',
  'bots.grant',
  'bots.presence'
] as const
export type BotsLocalMethod = (typeof BOTS_LOCAL_METHODS)[number]
export interface BotLocalSelection {
  space: SpaceId
  bot: BotId
}
export interface BotLocalConfiguration extends BotLocalSelection {
  adapter: string
  profile: BotProfile
  definitionRevision: string
  profileDigest: Base64Url
  dailyBudgetUnits: number
  runCeilingUnits: number
  maxConcurrent: number
  runsPerMemberHour: number
  projectId?: string
}
export interface BotLocalSummary extends BotLocalConfiguration {
  owner: UserId
  hostNode: NodeId
  placementEpoch: number
  activationHostTs: number
  revision: number
  stopped: boolean
  qualified: boolean
}
export interface BotsLocalParams {
  'bots.add': {
    id: RpcId
    space: SpaceId
    name: string
    profile: 'chat' | 'reader'
    policy: BotAudiencePolicy
  }
  'bots.list': { after?: BotLocalSelection; limit?: number }
  'bots.configure': BotLocalConfiguration
  'bots.qualify': BotLocalSelection & { definitionRevision: string; profileDigest: Base64Url }
  'bots.stop': BotLocalSelection
  'bots.resume': BotLocalSelection
  'bots.grant': { stream: StreamId; request: EventId; approved: boolean }
  'bots.presence': BotLocalSelection & { stream: StreamId }
}
export interface BotsLocalResults {
  'bots.add': {
    id: RpcId
    space: SpaceId
    bot: BotId
    state: 'pending' | 'unknown' | 'registered' | 'failed'
    delivery?: SpaceLocalDelivery
  }
  'bots.list': { bots: BotLocalSummary[]; nextAfter?: BotLocalSelection }
  'bots.configure': BotLocalSummary
  'bots.qualify': BotLocalSummary
  'bots.stop': BotLocalSummary
  'bots.resume': BotLocalSummary
  'bots.grant': SpaceLocalDelivery
  'bots.presence': {
    space: SpaceId
    bot: BotId
    stream: StreamId
    state: 'idle' | 'working' | 'workingPrivate' | 'reconnecting' | 'offline'
    receivedAtMonotonic?: number
  }
}
