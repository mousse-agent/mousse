import type { QuietHours } from '../../settings'
export type { QuietHours } from '../../settings'
import type { TellMe } from '../../types'
export interface BotTellingSettings { tellMe?: TellMe; canWakeMe?: boolean }
export interface BotTellingPreferences extends BotTellingSettings { quietHours?: QuietHours }
export interface TellingChange extends BotTellingSettings {
  quietHours?: QuietHours | 'off'
  schedules?: boolean
  scheduleId?: string
}
export function readBotTelling(json?: string | null): BotTellingSettings {
  try { return json ? JSON.parse(json) : {} } catch { return {} }
}
export function tellingLine(settings: BotTellingSettings, quiet?: QuietHours, clock: (time: string) => string = time => time): string | undefined {
  const levels: Record<TellMe, string> = { needs_you: 'when it needs you', look: 'when something is worth a look', fyi: 'with updates', every: 'about everything' }
  const parts = [settings.tellMe ? `Tells you ${levels[settings.tellMe]}` : '', quiet ? `Quiet ${clock(quiet.from)} to ${clock(quiet.to)}` : '', settings.canWakeMe === true ? 'can wake you' : settings.canWakeMe === false ? 'cannot wake you' : ''].filter(Boolean)
  return parts.length ? parts.join(' · ') : undefined
}

const TELL_ME_WORDS: Record<TellMe, string> = { needs_you: 'when it needs you', look: 'when something is worth a look', fyi: 'with updates', every: 'about everything' }
const CLOCK = /^(?:[01]\d|2[0-3]):[0-5]\d$/

/**
 * What a `telling_set` call would set, in plain words for an ask's card ("It would set: tell you when something is worth
 * a look, quiet hours 22:00 to 07:00."), or undefined when its arguments name nothing it can say. The arguments come from
 * the model unchecked, so anything it doesn't recognise is left out.
 */
export function tellingChangeText(args: unknown): string | undefined {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return undefined
  const change = args as Record<string, unknown>
  const parts: string[] = []
  if (typeof change.tellMe === 'string' && change.tellMe in TELL_ME_WORDS) {
    parts.push(`tell you ${TELL_ME_WORDS[change.tellMe as TellMe]}${change.schedules === true ? ', its automations too' : ''}`)
  }
  const quiet = change.quietHours
  if (quiet === 'off') parts.push('no quiet hours')
  else if (quiet && typeof quiet === 'object' && typeof (quiet as QuietHours).from === 'string' && typeof (quiet as QuietHours).to === 'string' &&
    CLOCK.test((quiet as QuietHours).from) && CLOCK.test((quiet as QuietHours).to)) parts.push(`quiet hours ${(quiet as QuietHours).from} to ${(quiet as QuietHours).to}`)
  // With scheduleId only that automation's exception changes (`setTelling`), never the bot's own.
  const who = typeof change.scheduleId === 'string' && change.scheduleId ? 'one of its automations' : 'it'
  if (change.canWakeMe === true) parts.push(`${who} can wake you`)
  else if (change.canWakeMe === false) parts.push(`${who} can’t wake you`)
  return parts.length ? `It would set: ${parts.join(', ')}.` : undefined
}
