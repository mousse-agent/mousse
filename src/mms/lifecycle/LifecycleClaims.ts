import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { LifecycleResource, ResourceInventorySnapshot, TaskLifecycleRecord } from '../../shared/resourceLifecycle'
import { ProfileManager } from '../profiles/ProfileManager'
import { createInstallationPaths } from '../profiles/paths'
import { collectingReads, createInventoryStorePass, finalReads, inventoryFrom, OWNER_SCAN_LIMIT, OwnershipFacts, readOwnershipFacts, type InventoryStorePass, type OwnershipNeed, type OwnershipReads } from './ResourceInventory'
import { assertLifecyclePath, ResourceLifecycleStore } from './ResourceLifecycleStore'
import { canonicalPathAsync, comparablePath, pathsOverlap, registeredWorktreesAsync } from './canonicalPath'
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
  /** Real paths of every checkout its records name, to find the repository that still registers one. */
  checkouts: string[]
  /** Recorded repository ids, and the keys of the real common directories its checkouts and project folder point at. */
  repositoryIds: string[]
  /**
   * A recorded repository that no checkout or folder ties to a real one any more (moved or deleted outright), so where its
   * refs are now is unknown. Not every repository is held for it: its id-named refs and namespaces are held by name in any
   * repository already, and its branches, whose names carry no id, are then held by name in any repository too.
   */
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
export interface ClaimTarget {
  repositoryIds?: Array<string | undefined>
  path?: string
  ref?: string
  /** Real paths of the worktrees the target's repository registers (`registeredWorktreesAsync`). */
  registeredWorktrees?: string[]
}

/**
 * The repository part of a {@link ClaimTarget} in the repository at `commonDir`: the ids it is recorded by, the key of
 * its real common directory, and the worktrees it registers. Reads without blocking.
 */
export async function repositoryTargetAsync(commonDir: string | undefined, ...recorded: Array<string | undefined>): Promise<Required<Pick<ClaimTarget, 'repositoryIds' | 'registeredWorktrees'>>> {
  if (!commonDir) return { repositoryIds: recorded, registeredWorktrees: [] }
  const real = await canonicalPathAsync(commonDir)
  return { repositoryIds: [...recorded, repositoryKeyOf(real)], registeredWorktrees: await registeredWorktreesAsync(real) }
}

/** Whether `claim` names `canonicalPath`, something inside it, or something around it, compared by real paths. */
export function claimOverlapsPath(claim: ExternalClaim, canonicalPath: string): boolean {
  return claim.canonicalIdentity !== undefined && pathsOverlap(claim.canonicalIdentity, canonicalPath)
}

/**
 * The unverified thread whose scope covers `target`, if any:
 * - a repository it may use: one of its recorded or real ones, or one that still registers one of its checkouts;
 * - a real path inside or around one it names;
 * - a ref it names, or one in its own namespaces. Mousse's refs outside `refs/heads/` are named by ids, so the same name
 *   is the same ref in any repository. A branch name is held only where no repository tells them apart, or while the
 *   owner is `uncertain` (its repository may now be any one), so the same branch name in another repository is not
 *   otherwise. No owner holds every repository: one broken thread never stops cleanup in unrelated repositories.
 */
export function unverifiedOwnerOver(claims: readonly ExternalClaim[], target: ClaimTarget): UnverifiedOwner | undefined {
  const repositories = (target.repositoryIds ?? []).filter((id): id is string => Boolean(id))
  for (const claim of claims) {
    const owner = claim.unverified
    if (!owner) continue
    if (repositories.some((id) => owner.repositoryIds.includes(id))) return owner
    if (target.registeredWorktrees?.some((registered) => owner.checkouts.some((checkout) => comparablePath(checkout) === comparablePath(registered)))) return owner
    if (target.path && owner.paths.some((path) => pathsOverlap(path, target.path!))) return owner
    if (target.ref) {
      const ref = target.ref
      const ownNamespace = owner.refPrefixes.some((prefix) => ref.startsWith(prefix))
      if (ownNamespace || owner.refs.includes(ref) && (!ref.startsWith('refs/heads/') || owner.uncertain || !repositories.length || !owner.repositoryIds.length)) return owner
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

function unverifiedClaim(store: ResourceLifecycleStore, current: ResourceLifecycleStore, record: TaskLifecycleRecord, inventory: ResourceInventorySnapshot, reads: OwnershipReads, pass?: InventoryStorePass): ExternalClaim {
  const owners = new Set([record.taskId, ...inventory.resources.map((resource) => resource.ownerTaskId)])
  const lookupTask = (id: string): TaskLifecycleRecord | undefined => id === record.taskId ? record : (pass ? pass.taskById.get(id) : store.get(id))
  const tasks = [...owners].map(lookupTask).filter((task): task is TaskLifecycleRecord => Boolean(task))
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
  // may have moved anywhere, so its branch names are held in any repository (`unverifiedOwnerOver`).
  const uncertain = resolved.some((anchor) => anchor.repositoryId && !anchor.commonDir && !real.has(anchor.repositoryId))
  const refs = [...new Set(inventory.resources.filter((resource) => resource.kind === 'git-ref').map((resource) => resource.identity))]
  const refPrefixes = [...owners].flatMap((id) => [`refs/mousse/threads/${id}/`, `refs/mousse/delegations/${id}/`, `refs/mousse/published/${id}`, `refs/mousse/workflows/${store.profileId}/${id}/`, `refs/mousse/lifecycle/${store.profileId}/${id}/`, `refs/heads/mousse/thread/${id}/`])
  // The thread named is the one whose worktree failed, which may be a thread this one owns.
  const failed = inventory.resources.filter((resource) => resource.kind === 'worktree' && resource.ownership === 'unknown')
  const worktrees = failed.length ? [...new Set(failed.map((resource) => resource.identity))] : inventory.blockers.map((blocker) => blocker.slice(UNVERIFIED_WORKTREE.length).split(': ')[0]!)
  const broken = (failed[0] && lookupTask(failed[0].ownerTaskId)) || record
  const where = resolve(store.profileHome) === resolve(current.profileHome) ? '' : ' in another profile'
  const reason = `Thread “${threadName(broken.location, broken.taskId)}”${where} has ${worktrees.length === 1 ? 'a worktree' : 'worktrees'} Mousse can’t check: ${worktrees.join(', ')}.`
  return {
    id: createHash('sha256').update(`unverified\0${store.profileId}\0${record.taskId}`).digest('hex'),
    kind: 'unknown', identity: `unverified-thread:${store.profileId}/${record.taskId}`, ownerTaskId: record.taskId,
    materialization: 'unknown', ownership: 'unknown', sourceIds: [], claims: [], peerProfileId: store.profileId,
    unverified: { profileId: store.profileId, taskId: record.taskId, reason, worktrees, checkouts: [...new Set(anchors.filter((anchor) => isAbsolute(anchor.path)).map((anchor) => reads.canonical(anchor.path)))], repositoryIds: [...new Set([...recorded, ...real])], uncertain, paths: [...paths].map((path) => reads.canonical(path)), refs, refPrefixes }
  }
}

/**
 * Installation-wide source view shared by purge and receipt release; malformed peers fail closed. Checkouts and old
 * data folders inside project folders are read without blocking (see `OwnershipFacts`); `facts` may be shared.
 */
export async function getExternalResourceClaims(current: ResourceLifecycleStore, ownedIds: Set<string>, facts = new OwnershipFacts()): Promise<ExternalClaims> {
  // First what needs no Git: the profiles, their records and the old data folders in project folders. A thread there that
  // no record owns refuses at once, before a single checkout is read (one Git check per worktree of the installation).
  for (let round = 0; round < 8; round++) {
    const needs: OwnershipNeed[] = []
    try {
      await runYielding(ownerStoresSteps(current, collectingReads(facts, needs)))
    } catch (error) {
      // As below: a refusal made on a stand-in for something not yet read is checked again once it is read.
      if (!needs.length) throw error
    }
    if (!needs.length) break
    await readOwnershipFacts(needs, facts)
  }
  // An old data folder found clean above is scanned again after the checkouts are read, which can take long: a thread
  // that appeared in one meanwhile still refuses, and a purge's last check (`getExternalResourceClaimsFromFacts`) rests
  // on scans no older than its Git checks.
  let early = [...facts.legacy].filter(([, scan]) => !scan.error).map(([root]) => root)
  for (let round = 0; ; round++) {
    const needs: OwnershipNeed[] = []
    try {
      const claims = await runYielding(claimsSteps(current, ownedIds, collectingReads(facts, needs)))
      if (!needs.length) {
        if (early.length && facts.worktrees.size) {
          const refresh = early
          early = []
          for (const root of refresh) facts.legacy.delete(root)
          await readOwnershipFacts(refresh.map((root) => ({ kind: 'legacy' as const, root })), facts)
          // Re-verify ownerStores with the freshly scanned legacy folders; a thread that appeared there during the Git
          // checks refuses here, and any newly registered project's legacy folder is collected and scanned.
          const lateNeeds: OwnershipNeed[] = []
          try {
            await runYielding(ownerStoresSteps(current, collectingReads(facts, lateNeeds)))
          } catch (error) {
            if (!lateNeeds.length) throw error
          }
          if (lateNeeds.length) {
            await readOwnershipFacts(lateNeeds, facts)
            continue
          }
        }
        return claims
      }
    } catch (error) {
      // A first pass may stop on a real refusal before naming every checkout; that refusal stands once nothing is missing.
      if (!needs.length) throw error
    }
    if (round >= 8) return await runYielding(claimsSteps(current, ownedIds, finalReads(facts)))
    await readOwnershipFacts(needs, facts)
  }
}

/**
 * The ownership passes below are written once, as steps, and run two ways. {@link getExternalResourceClaims} lets the
 * event loop run between steps (`runYielding`): with a thousand threads a pass reads for many seconds, and under load
 * long enough that the app takes the service for stuck and replaces it, ending every running turn. A caller that must
 * act on the answer before anything else runs (`getExternalResourceClaimsFromFacts`) still runs them in one go
 * (`runSteps`). Each step is one thread's inventory or one folder of the ownership scan.
 */
type Steps<T> = Generator<void, T, void>

/** How long a yielding pass works before it lets the event loop run. */
export const OWNERSHIP_PASS_SLICE_MS = 20

function runSteps<T>(steps: Steps<T>): T {
  for (;;) {
    const step = steps.next()
    if (step.done) return step.value
  }
}

async function runYielding<T>(steps: Steps<T>): Promise<T> {
  let since = performance.now()
  for (;;) {
    const step = steps.next()
    if (step.done) return step.value
    if (performance.now() - since < OWNERSHIP_PASS_SLICE_MS) continue
    await new Promise<void>((resume) => setImmediate(resume))
    since = performance.now()
  }
}

/**
 * {@link getExternalResourceClaims} from facts already read, synchronously: the records are read now with nothing
 * awaited, and anything the facts do not cover fails closed. `missed` hears of each fact that was not there.
 */
export function getExternalResourceClaimsFromFacts(current: ResourceLifecycleStore, ownedIds: Set<string>, facts: OwnershipFacts, missed?: (what: string) => void): ExternalClaims {
  return claimsFrom(current, ownedIds, finalReads(facts, missed))
}

function claimsFrom(current: ResourceLifecycleStore, ownedIds: Set<string>, reads: OwnershipReads): ExternalClaims {
  return runSteps(claimsSteps(current, ownedIds, reads))
}

function* claimsSteps(current: ResourceLifecycleStore, ownedIds: Set<string>, reads: OwnershipReads): Steps<ExternalClaims> {
  const all: ExternalClaims = []
  for (const { store, records } of yield* ownerStoresSteps(current, reads)) {
    const pass = createInventoryStorePass(records)
    const sameProfile = resolve(store.profileHome) === resolve(current.profileHome)
    const included = records.filter((record) => record.state !== 'purged' && !(sameProfile && ownedIds.has(record.taskId)))
    const includedIds = new Set(included.map((record) => record.taskId))
    // A child whose ancestor is also included is already inventoried in full as part of that ancestor's owned tree.
    const hasIncludedAncestor = (record: TaskLifecycleRecord): boolean => {
      const seen = new Set<string>([record.taskId])
      let parentId = record.parentTaskId
      while (parentId && !seen.has(parentId)) {
        if (includedIds.has(parentId)) return true
        seen.add(parentId)
        parentId = pass.taskById.get(parentId)?.parentTaskId
      }
      return false
    }
    const roots = included.filter((record) => !hasIncludedAncestor(record))
    const covered = new Set<string>()
    const markCovered = (taskId: string): void => {
      if (covered.has(taskId)) return
      covered.add(taskId)
      for (const child of pass.childrenByParent.get(taskId) ?? []) markCovered(child.taskId)
    }
    for (const root of roots) markCovered(root.taskId)
    // Guard against corrupt parent cycles: any included record not covered by a root is still inventoried.
    for (const record of included) if (!covered.has(record.taskId)) { roots.push(record); markCovered(record.taskId) }
    for (const record of roots) {
      yield
      const inventory = inventoryFrom(store, record, {}, reads, pass)
      // Paths are compared by their real paths, so an alias (a link, `/tmp` for `/private/tmp`) names the same folder.
      for (const resource of inventory.resources) all.push({ ...resource, peerProfileId: store.profileId, ...(isAbsolute(resource.identity) ? { canonicalIdentity: reads.canonical(resource.identity) } : {}) })
      if (!inventory.blockers.length) continue
      // Records read in full, with only a checkout that can't be verified: what the thread may own is known, so only that is held.
      if (inventory.blockers.every((blocker) => blocker.startsWith(UNVERIFIED_WORKTREE))) { all.push(unverifiedClaim(store, current, record, inventory, reads, pass)); continue }
      throw new Error(`Shared ownership cannot be proven for profile ${store.profileId}, task ${record.taskId}: ${inventory.blockers.join('; ')}`)
    }
  }
  return all
}

/** Why a thread folder no record owns refuses a delete, in words a person can act on. */
function untrackedThread(path: string): string {
  return `Mousse found thread data it does not keep track of at ${path}, so it can’t be sure nothing else uses the files this delete would remove. Move that folder somewhere else, then delete again.`
}

function inside(folder: string, path: string): boolean {
  const rel = relative(resolve(folder), resolve(path))
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/**
 * Whether the thread folder at `path` (or, without one, the thread list entry) is a copy a move to the current layout
 * left behind: a record of that thread, in one of the installation's profiles, says the thread was moved into that
 * profile's own thread folders, and does not name `path`. The move keeps the old copy for recovery (in the migration
 * trash, or where it was when that is on another drive) and never reads it again; what the thread uses is its record's.
 * `movedOutOf`: the store whose own folders hold the copy; its own records are not where the thread was moved to.
 */
function leftByMove(listed: ReadonlyArray<{ store: ResourceLifecycleStore; records: TaskLifecycleRecord[] }>, taskId: string, path?: string, movedOutOf?: ResourceLifecycleStore): boolean {
  return listed.some(({ store, records }) => store !== movedOutOf && records.some((record) =>
    record.taskId === taskId &&
    inside(join(store.profileHome, 'thread-data'), record.originalLocation) &&
    !(path && record.locations.some((location) => resolve(location) === resolve(path)))))
}

/**
 * Every profile's lifecycle store with its records, once nothing but those records owns a thread there: the registered
 * profiles, their thread folders, the old data folders inside project folders and the thread indexes. None of this reads
 * Git, so a refusal here comes before any checkout is read.
 */
function* ownerStoresSteps(current: ResourceLifecycleStore, reads: OwnershipReads): Steps<Array<{ store: ResourceLifecycleStore; records: TaskLifecycleRecord[] }>> {
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

  const listed: Array<{ store: ResourceLifecycleStore; records: TaskLifecycleRecord[] }> = []
  for (const store of stores) {
    yield
    listed.push({ store, records: store.list() })
  }
  // The layouts threads were moved out of: the installation's own folders from before profiles, and the old data folders
  // inside project folders. A thread's copy left there by that move is no other owner (`leftByMove`).
  const movedFrom = (store: ResourceLifecycleStore): boolean => nested && resolve(store.profileHome) === resolve(installation)
  for (const { store, records } of listed) {
    let visited = 0
    // Which folders each record names, by task id: one lookup per thread folder instead of a search of every record.
    const locationsById = new Map<string, Set<string>>()
    for (const record of records) {
      let set = locationsById.get(record.taskId)
      if (!set) locationsById.set(record.taskId, (set = new Set()))
      for (const location of record.locations) set.add(resolve(location))
    }
    const recordNames = (id: string, path: string): boolean => locationsById.get(id)?.has(resolve(path)) ?? false
    const scanOwners = function* (root: string, path: string, depth = 0): Steps<void> {
      yield
      if (!existsSync(path)) return
      assertLifecyclePath(root, path)
      if (++visited > OWNER_SCAN_LIMIT || depth > 4) throw new Error('Unregistered storage layout exceeds bounded ownership discovery.')
      if (!lstatSync(path).isDirectory()) return
      const meta = join(path, 'meta.json')
      if (existsSync(meta)) {
        assertLifecyclePath(root, meta)
        const value = JSON.parse(readFileSync(meta, 'utf8')) as { id?: string }
        if (!value.id || !recordNames(value.id, path) && !(movedFrom(store) && leftByMove(listed, value.id, path, store))) throw new Error(untrackedThread(path))
        return // Historical generations inside a known task are not separate live owners.
      }
      for (const name of readdirSync(path)) {
        // Completed migration backups are deliberately historical, never new live owners.
        if (name === '.migration-trash') continue
        const child = join(path, name)
        if (lstatSync(child).isDirectory() || lstatSync(child).isSymbolicLink()) yield* scanOwners(root, child, depth + 1)
      }
    }
    for (const root of [join(store.profileHome, 'thread-data'), join(store.profileHome, 'trash', 'threads'), join(store.profileHome, '.data')]) yield* scanOwners(root, root)
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
          if (!meta.id || !recordNames(meta.id, meta.path) && !leftByMove(listed, meta.id, meta.path)) throw new Error(untrackedThread(meta.path))
        }
        if (scan.error) throw new Error(scan.error)
        if (visited > OWNER_SCAN_LIMIT) throw new Error('Unregistered storage layout exceeds bounded ownership discovery.')
      }
    }
    const index = join(store.profileHome, 'threads-index.json')
    if (existsSync(index)) {
      assertLifecyclePath(store.profileHome, index)
      const entries = JSON.parse(readFileSync(index, 'utf8')) as Array<{ id?: string }>
      if (!Array.isArray(entries) || entries.some((entry) => !entry.id || !locationsById.has(entry.id) && !(movedFrom(store) && leftByMove(listed, entry.id, undefined, store)))) throw new Error(`Unregistered thread ownership in profile ${store.profileId} prevents cleanup.`)
    }
  }
  return listed
}
