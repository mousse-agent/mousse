/** Personal renderer preferences always use the bound profile identity. */
export function profilePreferenceKey(profileId: string, name: string): string {
  if (!profileId) throw new Error('A profile is required for personal preferences')
  return `mousse-profile-${encodeURIComponent(profileId)}-${name}`
}

/** Preserve pre-profile preferences for the installation's default user only. */
export function migrateLegacyProfilePreferences(profile: { id: string; isDefault: boolean }): void {
  if (!profile.isDefault) return
  try {
    for (const [name, legacyKey] of [['modelFavorites', 'mousse.modelFavorites'], ['quickActions.v1', 'mousse.quickActions.v1'], ['mousse:main-panel-sidebar-width', 'mousse:main-panel-sidebar-width']]) {
      const key = profilePreferenceKey(profile.id, name)
      const legacy = localStorage.getItem(legacyKey)
      if (legacy !== null && localStorage.getItem(key) === null) localStorage.setItem(key, legacy)
    }
  } catch { /* Storage can be unavailable; preserve the existing legacy values. */ }
}
