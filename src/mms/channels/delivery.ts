import type { ChannelPlatform } from '../../shared/types'
import type { InboundChannelMessage } from './types'

export interface DeliveryTarget {
  platform: ChannelPlatform
  chatId?: string
  threadId?: string
  isOrigin: boolean
  isExplicit: boolean
}

const SILENCE_NARRATION =
  /^[\s*_~`]*\(?\s*(silent|silence|no\s+response|no\s+reply)\s*\.?\)?[\s*_~`]*$/i

export function isSilenceNarration(content: string | undefined): boolean {
  if (!content) return false
  const stripped = content.trim()
  if (!stripped || stripped.length > 64) return false
  if (/^[\s*_~`]*[\u{1F507}.\u2026]+[\s*_~`]*$/u.test(stripped)) return true
  return SILENCE_NARRATION.test(stripped)
}

export function parseDeliveryTarget(
  target: string,
  origin?: InboundChannelMessage
): DeliveryTarget {
  const trimmed = target.trim()
  const lower = trimmed.toLowerCase()

  if (lower === 'origin') {
    if (origin) {
      return {
        platform: origin.platform,
        chatId: origin.chatId,
        threadId: origin.threadId,
        isOrigin: true,
        isExplicit: true
      }
    }
    return { platform: 'webhook', isOrigin: true, isExplicit: false }
  }

  if (lower === 'local') {
    return { platform: 'webhook', isOrigin: false, isExplicit: false }
  }

  if (trimmed.includes(':')) {
    const parts = trimmed.split(':')
    const platform = parts[0]!.toLowerCase() as ChannelPlatform
    const chatId = parts[1]
    const threadId = parts[2]
    if (platform === 'telegram' || platform === 'discord' || platform === 'webhook') {
      return {
        platform,
        chatId,
        threadId,
        isOrigin: false,
        isExplicit: Boolean(chatId)
      }
    }
  }

  const platformOnly = lower as ChannelPlatform
  if (platformOnly === 'telegram' || platformOnly === 'discord' || platformOnly === 'webhook') {
    return { platform: platformOnly, isOrigin: false, isExplicit: false }
  }

  return { platform: 'webhook', isOrigin: false, isExplicit: false }
}

export function deliveryTargetToString(target: DeliveryTarget): string {
  if (target.isOrigin) return 'origin'
  if (target.chatId && target.threadId) {
    return `${target.platform}:${target.chatId}:${target.threadId}`
  }
  if (target.chatId) {
    return `${target.platform}:${target.chatId}`
  }
  return target.platform
}
