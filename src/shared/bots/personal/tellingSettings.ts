import type { TellMe } from '../../types'
export interface BotTellingSettings { tellMe?: TellMe; canWakeMe?: boolean }
export interface QuietHours { from: string; to: string }
export interface TellingChange extends BotTellingSettings {
  quietHours?: QuietHours | 'off'
  schedules?: boolean
  scheduleId?: string
}
export function validQuietHours(value: unknown): value is QuietHours {
  if (!value || typeof value !== 'object') return false
  const { from, to } = value as QuietHours
  const clock = /^(?:[01]\d|2[0-3]):[0-5]\d$/
  return typeof from === 'string' && typeof to === 'string' && clock.test(from) && clock.test(to) && from !== to
}
export function readBotTelling(json?: string | null): BotTellingSettings {
  try { return json ? JSON.parse(json) : {} } catch { return {} }
}
export function tellingLine(settings: BotTellingSettings, quiet?: QuietHours, locale?: string): string | undefined {
  const levels: Record<TellMe, string> = { needs_you: 'when it needs you', look: 'when something is worth a look', fyi: 'with updates', every: 'about everything' }
  const clock = (time: string): string => {
    const [hour, minute] = time.split(':').map(Number)
    return new Date(2000, 0, 1, hour, minute).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
  }
  const parts = [settings.tellMe ? `Tells you ${levels[settings.tellMe]}` : '', quiet ? `Quiet ${clock(quiet.from)} to ${clock(quiet.to)}` : '', settings.canWakeMe === true ? 'can wake you' : settings.canWakeMe === false ? 'cannot wake you' : ''].filter(Boolean)
  return parts.length ? parts.join(' · ') : undefined
}
