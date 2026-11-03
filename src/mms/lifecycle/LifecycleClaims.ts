import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import type { LifecycleResource, ResourceInventorySnapshot, TaskLifecycleRecord } from '../../shared/resourceLifecycle'
import { ProfileManager } from '../profiles/ProfileManager'
import { createInstallationPaths } from '../profiles/paths'
import { collectingReads, finalReads, inventoryFrom, OWNER_SCAN_LIMIT, OwnershipFacts, readOwnershipFacts, type OwnershipNeed, type OwnershipReads } from './ResourceInventory'
import { assertLifecyclePath, ResourceLifecycleStore } from './ResourceLifecycleStore'
import { pathsOverlap } from './canonicalPath'
import { repositoryKeyOf } from '../git/RepositoryIdentity'

/**
 * Another thread whose checkout can't be verified: its repository was deleted, moved or replaced, the checkout lost its
 * `.git`, or it changed while it was read. Its records were read in full, so what it may still use is known: the
 * repositories its records name and the ones its checkouts and project folder point at now, the paths its records name,
 * its refs, and the ref namespaces that carry its id. A resource inside that scope is kept back, with `reason`; anything
 * outside it is not this thread's, so it no longer stops cleanup elsewhere. A thread whose records themselves can't be
 * read has no known scope, and that still blocks everything.
 */
export interface UnverifiedOwner {
  profileId: string
  taskId: string
  /** "Thread “Fix prices” has a worktree Mousse can’t check: /…/main." */
  reason: string
  /** The checkouts that failed verification. */
  worktrees: string[]
  /** Recorded repository ids, and the keys of the real common directories its checkouts and project folder point at. */
  repositoryIds: string[]
  /** A recorded repository that no checkout or folder ties to a real one any more: it may be any repository. */
  uncertain: boolean
  /** Real paths (`canonicalPathAsync`): the thread's data folders and every checkout or container its records name. */
  paths: string[]
  refs: string[]
  refPrefixes: string[]
}
/** `canonicalIdentity` is the real path of an absolute identity, which is what path overlaps compare. */
export type ExternalClaim = LifecycleResource & { peerProfileId: string; canonicalIdentity?: string; unverified?: UnverifiedOwner }
type ExternalClaims = ExternalClaim[]

/**
 * What a caller is about to remove or release: the repositories it is in (each key it is known by), its real path
 * (`canonicalPathAsync`), or its ref.
 */
export interface ClaimTarget { repositoryIds?: Array<string | undefined>; path?: string; ref?: string }

/** Whether `claim` names `canonicalPath`, something inside it, or something around it, compared by real paths. */
export function claimOverlapsPath(claim: ExternalClaim, canonicalPath: string): boolean {
  return claim.canonicalIdentity !== undefined && pathsOverlap(claim.canonicalIdentity, canonicalPath)
}

/**
 * The unverified thread whose scope covers `target`, if any:
 * - a repository it may use: one of its recorded or real ones, or any one while it is `uncertain`;
 * - a real path inside or around one it names;
 * - a ref it names, or one in its own namespaces. Mousse's refs outside `refs/heads/` are named by ids, so the same name
 *   is the same ref in any repository. A branch name is held only where no repository tells them apart, so the same
 *   branch name in another repository is not, and an owner without a repository never holds every repository.
 */
export function unverifiedOwnerOver(claims: readonly ExternalClaim[], target: ClaimTarget): UnverifiedOwner | undefined {
  const repositories = (target.repositoryIds ?? []).filter((id): id is string => Boolean(id))
  for (const claim of claims) {
    const owner = claim.unverified
    if (!owner) continue
    if (repositories.length && (owner.uncertain || repositories.some((id) => owner.repositoryIds.includes(id)))) return owner
    if (target.path && owner.paths.some((path) => pathsOverlap(path, target.path!))) return owner
    if (target.ref) {
      const ref = target.ref
      const ownNamespace = owner.refPrefixes.some((prefix) => ref.startsWith(prefix))
      if (ownNamespace || owner.refs.includes(ref) && (!ref.startsWith('refs/heads/') || !repositories.length || !owner.repositoryIds.length)) return owner
    }
  }
  return undefined
}

/** A worktree that can't be verified is the only blocker that leaves the records' scope known (`verifyWorktreeFact`). */
const UNVERIFIED_WORKTREE = 'Unverified worktree '

type JsonRecord = Record<string, unknown>
/** One of the thread's own small records, or undefined. */
function readRecord(path: string): JsonRecord | undefined {
  try {
    if (!existsSync(path) || lstatSync(path).isSymbolicLink() || lstatSync(path).size > 1024 * 1024) return undefined
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : undefined
  } catch { return undefined }
}
const text = (value: unknown): string | undefined => typeof value === 'string' && value ? value : undefined

function threadName(location: string, taskId: string): string {
  const name = text(readRecord(join(location, 'meta.json'))?.name)?.trim()
  return name || taskId
}

function unverifiedClaim(store: ResourceLifecycleStore, current: ResourceLifecycleStore, record: TaskLifecycleRecord, inventory: ResourceInventorySnapshot, reads: OwnershipReads): ExternalClaim {
  const owners = new Set([record.taskId, ...inventory.resources.map((resource) => resource.ownerTaskId)])
  const tasks = [...owners].map((id) => id === record.taskId ? record : store.get(id)).filter((task): task is TaskLifecycleRecord => Boolean(task))
  const paths = new Set<string>()
  for (const task of tasks) for (const location of [task.location, ...task.locations]) paths.add(location)
  for (const resource of inventory.resources) if (isAbsolute(resource.identity) && !resource.identity.includes('#') && resource.kind !== 'git-ref' && resource.kind !== 'artifact') paths.add(resource.identity)
  // Which repositories: the ids the records name, and the real common directory each checkout, the project's own
  // checkout and a project folder point at now, so a repository moved since the records were written is still held.
  const recorded = new Set(inventory.resources.map((resource) => resource.repositoryId).filter((id): id is string => Boolean(id)))
  const anchors: Array<{ path: string; repositoryId?: string }> = inventory.resources.filter((resource) => resource.kind === 'worktree').map((resource) => ({ path: resource.identity, repositoryId: resource.repositoryId }))
  for (const task of tasks) {
    const workspace = readRecord(join(task.location, 'workspace.json'))
    const checkout = text((workspace?.integrationTarget as JsonRecord | undefined)?.checkoutPath)
    if (checkout) anchors.push({ path: checkout, repositoryId: text(workspace?.repositoryId) })
    const folder = readRecord(join(task.location, 'project-folder.json'))
    const folderRepository = folder?.kind === 'project-folder' ? text(folder.repositoryId) : undefined
    if (folderRepository) recorded.add(folderRepository)
    if (folderRepository && text(folder?.worktreePath)) anchors.push({ path: text(folder!.worktreePath)!, repositoryId: folderRepository })
  }
  const resolved = anchors.map((anchor) => ({ ...anchor, commonDir: isAbsolute(anchor.path) ? reads.commonDir(anchor.path) : undefined }))
  const real = new Set(resolved.flatMap((anchor) => anchor.commonDir ? [repositoryKeyOf(anchor.commonDir)] : []))
  // A recorded repository nothing ties to a real one any more (the checkout and the project are gone or unreadable): it
  // may have moved anywhere, so every repository is held.
  const uncertain = resolved.some((anchor) => anchor.repositoryId && !anchor.commonDir && !real.has(anchor.repositoryId))
  const refs = [...new Set(inventory.resources.filter((resource) => resource.kind === 'git-ref').map((resource) => resource.identity))]
  const refPrefixes = [...owners].flatMap((id) => [`refs/mousse/threads/${id}/`, `refs/mousse/delegations/${id}/`, `refs/mousse/published/${id}`, `refs/mousse/workflows/${store.profileId}/${id}/`, `refs/mousse/lifecycle/${store.profileId}/${id}/`, `refs/heads/mousse/thread/${id}/`])
  // The thread named is the one whose worktree failed, which may be a thread this one owns.
  const failed = inventory.resources.filter((resource) => resource.kind === 'worktree' && resource.ownership === 'unknown')
  const worktrees = failed.length ? [...new Set(failed.map((resource) => resource.identity))] : inventory.blockers.map((blocker) => blocker.slice(UNVERIFIED_WORKTREE.length).split(': ')[0]!)
  const broken = (failed[0] && store.get(failed[0].ownerTaskId)) || record
  const where = resolve(store.profileHome) === resolve(current.profileHome) ? '' : ' in another profile'
  const reason = `Thread “${threadName(broken.location, broken.taskId)}”${where} has ${worktrees.length === 1 ? 'a worktree' : 'worktrees'} Mousse can’t check: ${worktrees.join(', ')}.`
  return {
    id: createHash('sha256').update(`unverified\0${store.profileId}\0${record.taskId}`).digest('hex'),
    kind: 'unknown', identity: `unverified-thread:${store.profileId}/${record.taskId}`, ownerTaskId: record.taskId,
    materialization: 'unknown', ownership: 'unknown', sourceIds: [], claims: [], peerProfileId: store.profileId,
    unverified: { profileId: store.profileId, taskId: record.taskId, reason, worktrees, repositoryIds: [...new Set([...recorded, ...real])], uncertain, paths: [...paths].map((path) => reads.canonical(path)), refs, refPrefixes }
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
      // Paths are compared by their real paths, so an alias (a link, `/tmp` for `/private/tmp`) names the same folder.
      const claims: ExternalClaims = inventory.resources.map((resource) => ({ ...resource, peerProfileId: store.profileId, ...(isAbsolute(resource.identity) ? { canonicalIdentity: reads.canonical(resource.identity) } : {}) }))
      if (!inventory.blockers.length) return claims
      // Records read in full, with only a checkout that can't be verified: what the thread may own is known, so only that is held.
      if (inventory.blockers.every((blocker) => blocker.startsWith(UNVERIFIED_WORKTREE))) return [...claims, unverifiedClaim(store, current, record, inventory, reads)]
      throw new Error(`Shared ownership cannot be proven for profile ${store.profileId}, task ${record.taskId}: ${inventory.blockers.join('; ')}`)
    })
  })
}
