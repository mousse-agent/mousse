/**
 * What a node of the same user may do on another node over Bridge.
 *
 * `settings` is the signed grant for the routed thread API ("Works on threads" in the UI). It is
 * given to computers only. The name is the one the closed capability list of older peers and the
 * hosted relay already accept, so a delegation that carries it validates everywhere.
 */
export const NODE_CAPABILITIES = ['read', 'chat', 'write', 'terminal', 'settings'] as const
export type NodeCapability = (typeof NODE_CAPABILITIES)[number]
/** What a phone gets, and what an invite grants when it does not say it is for a computer. */
export const DEFAULT_NODE_CAPABILITIES: readonly NodeCapability[] = ['read', 'chat', 'write']
/** What a computer gets: the phone grant plus the routed thread API. */
export const COMPUTER_NODE_CAPABILITIES: readonly NodeCapability[] = [
  ...DEFAULT_NODE_CAPABILITIES,
  'settings'
]

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
  { kind: 'owner' } | { kind: 'roles'; roles: SpaceRole[] } | { kind: 'everyone' }
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
export const SESSION_CAPABILITIES = [
  'streams.v1',
  'blobs.v1',
  'rpc.v1',
  'presence.v1',
  'enroll.v1',
  'relay.v1',
  'space.discovery.v1',
  /** Editor tunnels: a byte stream to the peer's SSH server (`tunnel.*` messages and the tunnel lane). */
  'tunnel.v1'
] as const
export type SessionCapability = (typeof SESSION_CAPABILITIES)[number]
