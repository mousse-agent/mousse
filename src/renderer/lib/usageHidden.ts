import { profilePreferenceKey } from './profilePreferences'

/**
 * Providers the person hid from the Usage page: a personal preference of the bound profile, kept on
 * this computer. Hiding only takes the row off the page; the provider itself stays as it is.
 */
const NAME = 'usage.hidden'

export function readHiddenUsage(profileId: string): Set<string> {
  if (!profileId) return new Set()
  try {
    const value: unknown = JSON.parse(localStorage.getItem(profilePreferenceKey(profileId, NAME)) ?? '[]')
    return new Set(Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string' && id.length <= 200) : [])
  } catch {
    return new Set()
  }
}

export function writeHiddenUsage(profileId: string, hidden: ReadonlySet<string>): void {
  if (!profileId) return
  try {
    const key = profilePreferenceKey(profileId, NAME)
    if (hidden.size) localStorage.setItem(key, JSON.stringify([...hidden].sort()))
    else localStorage.removeItem(key)
  } catch {
    // No storage: the choice lasts while the page is open.
  }
}
