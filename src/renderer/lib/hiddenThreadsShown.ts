import { profilePreferenceKey } from './profilePreferences'

/**
 * Whether the sidebar lists the threads a bot keeps out of it (`Thread.hidden`): a view preference of the bound
 * profile, kept on this computer. It changes what the sidebar shows, never a thread's `hidden`.
 */
const NAME = 'sidebar.showHiddenThreads'

export function readHiddenThreadsShown(profileId: string): boolean {
  if (!profileId) return false
  try {
    return localStorage.getItem(profilePreferenceKey(profileId, NAME)) === '1'
  } catch {
    return false
  }
}

export function writeHiddenThreadsShown(profileId: string, shown: boolean): void {
  if (!profileId) return
  try {
    const key = profilePreferenceKey(profileId, NAME)
    if (shown) localStorage.setItem(key, '1')
    else localStorage.removeItem(key)
  } catch {
    // No storage: the choice lasts while the page is open.
  }
}
