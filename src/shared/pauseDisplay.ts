/**
 * How a run paused by a usage limit is named to a person: the provider, the window that was hit and the
 * reset time. Shared by the daemon (the line it writes into the thread) and the app (the banner, the
 * thread list), so both say the same words.
 */

/** How the failure text and the pause name a provider whose limit was hit. */
export const PROVIDER_LABELS: Readonly<Record<string, string>> = { claude: 'Claude', 'claude-subscription': 'Claude', codex: 'Codex', anthropic: 'Anthropic', openai: 'OpenAI', 'openai-codex': 'ChatGPT' }

/** The provider as a person reads it, or undefined when the limit named none. */
export function pauseProviderName(provider: string | undefined): string | undefined {
  if (!provider) return undefined
  return PROVIDER_LABELS[provider] ?? provider
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

/**
 * Time left until a reset as "2h 15m", "3d 4h" or "40m"; undefined once it has passed or when the time is
 * not a date. Under a minute reads "under a minute".
 */
export function formatTimeUntil(iso: string, nowMs: number = Date.now()): string | undefined {
  const at = Date.parse(iso)
  if (!Number.isFinite(at) || at <= nowMs) return undefined
  const minutes = Math.floor((at - nowMs) / 60_000)
  if (minutes < 1) return 'under a minute'
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  const mins = minutes % 60
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`
  if (hours > 0) return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`
  return `${mins}m`
}
