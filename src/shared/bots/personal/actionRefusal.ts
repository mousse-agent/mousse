/** Application reasons carried as data on an existing conflict, never as new Net error codes. */
export const BOT_ACTION_REFUSAL_CODES = [
  'bot_action_work_ended', 'bot_action_owner_paused', 'bot_action_permission_changed', 'bot_action_disabled', 'bot_action_owner_removed', 'bot_action_binding_changed',
  'bot_action_schedule_changed', 'bot_action_expired', 'bot_action_withdrawn', 'bot_action_changed', 'bot_action_settled',
  'bot_action_gone', 'bot_action_paused', 'bot_action_unreachable', 'bot_action_too_large'
] as const
export type BotActionRefusalCode = (typeof BOT_ACTION_REFUSAL_CODES)[number]
export const isBotActionRefusalCode = (code: unknown): code is BotActionRefusalCode =>
  typeof code === 'string' && (BOT_ACTION_REFUSAL_CODES as readonly string[]).includes(code)
export interface BotActionRefusalNames { botName?: string; serverName?: string }

/** Both local chat and device clients use names they already have, never a network error's words. */
export function botActionRefusalText(code: BotActionRefusalCode, names: BotActionRefusalNames = {}): string {
  switch (code) {
    case 'bot_action_work_ended': return 'This work ended. Nothing was sent.'
    case 'bot_action_owner_paused': return 'This bot was paused, so nothing was sent.'
    case 'bot_action_permission_changed': return 'This tool or its permission changed, so nothing was sent.'
    case 'bot_action_disabled': return 'Withdrawn when asks first was turned off. Nothing was sent.'
    case 'bot_action_owner_removed': return 'You removed this request, so nothing was sent.'
    case 'bot_action_binding_changed': return 'This changed since you saw it. Nothing was sent.'
    case 'bot_action_schedule_changed': return 'This changed since you saw it. Nothing was sent.'
    case 'bot_action_expired': return 'This expired, so nothing was sent.'
    case 'bot_action_withdrawn': return 'No longer needed, so nothing was sent.'
    case 'bot_action_changed': return 'This changed since you saw it. Check it again before sending.'
    case 'bot_action_settled': return 'This was already answered.'
    case 'bot_action_gone': return "This can't be sent any more."
    case 'bot_action_paused': return `Resume ${names.botName || 'this bot'} to send this.`
    case 'bot_action_unreachable': return `${names.serverName || 'The service'} couldn't be reached. Nothing was sent. Try again when it is available.`
    case 'bot_action_too_large': return 'Open it on the computer to send.'
  }
}

/** Read only the application code. Old peers' plain conflicts have a truthful local fallback. */
export function botActionRefusal(error: unknown, names: BotActionRefusalNames = {}): { reason: string; text: string } | undefined {
  const value = error as { code?: unknown; details?: { reason?: unknown } } | null | undefined
  const code = isBotActionRefusalCode(value?.code) ? value.code : value?.code === 'conflict' ? value.details?.reason : undefined
  if (isBotActionRefusalCode(code)) return { reason: code, text: botActionRefusalText(code, names) }
  if (value?.code === 'conflict') return { reason: 'conflict', text: 'This could not be sent from here. Open it on the computer to see what happened.' }
  return undefined
}
