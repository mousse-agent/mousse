import { useCallback, useEffect, useMemo, useState } from 'react'
import type { InstanceSnapshot } from '../../shared/harness/status'
import type { ModelPrefsPatch } from '../../shared/harness/types'
import { groupModelsByFamily, type ModelFamily } from '../../shared/modelVariants'
import { useAppStore } from '../stores/appStore'
import { DEVICE_SCOPE, applySnapshot, llmProviderOf, modelPrefsByInstance, useProviderSnapshots } from './providerSnapshots'
import { profilePreferenceKey } from './profilePreferences'

/**
 * Favorite models live in the daemon's model preferences (`ModelPrefs.favorites`, model ids per
 * instance) and reach the pickers through the snapshots. Older builds kept them in this window's
 * localStorage as `<provider>:<family label>` keys; those are imported once and the key removed.
 */

export type ModelFavoriteKey = string

const LEGACY_FAVORITES = 'modelFavorites'

/** The pre-snapshot favorite key of a model family within a provider. */
export function favoriteKey(providerId: string, familyId: string): ModelFavoriteKey {
  return familyId.includes(':') ? familyId : `${providerId}:${familyId}`
}

/** Favorites saved by older builds, until they are imported. */
export function loadLegacyModelFavorites(profileId: string): Set<ModelFavoriteKey> {
  try {
    const raw = localStorage.getItem(profilePreferenceKey(profileId, LEGACY_FAVORITES))
    if (!raw) return new Set()
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return new Set()
    return new Set(parsed.filter((value): value is string => typeof value === 'string'))
  } catch {
    return new Set()
  }
}

function hasLegacyModelFavorites(profileId: string): boolean {
  try {
    return localStorage.getItem(profilePreferenceKey(profileId, LEGACY_FAVORITES)) !== null
  } catch {
    return false
  }
}

function saveLegacyModelFavorites(profileId: string, favorites: ReadonlySet<ModelFavoriteKey>): void {
  try {
    localStorage.setItem(profilePreferenceKey(profileId, LEGACY_FAVORITES), JSON.stringify([...favorites]))
  } catch {
    /* ignore quota / private mode */
  }
}

function removeLegacyModelFavorites(profileId: string): void {
  try {
    localStorage.removeItem(profilePreferenceKey(profileId, LEGACY_FAVORITES))
  } catch {
    /* storage unavailable: the import runs again next time and changes nothing */
  }
}

/** A family is a favorite when any of its models is. */
export function isFamilyFavorite(family: ModelFamily, favorites: ReadonlySet<string> | undefined): boolean {
  return Boolean(favorites) && family.variants.some((variant) => favorites!.has(variant.id))
}

/** The instance's favorites with the whole family starred, or unstarred. */
export function familyFavoritesPatch(family: ModelFamily, favorites: ReadonlySet<string>, favorite: boolean): ModelPrefsPatch {
  const next = new Set(favorites)
  for (const variant of family.variants) {
    if (favorite) next.add(variant.id)
    else next.delete(variant.id)
  }
  return { favorites: [...next] }
}

/**
 * Which instance favorites the legacy keys become: each key names a provider's picker id and a
 * family label; the family's models are starred on the instance serving that provider. Keys that
 * match no family are dropped. Only instances that gain a favorite get a patch.
 */
export function planLegacyFavoritesImport(
  legacy: ReadonlySet<ModelFavoriteKey>,
  snapshots: readonly InstanceSnapshot[]
): Map<string, ModelPrefsPatch> {
  const patches = new Map<string, ModelPrefsPatch>()
  if (legacy.size === 0) return patches
  for (const snapshot of snapshots) {
    if (!snapshot.builtIn) continue
    const providerId = llmProviderOf(snapshot)
    const models = snapshot.models.entries.map((model) => ({ id: model.id, label: model.label }))
    const current = new Set(snapshot.models.entries.filter((model) => model.favorite).map((model) => model.id))
    const next = new Set(current)
    for (const family of groupModelsByFamily(providerId, models)) {
      if (!legacy.has(favoriteKey(providerId, family.familyId))) continue
      for (const variant of family.variants) next.add(variant.id)
    }
    if (next.size > current.size) patches.set(snapshot.instanceId, { favorites: [...next] })
  }
  return patches
}

/** Every snapshot has finished a check, so a missing model really is missing. */
function catalogsSettled(snapshots: readonly InstanceSnapshot[]): boolean {
  return snapshots.every((snapshot) => snapshot.checkedAt !== undefined || snapshot.stale || snapshot.models.source !== 'none')
}

let importing: Promise<void> | null = null

/**
 * Moves this profile's localStorage favorites into the daemon once the device snapshots are
 * settled, then removes the key. A failed write keeps the key so the next load tries again.
 */
export function importLegacyModelFavorites(
  profileId: string,
  snapshots: readonly InstanceSnapshot[],
  setModelPrefs: (instanceId: string, patch: ModelPrefsPatch) => Promise<unknown>
): Promise<void> {
  if (importing || !profileId || !hasLegacyModelFavorites(profileId) || !catalogsSettled(snapshots)) return importing ?? Promise.resolve()
  importing = (async () => {
    try {
      const patches = planLegacyFavoritesImport(loadLegacyModelFavorites(profileId), snapshots)
      for (const [instanceId, patch] of patches) await setModelPrefs(instanceId, patch)
      removeLegacyModelFavorites(profileId)
    } catch (error) {
      console.warn('[providers] could not import model favorites; keeping them for the next try', error)
    } finally {
      importing = null
    }
  })()
  return importing
}

/** Writes model prefs and shows the result at once (the pushed change follows). */
export async function saveModelPrefs(instanceId: string, patch: ModelPrefsPatch): Promise<void> {
  applySnapshot(await window.mousse.providers.instances.setModelPrefs(instanceId, patch))
}

/** Runs the one-time favorites import once the device snapshots are in. */
export function useLegacyFavoritesImport(): void {
  const profileId = useAppStore((state) => state.profileId)
  const { snapshots } = useProviderSnapshots(DEVICE_SCOPE)
  useEffect(() => {
    if (snapshots) void importLegacyModelFavorites(profileId, snapshots, saveModelPrefs)
  }, [profileId, snapshots])
}

export interface ModelFavorites {
  isFavorite: (provider: { id: string; instanceId?: string }, family: ModelFamily) => boolean
  toggle: (provider: { id: string; instanceId?: string }, family: ModelFamily) => void
  /** Models hidden from pickers, per instance. */
  hiddenOf: (instanceId: string | undefined) => ReadonlySet<string> | undefined
}

/**
 * Favorites for the model pickers: the instance's starred models from the device snapshots. While
 * the daemon cannot report snapshots, the older localStorage favorites stand in so stars still work.
 */
export function useModelFavorites(): ModelFavorites {
  const profileId = useAppStore((state) => state.profileId)
  const { snapshots } = useProviderSnapshots(DEVICE_SCOPE)
  useLegacyFavoritesImport()
  const prefs = useMemo(() => (snapshots ? modelPrefsByInstance(snapshots) : null), [snapshots])
  const [legacy, setLegacy] = useState(() => loadLegacyModelFavorites(profileId))
  useEffect(() => setLegacy(loadLegacyModelFavorites(profileId)), [profileId])

  const isFavorite = useCallback(
    (provider: { id: string; instanceId?: string }, family: ModelFamily) => {
      const instance = provider.instanceId ? prefs?.get(provider.instanceId) : undefined
      if (instance) return isFamilyFavorite(family, instance.favorites)
      return legacy.has(favoriteKey(provider.id, family.familyId))
    },
    [prefs, legacy]
  )

  const toggle = useCallback(
    (provider: { id: string; instanceId?: string }, family: ModelFamily) => {
      const instance = provider.instanceId ? prefs?.get(provider.instanceId) : undefined
      if (instance && provider.instanceId) {
        const patch = familyFavoritesPatch(family, instance.favorites, !isFamilyFavorite(family, instance.favorites))
        void saveModelPrefs(provider.instanceId, patch).catch((error) => console.warn('[providers] could not save the favorite', error))
        return
      }
      const key = favoriteKey(provider.id, family.familyId)
      setLegacy((current) => {
        const next = new Set(current)
        if (next.has(key)) next.delete(key)
        else next.add(key)
        saveLegacyModelFavorites(profileId, next)
        return next
      })
    },
    [prefs, profileId]
  )

  const hiddenOf = useCallback((instanceId: string | undefined) => (instanceId ? prefs?.get(instanceId)?.hidden : undefined), [prefs])

  return { isFavorite, toggle, hiddenOf }
}
