import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { LifecycleResource } from '../../shared/resourceLifecycle'
import { ProfileManager } from '../profiles/ProfileManager'
import { createInstallationPaths } from '../profiles/paths'
import { buildResourceInventory } from './ResourceInventory'
import { assertLifecyclePath, ResourceLifecycleStore } from './ResourceLifecycleStore'

/** Installation-wide source view shared by purge and receipt release; malformed peers fail closed. */
export function getExternalResourceClaims(current: ResourceLifecycleStore, ownedIds: Set<string>): Array<LifecycleResource & { peerProfileId: string }> {
  const nested = basename(dirname(current.profileHome)) === 'profiles'
  const installation = nested ? dirname(dirname(current.profileHome)) : current.profileHome
  const profilesRoot = join(installation, 'profiles')
  const stores = [current]
  if (existsSync(join(installation, 'installation.json'))) {
    const manager = ProfileManager.open(createInstallationPaths(installation))
    const profiles = manager.list() // existing validated installation/profile schema, including archived profiles
    const roots = new Set(profiles.map((profile) => resolve(join(profilesRoot, profile.id))))
    if (nested && !roots.has(resolve(current.profileHome))) throw new Error('Cleanup owner is absent from the installation profile registry.')
    assertLifecyclePath(installation, profilesRoot)
    for (const name of readdirSync(profilesRoot)) {
      const home = resolve(join(profilesRoot, name))
      assertLifecyclePath(profilesRoot, home)
      if (!roots.has(home)) throw new Error('Unregistered profile storage prevents proving exclusive ownership.')
    }
    for (const profile of profiles) {
      const home = join(profilesRoot, profile.id)
      if (resolve(home) !== resolve(current.profileHome)) stores.push(new ResourceLifecycleStore({ profileId: profile.id, profileHome: home }))
    }
    // Legacy installation-level owners can coexist during migration. Never ignore them.
    if (nested && existsSync(join(installation, 'lifecycle', 'manifest.json'))) {
      const manifest = JSON.parse(readFileSync(join(installation, 'lifecycle', 'manifest.json'), 'utf8')) as { profileId?: string }
      if (!manifest.profileId) throw new Error('Legacy lifecycle authority is unreadable.')
      stores.push(new ResourceLifecycleStore({ profileId: manifest.profileId, profileHome: installation }))
    } else if (nested && existsSync(join(installation, 'threads-index.json')) && JSON.parse(readFileSync(join(installation, 'threads-index.json'), 'utf8')).length) throw new Error('Unmigrated legacy thread ownership prevents cleanup.')
  } else if (nested || existsSync(profilesRoot) && readdirSync(profilesRoot).length) throw new Error('Profile storage has no validated installation registry; cleanup is blocked.')

  return stores.flatMap((store) => {
    const records = store.list()
    const index = join(store.profileHome, 'threads-index.json')
    if (existsSync(index)) {
      assertLifecyclePath(store.profileHome, index)
      const entries = JSON.parse(readFileSync(index, 'utf8')) as Array<{ id?: string }>
      if (!Array.isArray(entries) || entries.some((entry) => !entry.id || !records.some((record) => record.taskId === entry.id))) throw new Error(`Unregistered thread ownership in profile ${store.profileId} prevents cleanup.`)
    }
    return records.filter((record) => record.state !== 'purged' && !(resolve(store.profileHome) === resolve(current.profileHome) && ownedIds.has(record.taskId))).flatMap((record) => {
      const inventory = buildResourceInventory(store, record)
      if (inventory.blockers.length) throw new Error(`Shared ownership cannot be proven for profile ${store.profileId}, task ${record.taskId}: ${inventory.blockers.join('; ')}`)
      return inventory.resources.map((resource) => ({ ...resource, peerProfileId: store.profileId }))
    })
  })
}
