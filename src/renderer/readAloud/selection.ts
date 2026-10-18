import { findLocalTtsModel, providerTtsVoice, type ReadAloudSelection } from '../../shared/readAloud'
import { profilePreferenceKey } from '../lib/profilePreferences'

const PREFERENCE_NAME = 'readAloudModel'

/** Returns a clean selection, or null for unknown local models and malformed values. */
export function parseReadAloudSelection(value: unknown): ReadAloudSelection | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (record.source === 'local') {
    if (typeof record.modelId !== 'string') return null
    const model = findLocalTtsModel(record.modelId)
    return model ? { source: 'local', modelId: model.id, label: model.label } : null
  }
  if (record.source === 'provider') {
    const { providerId, modelId, label } = record
    if (typeof providerId !== 'string' || typeof modelId !== 'string' || !providerId || !modelId) return null
    if (!providerTtsVoice(providerId, modelId)) return null
    return { source: 'provider', providerId, modelId, label: typeof label === 'string' && label ? label : modelId }
  }
  return null
}

export function loadReadAloudSelection(profileId: string): ReadAloudSelection | null {
  try {
    const raw = localStorage.getItem(profilePreferenceKey(profileId, PREFERENCE_NAME))
    return raw ? parseReadAloudSelection(JSON.parse(raw)) : null
  } catch {
    return null
  }
}

export function saveReadAloudSelection(profileId: string, selection: ReadAloudSelection | null): void {
  try {
    const key = profilePreferenceKey(profileId, PREFERENCE_NAME)
    if (selection) localStorage.setItem(key, JSON.stringify(selection))
    else localStorage.removeItem(key)
  } catch {
    /* ignore quota / private mode */
  }
}

export function sameReadAloudSelection(a: ReadAloudSelection | null, b: ReadAloudSelection | null): boolean {
  if (!a || !b) return a === b
  if (a.source === 'local') return b.source === 'local' && a.modelId === b.modelId
  return b.source === 'provider' && a.providerId === b.providerId && a.modelId === b.modelId
}
