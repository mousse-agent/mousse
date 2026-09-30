import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs'
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
    let visited = 0
    const scanOwners = (root: string, path: string, depth = 0): void => {
      if (!existsSync(path)) return
      assertLifecyclePath(root, path)
      if (++visited > 100_000 || depth > 4) throw new Error('Unregistered storage layout exceeds bounded ownership discovery.')
      if (!lstatSync(path).isDirectory()) return
      const meta = join(path, 'meta.json')
      if (existsSync(meta)) {
        assertLifecyclePath(root, meta)
        const value = JSON.parse(readFileSync(meta, 'utf8')) as { id?: string }
        if (!value.id || !records.some((record) => record.taskId === value.id && record.locations.some((location) => resolve(location) === resolve(path)))) throw new Error(`Unregistered task metadata prevents exclusive ownership proof in profile ${store.profileId}.`)
        return // Historical generations inside a known task are not separate live owners.
      }
      for (const name of readdirSync(path)) {
        // Completed migration backups are deliberately historical, never new live owners.
        if (name === '.migration-trash') continue
        const child = join(path, name)
        if (lstatSync(child).isDirectory() || lstatSync(child).isSymbolicLink()) scanOwners(root, child, depth + 1)
      }
    }
    for (const root of [join(store.profileHome, 'thread-data'), join(store.profileHome, 'trash', 'threads'), join(store.profileHome, '.data')]) scanOwners(root, root)
    const projectsPath = join(store.profileHome, 'projects.json')
    if (existsSync(projectsPath)) {
      assertLifecyclePath(store.profileHome, projectsPath)
      const projects = JSON.parse(readFileSync(projectsPath, 'utf8')) as Array<{ path?: string }>
      if (!Array.isArray(projects)) throw new Error('Unknown project registry prevents legacy ownership discovery.')
      for (const project of projects) if (project.path) {
        const legacy = join(project.path, '.mousse', '.data')
        if (existsSync(legacy)) scanOwners(legacy, legacy)
      }
    }
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
