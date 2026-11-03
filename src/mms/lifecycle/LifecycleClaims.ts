import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { LifecycleResource, ResourceInventorySnapshot, TaskLifecycleRecord } from '../../shared/resourceLifecycle'
import { ProfileManager } from '../profiles/ProfileManager'
import { createInstallationPaths } from '../profiles/paths'
import { collectingReads, finalReads, inventoryFrom, OWNER_SCAN_LIMIT, OwnershipFacts, readOwnershipFacts, type OwnershipNeed, type OwnershipReads } from './ResourceInventory'
import { assertLifecyclePath, ResourceLifecycleStore } from './ResourceLifecycleStore'

/**
 * Another thread whose checkout can't be verified (its repository is gone, or was replaced at the same path). Its records
 * were read in full, so what it may still own is known: the repositories its records name, the paths they name and the
 * refs they name, plus the ref namespaces that carry its id. A resource inside that scope is kept back, with `reason`;
 * anything outside it is not this thread's, so it no longer stops cleanup elsewhere. A thread whose records themselves
 * can't be read has no known scope, and that still blocks everything.
 */
export interface UnverifiedOwner {
  profileId: string
  taskId: string
  /** "Thread “Fix prices” points at a worktree whose repository is gone." */
  reason: string
  repositoryIds: string[]
  /** Absolute paths: the thread's data folders and every checkout or container its records name. */
  paths: string[]
  refs: string[]
  refPrefixes: string[]
}
export type ExternalClaim = LifecycleResource & { peerProfileId: string; unverified?: UnverifiedOwner }
type ExternalClaims = ExternalClaim[]

/** What a caller is about to remove or release: its repository (when known), its path, or its ref. */
export interface ClaimTarget { repositoryId?: string; path?: string; ref?: string }

const overlaps = (left: string, right: string): boolean => {
  const inside = (root: string, path: string) => { const rel = relative(resolve(root), resolve(path)); return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) }
  return inside(left, right) || inside(right, left)
}

/**
 * The unverified thread whose scope covers `target`, if any: the same repository, a path inside or around one it names, or
 * a ref it names. A ref name alone counts only where a repository can't tell them apart (either side has none), so the
 * same branch name in another repository is not held, and an owner without a repository never matches every one.
 */
export function unverifiedOwnerOver(claims: readonly ExternalClaim[], target: ClaimTarget): UnverifiedOwner | undefined {
  for (const claim of claims) {
    const owner = claim.unverified
    if (!owner) continue
    if (target.repositoryId && owner.repositoryIds.includes(target.repositoryId)) return owner
    if (target.path && isAbsolute(target.path) && owner.paths.some((path) => overlaps(path, target.path!))) return owner
    if (target.ref && (!target.repositoryId || !owner.repositoryIds.length) && (owner.refs.includes(target.ref) || owner.refPrefixes.some((prefix) => target.ref!.startsWith(prefix)))) return owner
  }
  return undefined
}

/** A worktree that can't be verified is the only blocker that leaves the records' scope known (`verifyWorktreeFact`). */
const UNVERIFIED_WORKTREE = 'Unverified worktree '

function threadName(location: string, taskId: string): string {
  try {
    const name = (JSON.parse(readFileSync(join(location, 'meta.json'), 'utf8')) as { name?: unknown }).name
    if (typeof name === 'string' && name.trim()) return name.trim()
  } catch { /* The id names it instead. */ }
  return taskId
}

function unverifiedClaim(store: ResourceLifecycleStore, current: ResourceLifecycleStore, record: TaskLifecycleRecord, inventory: ResourceInventorySnapshot): ExternalClaim {
  const owners = new Set([record.taskId, ...inventory.resources.map((resource) => resource.ownerTaskId)])
  const paths = new Set([record.location, ...record.locations])
  for (const resource of inventory.resources) if (isAbsolute(resource.identity) && !resource.identity.includes('#') && resource.kind !== 'git-ref' && resource.kind !== 'artifact') paths.add(resource.identity)
  const repositoryIds = [...new Set(inventory.resources.map((resource) => resource.repositoryId).filter((id): id is string => Boolean(id)))]
  const refs = [...new Set(inventory.resources.filter((resource) => resource.kind === 'git-ref').map((resource) => resource.identity))]
  const refPrefixes = [...owners].flatMap((id) => [`refs/mousse/threads/${id}/`, `refs/mousse/delegations/${id}/`, `refs/mousse/published/${id}`, `refs/mousse/workflows/${store.profileId}/${id}/`, `refs/heads/mousse/thread/${id}/`])
  // The thread named is the one whose worktree failed, which may be a thread this one owns.
  const broken = store.get(inventory.resources.find((resource) => resource.kind === 'worktree' && resource.ownership === 'unknown')?.ownerTaskId ?? record.taskId) ?? record
  const name = threadName(broken.location, broken.taskId)
  const where = resolve(store.profileHome) === resolve(current.profileHome) ? '' : ' in another profile'
  const reason = `Thread “${name}”${where} points at a worktree whose repository is gone.`
  return {
    id: createHash('sha256').update(`unverified\0${store.profileId}\0${record.taskId}`).digest('hex'),
    kind: 'unknown', identity: `unverified-thread:${store.profileId}/${record.taskId}`, ownerTaskId: record.taskId,
    materialization: 'unknown', ownership: 'unknown', sourceIds: [], claims: [], peerProfileId: store.profileId,
    unverified: { profileId: store.profileId, taskId: record.taskId, reason, repositoryIds, paths: [...paths], refs, refPrefixes }
  }
}

/**
 * Installation-wide source view shared by purge and receipt release; malformed peers fail closed. Checkouts and old
 * data folders inside project folders are read without blocking (see `OwnershipFacts`); `facts` may be shared.
 */
export async function getExternalResourceClaims(current: ResourceLifecycleStore, ownedIds: Set<string>, facts = new OwnershipFacts()): Promise<ExternalClaims> {
  for (let round = 0; ; round++) {
    const needs: OwnershipNeed[] = []
    try {
      const claims = claimsFrom(current, ownedIds, collectingReads(facts, needs))
      if (!needs.length) return claims
    } catch (error) {
      // A first pass may stop on a real refusal before naming every checkout; that refusal stands once nothing is missing.
      if (!needs.length) throw error
    }
    if (round >= 8) return claimsFrom(current, ownedIds, finalReads(facts))
    await readOwnershipFacts(needs, facts)
  }
}

/**
 * {@link getExternalResourceClaims} from facts already read, synchronously: the records are read now with nothing
 * awaited, and anything the facts do not cover fails closed.
 */
export function getExternalResourceClaimsFromFacts(current: ResourceLifecycleStore, ownedIds: Set<string>, facts: OwnershipFacts): ExternalClaims {
  return claimsFrom(current, ownedIds, finalReads(facts))
}

function claimsFrom(current: ResourceLifecycleStore, ownedIds: Set<string>, reads: OwnershipReads): ExternalClaims {
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
      if (++visited > OWNER_SCAN_LIMIT || depth > 4) throw new Error('Unregistered storage layout exceeds bounded ownership discovery.')
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
        // Inside the person's project folder: scanned without blocking, the same way (`scanLegacyFolder`).
        const scan = reads.legacy(join(project.path, '.mousse', '.data'))
        visited += scan.visited
        for (const meta of scan.metas) {
          if (!meta.id || !records.some((record) => record.taskId === meta.id && record.locations.some((location) => resolve(location) === resolve(meta.path)))) throw new Error(`Unregistered task metadata prevents exclusive ownership proof in profile ${store.profileId}.`)
        }
        if (scan.error) throw new Error(scan.error)
        if (visited > OWNER_SCAN_LIMIT) throw new Error('Unregistered storage layout exceeds bounded ownership discovery.')
      }
    }
    const index = join(store.profileHome, 'threads-index.json')
    if (existsSync(index)) {
      assertLifecyclePath(store.profileHome, index)
      const entries = JSON.parse(readFileSync(index, 'utf8')) as Array<{ id?: string }>
      if (!Array.isArray(entries) || entries.some((entry) => !entry.id || !records.some((record) => record.taskId === entry.id))) throw new Error(`Unregistered thread ownership in profile ${store.profileId} prevents cleanup.`)
    }
    return records.filter((record) => record.state !== 'purged' && !(resolve(store.profileHome) === resolve(current.profileHome) && ownedIds.has(record.taskId))).flatMap((record) => {
      const inventory = inventoryFrom(store, record, {}, reads)
      const claims: ExternalClaims = inventory.resources.map((resource) => ({ ...resource, peerProfileId: store.profileId }))
      if (!inventory.blockers.length) return claims
      // Records read in full, with only a checkout that can't be verified: what the thread may own is known, so only that is held.
      if (inventory.blockers.every((blocker) => blocker.startsWith(UNVERIFIED_WORKTREE))) return [...claims, unverifiedClaim(store, current, record, inventory)]
      throw new Error(`Shared ownership cannot be proven for profile ${store.profileId}, task ${record.taskId}: ${inventory.blockers.join('; ')}`)
    })
  })
}
