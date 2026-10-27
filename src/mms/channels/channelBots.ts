import { randomInt } from 'crypto'
import type { BotChannelReplyTo } from '../../shared/bots/personal/definition'
import type { ChannelOwner, ChannelPlatform, ChannelPlatformConfig, ChannelSession } from '../../shared/types'
import type { InboundChannelMessage } from './types'

/**
 * Personal bots in channels (PR 6 §6). A bot answers only the platform's confirmed owner, in a
 * direct message; everyone else is refused and nothing is activated. The owner is confirmed only
 * through Settings → Channels → "This is me": a one-time code sent with `/owner <code>`, then a
 * confirmation in the desktop app. It is never inferred from allowed users, pairing or the home chat.
 */

/** What the channel bot path needs from the profile's bot engine. */
export interface ChannelBots {
  findByName(name: string): { id: string; name: string } | undefined
  activateFromChannel(input: { botId: string; input: string; clientRequestId: string; replyTo: BotChannelReplyTo }): Promise<unknown>
  /** What the activation tells its chat now, claimed once per state, and only when `canSend`. */
  channelReply(activationId: string, options?: { canSend?: (replyTo: BotChannelReplyTo) => boolean }): { replyTo: BotChannelReplyTo; text: string } | undefined
  recentChannelActivations(): string[]
  /** Calls `listener` after every change of an activation; returns the unsubscribe. */
  onChanged(listener: (event: { activationId?: string }) => void): () => void
}

export const BOT_NOT_OWNER_REPLY = 'This bot only answers its owner. Bots for other people aren\'t available yet.'
export const BOT_NO_OWNER_REPLY = 'Confirm your account in Mousse first: Settings → Channels → "This is me".'

/**
 * Who an inbound message comes from, for a bot: `owner` only when the platform has a confirmed
 * owner, the chat is a direct message, and both the session's and the message's user are that
 * owner. Groups, other users (also under `allowAllUsers` or pairing), a missing owner and a
 * session without a user are all `others`. Checked again on every message.
 */
export function channelAudience(platform: ChannelPlatformConfig | undefined, session: ChannelSession | undefined, message: InboundChannelMessage): 'owner' | 'others' {
  const owner = platform?.owner
  if (!owner?.userId || !session) return 'others'
  if (session.chatType !== 'dm' || message.chatType !== 'dm') return 'others'
  if (session.userId === undefined || session.userId !== owner.userId) return 'others'
  return message.userId === owner.userId ? 'owner' : 'others'
}

const OWNER_CODE_TTL_MS = 10 * 60_000

interface OwnerClaim {
  code: string
  expiresAt: number
  /** Set by the one `/owner` attempt the code allows. */
  attempted: boolean
  claimant?: { userId: string; displayName: string }
}

/**
 * "This is me" (PR 6 §6): a 6-digit code valid for 10 minutes and one attempt. The account that
 * sends the right code is shown in the desktop app, which asks "Is this your account?"; only that
 * confirmation stores the owner. Claims live in memory: a restart asks for a new code.
 */
export class ChannelOwnerClaims {
  private readonly claims = new Map<ChannelPlatform, OwnerClaim>()

  constructor(private readonly clock: () => number = Date.now) {}

  start(platform: ChannelPlatform): { code: string; expiresAt: string } {
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
    const expiresAt = this.clock() + OWNER_CODE_TTL_MS
    this.claims.set(platform, { code, expiresAt, attempted: false })
    return { code, expiresAt: new Date(expiresAt).toISOString() }
  }

  private live(platform: ChannelPlatform): OwnerClaim | undefined {
    const claim = this.claims.get(platform)
    if (claim && claim.expiresAt <= this.clock()) {
      this.claims.delete(platform)
      return undefined
    }
    return claim
  }

  /** `/owner <code>` from a direct message: the one attempt the code allows. */
  receive(message: InboundChannelMessage, code: string): 'received' | 'invalid' {
    const claim = this.live(message.platform)
    if (!claim || claim.attempted || message.chatType !== 'dm') return 'invalid'
    claim.attempted = true
    if (code.trim() !== claim.code) return 'invalid'
    claim.claimant = { userId: message.userId, displayName: message.userName?.trim() || message.userId }
    return 'received'
  }

  status(platform: ChannelPlatform): { expiresAt: string; attempted: boolean; claimant?: { userId: string; displayName: string } } | null {
    const claim = this.live(platform)
    return claim ? { expiresAt: new Date(claim.expiresAt).toISOString(), attempted: claim.attempted, ...(claim.claimant ? { claimant: { ...claim.claimant } } : {}) } : null
  }

  /** The owner to store, when `userId` is the account that sent the code; the claim ends either way. */
  confirm(platform: ChannelPlatform, userId: string): ChannelOwner | undefined {
    const claim = this.live(platform)
    this.claims.delete(platform)
    if (!claim?.claimant || claim.claimant.userId !== userId) return undefined
    return { userId: claim.claimant.userId, displayName: claim.claimant.displayName, confirmedAt: new Date(this.clock()).toISOString() }
  }

  cancel(platform: ChannelPlatform): void {
    this.claims.delete(platform)
  }
}
