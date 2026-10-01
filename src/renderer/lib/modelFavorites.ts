import { profilePreferenceKey } from './profilePreferences'

export type ModelFavoriteKey = string

/** Stable key for a model family within a provider. */
export function favoriteKey(providerId: string, familyId: string): ModelFavoriteKey {
  return familyId.includes(':') ? familyId : `${providerId}:${familyId}`
}

export function loadModelFavorites(profileId: string): Set<ModelFavoriteKey> {
  try {
    const raw = localStorage.getItem(profilePreferenceKey(profileId, 'modelFavorites'))
    if (!raw) return new Set()
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return new Set()
    return new Set(parsed.filter((value): value is string => typeof value === 'string'))
  } catch {
    return new Set()
  }
}

export function saveModelFavorites(favorites: Set<ModelFavoriteKey>, profileId: string): void {
  try {
    localStorage.setItem(profilePreferenceKey(profileId, 'modelFavorites'), JSON.stringify([...favorites]))
  } catch {
    /* ignore quota / private mode */
  }
}

export function toggleModelFavorite(
  favorites: Set<ModelFavoriteKey>,
  key: ModelFavoriteKey,
  profileId: string
): Set<ModelFavoriteKey> {
  const next = new Set(favorites)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  saveModelFavorites(next, profileId)
  return next
}


