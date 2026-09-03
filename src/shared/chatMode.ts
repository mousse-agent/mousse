import type { ChatMessage, ChatMode } from './types'
import { DEFAULT_CHAT_MODE } from './types'

export type { ChatMode } from './types'

export function normalizeChatMode(mode?: ChatMode): ChatMode {
  if (!mode) return DEFAULT_CHAT_MODE
  if (typeof mode === 'string') return mode
  if (typeof mode === 'object' && mode.type === 'skill' && mode.skillId) return mode
  return DEFAULT_CHAT_MODE
}

export function chatModeEquals(a: ChatMode, b: ChatMode): boolean {
  const left = normalizeChatMode(a)
  const right = normalizeChatMode(b)
  if (typeof left === 'object' && typeof right === 'object') {
    return left.skillId === right.skillId
  }
  return left === right
}

export function getChatModeLabel(mode: ChatMode, skillName?: string): string {
  const normalized = normalizeChatMode(mode)
  if (typeof normalized === 'string') {
    return normalized.charAt(0).toUpperCase() + normalized.slice(1)
  }
  return skillName ?? 'Skill'
}

export function allowsOrchestrationActions(mode: ChatMode): boolean {
  const normalized = normalizeChatMode(mode)
  if (typeof normalized === 'string') return normalized === 'agent'
  return false
}

export function getSkillIdFromMode(mode: ChatMode): string | undefined {
  const normalized = normalizeChatMode(mode)
  return typeof normalized === 'object' ? normalized.skillId : undefined
}

export function isOrchestrationAction(action: { type: string }): boolean {
  return action.type === 'spawn_agents' || action.type === 'complete_task'
}

export function filterActionsForMode<T extends { type: string }>(actions: T[], mode: ChatMode): T[] {
  if (allowsOrchestrationActions(mode)) return actions
  return actions.filter((action) => !isOrchestrationAction(action))
}

/** Human-readable mode name for silent mode-change notices (includes skill id). */
export function describeChatMode(mode: ChatMode): string {
  const normalized = normalizeChatMode(mode)
  if (typeof normalized === 'string') {
    return normalized.charAt(0).toUpperCase() + normalized.slice(1)
  }
  return `Skill "${normalized.skillId}"`
}

/**
 * Silent model-context notice for a mid-chat mode switch. Persisted as a
 * hidden user message (never rendered) so the agent sees the transition
 * even though the transcript UI shows no marker.
 */
export function buildModeChangeNotice(from: ChatMode, to: ChatMode): string {
  return (
    `[System: Chat mode changed from ${describeChatMode(from)} to ${describeChatMode(to)}. ` +
    `Adjust your behavior to the new mode's capabilities and constraints for the rest of this turn. ` +
    `The current user message follows.]`
  )
}

/**
 * Most recent chat mode used in a transcript. Returns undefined for a brand
 * new chat (no user turns yet). Visible user messages without a stored mode
 * predate mode tracking and are treated as the default agent mode. Hidden
 * internal wakes carry no mode and are skipped — only visible user turns and
 * silent mode-change notices advance the tracked mode.
 */
export function getLastUserChatMode(messages: Pick<ChatMessage, 'role' | 'hidden' | 'mode'>[]): ChatMode | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (message.role !== 'user') continue
    if (message.mode !== undefined) return normalizeChatMode(message.mode)
    if (!message.hidden) return DEFAULT_CHAT_MODE
  }
  return undefined
}
