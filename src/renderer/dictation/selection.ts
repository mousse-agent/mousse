import { findLocalSttModel, isSttModelId, providerSupportsStt, type DictationSelection } from '../../shared/dictation'
import { profilePreferenceKey } from '../lib/profilePreferences'

const PREFERENCE_NAME = 'dictationModel'

/** Returns a clean selection, or null for unknown local models and malformed values. */
export function parseDictationSelection(value: unknown): DictationSelection | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (record.source === 'local') {
    if (typeof record.modelId !== 'string') return null
    const model = findLocalSttModel(record.modelId)
    return model ? { source: 'local', modelId: model.id, label: model.label } : null
  }
  if (record.source === 'provider') {
    const { providerId, modelId, label } = record
    if (typeof providerId !== 'string' || typeof modelId !== 'string' || !providerId || !modelId) return null
    if (!providerSupportsStt(providerId) || !isSttModelId(modelId)) return null
    return { source: 'provider', providerId, modelId, label: typeof label === 'string' && label ? label : modelId }
  }
  return null
}

export function loadDictationSelection(profileId: string): DictationSelection | null {
  try {
    const raw = localStorage.getItem(profilePreferenceKey(profileId, PREFERENCE_NAME))
    return raw ? parseDictationSelection(JSON.parse(raw)) : null
  } catch {
    return null
  }
}

export function saveDictationSelection(profileId: string, selection: DictationSelection | null): void {
  try {
    const key = profilePreferenceKey(profileId, PREFERENCE_NAME)
    if (selection) localStorage.setItem(key, JSON.stringify(selection))
    else localStorage.removeItem(key)
  } catch {
    /* ignore quota / private mode */
  }
}

export function sameDictationSelection(a: DictationSelection | null, b: DictationSelection | null): boolean {
  if (!a || !b) return a === b
  if (a.source === 'local') return b.source === 'local' && a.modelId === b.modelId
  return b.source === 'provider' && a.providerId === b.providerId && a.modelId === b.modelId
}
