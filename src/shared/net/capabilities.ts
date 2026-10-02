/** What a node of the same user may do on another node over Bridge. */
export const NODE_CAPABILITIES = ['read', 'chat', 'write', 'terminal', 'settings'] as const
export type NodeCapability = (typeof NODE_CAPABILITIES)[number]
export const DEFAULT_NODE_CAPABILITIES: readonly NodeCapability[] = ['read', 'chat', 'write']

export const SPACE_ROLES = ['owner', 'admin', 'member'] as const
export type SpaceRole = (typeof SPACE_ROLES)[number]

/**
 * Bot permission profiles. Only combinations the runtime can enforce exist:
 * - chat: no tools.
 * - reader: read-only file and search tools inside one bound project root.
 * - operator: the owner's normal tool set; steerable by the owner only.
 */
export const BOT_PROFILES = ['chat', 'reader', 'operator'] as const
export type BotProfile = (typeof BOT_PROFILES)[number]

export type BotSteerPolicy =
  | { kind: 'owner' }
  | { kind: 'roles'; roles: SpaceRole[] }
  | { kind: 'everyone' }
export type BotVisibility = 'public' | 'private'

export interface BotAudiencePolicy {
  steer: BotSteerPolicy
  visibility: BotVisibility
}

/** `operator` bots are owner-steered in v1; any other steer policy is rejected. */
export function isAllowedBotPolicy(profile: BotProfile, policy: BotAudiencePolicy): boolean {
  return profile !== 'operator' || policy.steer.kind === 'owner'
}

/** Optional session features negotiated in `hello`. */
export const SESSION_CAPABILITIES = ['streams.v1', 'blobs.v1', 'rpc.v1', 'presence.v1', 'enroll.v1', 'relay.v1'] as const
export type SessionCapability = (typeof SESSION_CAPABILITIES)[number]
