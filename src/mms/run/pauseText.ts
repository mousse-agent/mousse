import { formatPauseUntil, pauseProviderName, pauseWindowLabel } from '../../shared/pauseDisplay'
import type { RunPause } from './types'

// The wording helpers are shared with the app (the banner reads them too); re-exported so the daemon keeps one import.
export { formatPauseUntil, pauseProviderName, pauseWindowLabel }

/** The message of the continue turn that follows a usage-limit pause. Fixed: it carries no replay of the paused turn. */
export const CONTINUE_TEXT = 'Continue where you left off.'

/** What a pause without a timer tells the person to do: both ways on are real, the button and a message. */
export const MANUAL_CONTINUE_TEXT = 'Press Resume now or send a message to continue.'

/** The system line written into the thread when a run pauses. */
export function pausedLine(pause: Pick<RunPause, 'until' | 'estimated' | 'provider' | 'limitKind' | 'autoResume'>, nowMs: number = Date.now()): string {
  const provider = pauseProviderName(pause.provider)
  const window = pauseWindowLabel(pause.limitKind)
  const what = provider && window ? `${provider}'s ${window} limit was reached` : provider ? `${provider}'s usage limit was reached` : 'The usage limit was reached'
  const source = pause.estimated ? 'estimated' : provider ? `time reported by ${provider}` : 'time reported by the provider'
  const next = pause.autoResume ? 'The run continues by itself when it resets.' : MANUAL_CONTINUE_TEXT
  return `Paused until ${formatPauseUntil(pause.until, nowMs)}: ${what} (${source}). ${next}`
}
