import type { RunPause } from './types'

/** The message of the continue turn that follows a usage-limit pause. Fixed: it carries no replay of the paused turn. */
export const CONTINUE_TEXT = 'Continue where you left off.'

const PROVIDER_NAMES: Readonly<Record<string, string>> = {
  claude: 'Claude',
  'claude-subscription': 'Claude',
  codex: 'Codex',
  pi: 'Pi'
}

/** The provider as a person reads it, or undefined when the limit named none. */
export function pauseProviderName(provider: string | undefined): string | undefined {
  if (!provider) return undefined
  return PROVIDER_NAMES[provider] ?? provider.charAt(0).toUpperCase() + provider.slice(1)
}

/** The window a provider named, in words: `five_hour` is "5-hour", `seven_day_opus` is "7-day Opus". */
export function pauseWindowLabel(limitKind: string | undefined): string | undefined {
  if (!limitKind) return undefined
  const words = limitKind.split(/[_\s-]+/).filter(Boolean)
  const counts: Record<string, string> = { five: '5', seven: '7', one: '1', thirty: '30' }
  if (words.length >= 2 && (words[1] === 'hour' || words[1] === 'day' || words[1] === 'week' || words[1] === 'month')) {
    const rest = words.slice(2).map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    return [`${counts[words[0]!] ?? words[0]}-${words[1]}`, ...rest].join(' ')
  }
  return words.join(' ')
}

/** When the limit resets, in the machine's local time; the date is added when it is not today. */
export function formatPauseUntil(iso: string, nowMs: number = Date.now()): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return iso
  const time = at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  const today = new Date(nowMs)
  const sameDay = at.getFullYear() === today.getFullYear() && at.getMonth() === today.getMonth() && at.getDate() === today.getDate()
  return sameDay ? time : `${at.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${time}`
}

/** The system line written into the thread when a run pauses. */
export function pausedLine(pause: Pick<RunPause, 'until' | 'estimated' | 'provider' | 'limitKind' | 'autoResume'>, nowMs: number = Date.now()): string {
  const provider = pauseProviderName(pause.provider)
  const window = pauseWindowLabel(pause.limitKind)
  const what = provider && window ? `${provider}'s ${window} limit was reached` : provider ? `${provider}'s usage limit was reached` : 'The usage limit was reached'
  const source = pause.estimated ? 'estimated' : provider ? `time reported by ${provider}` : 'time reported by the provider'
  const next = pause.autoResume ? 'The run continues by itself when it resets.' : 'Press Resume now when it resets.'
  return `Paused until ${formatPauseUntil(pause.until, nowMs)}: ${what} (${source}). ${next}`
}
