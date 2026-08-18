import type { ChatMode } from './types'
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
