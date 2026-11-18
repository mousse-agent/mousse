import type { Thread } from '../../shared/types'
import { profilePreferenceKey } from './profilePreferences'

/**
 * Which threads started by the owner's bots (`Thread.startedByBot`) the sidebar lists: a view preference of the bound
 * profile, kept on this computer. It changes what the sidebar shows, never a thread's `hidden`.
 * - `all`: every one, also those a bot keeps out of the sidebar (`Thread.hidden`).
 * - `none`: none of them.
 * - unset: those the bot left in the sidebar, the default until the eye is used.
 */
export type BotThreadsShown = 'all' | 'none'

// Kept from when the eye only showed hidden threads: '1' was "show them all", so it still reads as `all`.
const NAME = 'sidebar.showHiddenThreads'

export function readBotThreadsShown(profileId: string): BotThreadsShown | undefined {
  if (!profileId) return undefined
  try {
    const value = localStorage.getItem(profilePreferenceKey(profileId, NAME))
    return value === '1' ? 'all' : value === '0' ? 'none' : undefined
  } catch {
    return undefined
  }
}

export function writeBotThreadsShown(profileId: string, shown: BotThreadsShown): void {
  if (!profileId) return
  try {
    localStorage.setItem(profilePreferenceKey(profileId, NAME), shown === 'all' ? '1' : '0')
  } catch {
    // No storage: the choice lasts while the page is open.
  }
}

/** A thread one of the owner's bots started; only such a thread can be hidden (`threads.setHidden`). */
export function isBotStarted(thread: Thread): boolean {
  return Boolean(thread.startedByBot) || Boolean(thread.hidden)
}

/** Whether the sidebar lists the thread under the eye's choice. */
export function listsThread(thread: Thread, shown: BotThreadsShown | undefined): boolean {
  if (!isBotStarted(thread)) return true
  if (shown === 'all') return true
  if (shown === 'none') return false
  return !thread.hidden
}
