import { MOUSSE_CONTROL_FILE_PATHS } from '../worktree/controlFiles'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { atomicWriteJsonSync } from '../data/AtomicFs'
import { assertLifecyclePath, ResourceLifecycleStore } from './ResourceLifecycleStore'
import type { RepositoryLeaseHandle } from '../git/RepositoryLease'
import type { ThreadLeaseHandle } from '../queue/ThreadExecutionLease'
import { assertHeldThreadLease } from '../actions/GitOperationCoordinator'
import { operationInProgress } from '../actions/git'
import { moveFiles, sameTree, takeSnapshot, worktreeTree } from '../actions/snapshots'
import { PROCESS_INSTANCE_ID } from '../queue/processLiveness'
import { AgentEpisodeStore } from '../agents/AgentEpisodeStore'
import { WorktreeIdentity } from '../worktree/WorktreeIdentity'
import { ThreadJournal } from '../data/ThreadJournal'
import { getExternalResourceClaims } from './LifecycleClaims'
import type { ConversationBranch, ThreadAction } from '../../shared/threadActions'
import { gitDirectoryEnv } from '../git/gitEnv'
import { READ_ONLY_GIT_ENV } from '../git/readOnlyGit'
import { repoProgramEnv, withoutRepoPrograms } from '../git/repoPrograms'
import { renameFolder } from './renameFolder'

const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')
/** A retired worktree waits in the trash until nothing in it has changed for this long; then its files are snapshotted and it is deleted. */
export const WORKTREE_TRASH_QUIET_MS = 60 * 60_000
export function lifecycleGit(cwd: string, args: string[], input?: string, maxBuffer = 32 * 1024 * 1024, env?: NodeJS.ProcessEnv): string {
  return execFileSync('git', withoutRepoPrograms(cwd, args, { stdin: input, env }), { cwd, input, env: repoProgramEnv({ ...process.env, ...gitDirectoryEnv(cwd), ...env }), encoding: 'utf8', windowsHide: true, timeout: 30_000, maxBuffer, stdio: ['pipe', 'pipe', 'pipe'] }).trimEnd()
}
/** A lifecycle read (a preview, the checks before a delete): it never refreshes the index and never fetches a missing object. */
export function lifecycleRead(cwd: string, args: string[], input?: string, maxBuffer?: number): string {
  return lifecycleGit(cwd, args, input, maxBuffer, READ_ONLY_GIT_ENV)
}
/** Never treat an unreadable reference as absent, and never dereference an owned symbolic ref. */
export function readDirectLifecycleRef(cwd: string, ref: string): string | undefined {
  try { lifecycleGit(cwd, ['symbolic-ref', '-q', ref]); throw new Error(`Symbolic resource reference is not cleanup authority: ${ref}`) }
  catch (error) { if ((error as { status?: number }).status !== 1) throw error }
  const listing = spawnSync('git', withoutRepoPrograms(cwd, ['for-each-ref', '--format=%(refname)%00%(objectname)', ref]), { cwd, env: repoProgramEnv({ ...process.env, ...gitDirectoryEnv(cwd), ...READ_ONLY_GIT_ENV }), encoding: 'utf8', windowsHide: true, timeout: 30_000, maxBuffer: 32 * 1024 * 1024 })
  // Git may warn about a corrupt loose ref while exiting successfully and omitting it.
  if (listing.error || listing.status !== 0 || listing.stderr.trim()) throw new Error(`Resource reference inventory is unreadable: ${ref}`)
  const rows = listing.stdout.split(/\r?\n/)
  const row = rows.find((entry) => entry.split('\0')[0] === ref)
  if (!row) return undefined
  const sha = row?.split('\0')[1]
  if (!sha || !/^[a-f0-9]{40,64}$/.test(sha) || /^0+$/.test(sha)) throw new Error(`Existing resource reference is malformed or unreadable: ${ref}`)
  return sha
}
function same(a: string, b: string): boolean { return (process.platform === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b)) }
export interface ContentEntry { path: string; kind: 'file' | 'directory' | 'link'; digest: string; bytes: number; mode: number }
export function assertFrozenContentEntry(root: string, entry: ContentEntry): void {
  const path = join(root, entry.path)
  assertLifecyclePath(dirname(root), root)
  if (entry.path) assertLifecyclePath(root, dirname(path))
  const stat = lstatSync(path)
  const kind = stat.isSymbolicLink() ? 'link' : stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'unknown'
  if (kind !== entry.kind || stat.mode !== entry.mode || kind !== 'directory' && stat.size !== entry.bytes || kind === 'file' && stat.nlink > 1) throw new Error('Frozen content was replaced before mutation')
  const current = kind === 'link' ? hash(readlinkSync(path)) : kind === 'file' ? hash(readFileSync(path)) : ''
  if (current !== entry.digest) throw new Error('Frozen content changed before mutation')
}
/** A bounded walk that never follows links, crosses devices or enters Git administration. */
export function walkOwnedContent(root: string, skipRootGit = false): ContentEntry[] {
  assertLifecyclePath(dirname(root), root)
  const rootStat = lstatSync(root)
  const entries: ContentEntry[] = []
  let bytes = 0
  const walk = (path: string, depth: number): void => {
    if (depth > 64 || entries.length >= 100_000) throw new Error('Owned content exceeds bounded inventory limits')
    const stat = lstatSync(path)
    if (stat.dev !== rootStat.dev) throw new Error('Owned content crosses a filesystem boundary')
    const rel = relative(root, path).split('\\').join('/')
    if (stat.isSymbolicLink()) { entries.push({ path: rel, kind: 'link', digest: hash(readlinkSync(path)), bytes: stat.size, mode: stat.mode }); return }
    if (stat.isDirectory()) {
      entries.push({ path: rel, kind: 'directory', digest: '', bytes: 0, mode: stat.mode })
      for (const name of readdirSync(path).sort()) {
        if (skipRootGit && !rel && name === '.git') continue
        if (skipRootGit && name === '.git') throw new Error('Nested repository requires explicit retention')
        walk(join(path, name), depth + 1)
      }
      return
    }
    if (!stat.isFile() || stat.nlink > 1) throw new Error('Special or multiply linked content requires explicit retention')
    bytes += stat.size
    if (stat.size > 64 * 1024 * 1024 || bytes > 512 * 1024 * 1024) throw new Error('Owned content exceeds bounded byte limits')
    entries.push({ path: rel, kind: 'file', digest: hash(readFileSync(path)), bytes: stat.size, mode: stat.mode })
  }
  walk(root, 0)
  return entries
}

export interface WorktreeReconstructionManifest {
  schemaVersion: 1
  profileId: string
  taskId: string
  worktreePath: string
  branch: string
  repositoryId: string
  commonDir: string
  gitDirectory: string
  rootIdentity: { dev: number; ino: number; birthtimeMs: number }
  sourcePath: string
  baseSha: string
  resultSha: string
  treeSha: string
  checkoutFingerprint: string
  baseRef: string
  resultRef: string
  /**
   * Set when the worktree held uncommitted files: `snapshotSha` is a snapshot of all of its files (its parent is the
   * HEAD in `resultSha`), pinned under `snapshotRef`, and `snapshotTree` its tree. Reconstruction writes those files
   * over a checkout of `resultSha`. Absent for a worktree whose files were its HEAD.
   */
  snapshotSha?: string
  snapshotTree?: string
  snapshotRef?: string
  /** The branch HEAD was on when the worktree was retired; absent when it was detached. The agent may have left the thread's own branch. */
  headBranch?: string
  sparse?: { patterns: string; cone: boolean }
  auxiliary: Array<{ path: string; content: string }>
  content: ContentEntry[]
  /**
   * Where the folder waits in Mousse's trash (`trashPathFor`), set before it is moved there. It was moved in one step and
   * stays registered with Git at that path. A process may still have its working directory there and write to it.
   */
  trashPath?: string
  /** When the folder reached the trash; set with state `trashed`. */
  trashedAt?: string
  /** Owned branches deleted once their tips were kept by the pins here, so a restore can bring them back. */
  deletedBranches?: Array<{ name: string; sha: string }>
  /**
   * `prepared`: pins written, folder in place. `trashed`: the folder is in the trash. `retired`: its files were
   * snapshotted and it was deleted. `materialized`: the worktree is back at its own path.
   */
  state: 'prepared' | 'trashed' | 'retired' | 'materialized'
}
/** The latest change time of anything in a folder, links not followed; `Infinity` when it is too large to tell. */
function newestChange(root: string): number {
  let newest = 0, seen = 0
  const walk = (path: string, depth: number): boolean => {
    if (++seen > 100_000 || depth > 64) return false
    const stat = lstatSync(path)
    newest = Math.max(newest, stat.mtimeMs, stat.ctimeMs)
    if (stat.isDirectory() && !stat.isSymbolicLink()) for (const name of readdirSync(path)) if (!walk(join(path, name), depth + 1)) return false
    return true
  }
  return walk(root, 0) ? newest : Infinity
}
export interface RetirementInput { taskId: string; worktreePath: string; branch: string; sourcePath: string; repositoryId?: string; baseSha?: string; resultSha?: string }
export interface RetirementOwnership { repositoryLease: RepositoryLeaseHandle; taskLease?: ThreadLeaseHandle; cleanupTaskId?: string; cleanupToken?: string; cleanupGeneration?: number }

/** Call under task execution ownership followed by repository mutation ownership. */
export class WorktreeRetirementService {
  constructor(readonly store: ResourceLifecycleStore, private readonly ownership?: RetirementOwnership) {}
  pathFor(taskId: string, worktreePath: string): string { return join(this.store.root, 'workspaces', taskId, `${hash(resolve(worktreePath))}.json`) }
  /** The one place a retired worktree waits in Mousse's trash; next to the profile, so the move stays on one disk. */
  trashPathFor(manifest: Pick<WorktreeReconstructionManifest, 'taskId' | 'worktreePath'>): string {
    return join(this.store.profileHome, 'trash', 'worktrees', hash(manifest.taskId).slice(0, 16), hash(resolve(manifest.worktreePath)).slice(0, 32))
  }
  inspectForDiscard(input: RetirementInput) {
    const identity = this.inspectIdentity(input.worktreePath, input.branch, input.repositoryId)
    this.verifySource({ ...input, repositoryId: identity.repositoryId })
    return { ...identity, resultSha: lifecycleRead(input.worktreePath, ['rev-parse', 'HEAD']), indexDigest: hash(lifecycleRead(input.worktreePath, ['ls-files', '--stage', '-v', '-z'])), content: walkOwnedContent(input.worktreePath, true) }
  }
  /**
   * The branch an owner's record names for the checkout at `worktreePath`. The checkout may be on another branch
   * (the agent is free to switch), so the branch that proves ownership is read from the record, not from HEAD.
   */
  ownedBranch(sourcePath: string, worktreePath: string): string | undefined {
    try {
      const value: unknown = JSON.parse(readFileSync(sourcePath, 'utf8'))
      const record = (row: unknown): row is { worktreePath: string; branch: string } => Boolean(row) && typeof row === 'object' && (row as { worktreePath?: unknown }).worktreePath === worktreePath && typeof (row as { branch?: unknown }).branch === 'string'
      const episodes = value && typeof value === 'object' && Array.isArray((value as { episodes?: unknown }).episodes) ? (value as { episodes: Array<{ binding?: unknown }> }).episodes.map((episode) => episode.binding) : []
      return [...(Array.isArray(value) ? value : [value]), ...episodes].find(record)?.branch
    } catch { return undefined }
  }
  load(path: string): WorktreeReconstructionManifest {
    assertLifecyclePath(this.store.root, path)
    const value = JSON.parse(readFileSync(path, 'utf8')) as WorktreeReconstructionManifest
    if (value.schemaVersion !== 1 || value.profileId !== this.store.profileId || !same(path, this.pathFor(value.taskId, value.worktreePath)) || !/^mousse\/(thread|agent|workflow)\//.test(value.branch)) throw new Error('Invalid workspace reconstruction authority')
    const prefix = `refs/mousse/lifecycle/${this.store.profileId}/${value.taskId}/${hash(value.worktreePath).slice(0, 32)}`
    if (value.snapshotSha !== undefined && (value.snapshotRef !== `${prefix}/snapshot` || ![value.snapshotSha, value.snapshotTree].every((sha) => typeof sha === 'string' && /^[a-f0-9]{40,64}$/.test(sha)))) throw new Error('Malformed workspace reconstruction manifest')
    if (value.baseRef !== `${prefix}/base` || value.resultRef !== `${prefix}/result` || ![value.worktreePath, value.commonDir, value.gitDirectory, value.sourcePath].every(isAbsolute) || ![value.baseSha, value.resultSha, value.treeSha].every((sha) => /^[a-f0-9]{40,64}$/.test(sha)) || !/^[a-f0-9]{32}$/.test(value.repositoryId) || !Array.isArray(value.content) || !Array.isArray(value.auxiliary) || !['prepared', 'trashed', 'retired', 'materialized'].includes(value.state)) throw new Error('Malformed workspace reconstruction manifest')
    if (value.trashPath !== undefined && !same(value.trashPath, this.trashPathFor(value)) || value.state === 'trashed' && (!value.trashPath || typeof value.trashedAt !== 'string')) throw new Error('Malformed workspace trash location')
    if (value.deletedBranches !== undefined && (!Array.isArray(value.deletedBranches) || !value.deletedBranches.every((entry) => /^mousse\/(thread|agent|workflow)\//.test(entry?.name) && /^[a-f0-9]{40,64}$/.test(entry?.sha)))) throw new Error('Malformed workspace branch record')
    for (const entry of value.content) if (isAbsolute(entry.path) || entry.path.split(/[\\/]/).includes('..') || !['file', 'directory', 'link'].includes(entry.kind) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0) throw new Error('Manifest content path is invalid')
    for (const entry of value.auxiliary) if (!MOUSSE_CONTROL_FILE_PATHS.includes(entry.path) || typeof entry.content !== 'string' || entry.content.length > 2 * 1024 * 1024) throw new Error('Manifest auxiliary payload is invalid')
    if (!/^[a-f0-9]{64}$/.test(value.checkoutFingerprint) || !value.rootIdentity || !Object.values(value.rootIdentity).every(Number.isFinite) || value.sparse && (typeof value.sparse.patterns !== 'string' || typeof value.sparse.cone !== 'boolean')) throw new Error('Manifest reconstruction state is invalid')
    return value
  }
  prepare(input: RetirementInput): WorktreeReconstructionManifest {
    return this.store.withGate(input.taskId, () => {
      const identity = this.inspectIdentity(input.worktreePath, input.branch, input.repositoryId)
      const source = this.verifySource({ ...input, repositoryId: identity.repositoryId })
      this.assertOwnership(input.taskId, identity.commonDir, identity.repositoryId)
      this.store.enableCleanupWriter()
      const resultSha = lifecycleGit(input.worktreePath, ['rev-parse', 'HEAD'])
      // Uncommitted files are kept as a snapshot: a worktree whose status is clean has nothing to snapshot.
      const snapshot = lifecycleGit(input.worktreePath, ['status', '--porcelain=v1', '--untracked-files=all']) ? takeSnapshot(input.worktreePath, { reason: 'retirement', threadId: input.taskId }) : undefined
      const treeSha = lifecycleGit(input.worktreePath, ['rev-parse', 'HEAD^{tree}'])
      const dirty = Boolean(snapshot && snapshot.tree !== treeSha)
      // A result the owner recorded is a commit (the HEAD) or a snapshot of the files; either way the files must still be those.
      if ((input.resultSha && input.resultSha !== resultSha) || (source.resultSha && source.resultSha !== resultSha && !sameTree(input.worktreePath, source.resultSha, snapshot?.sha ?? resultSha))) throw new Error('Workspace result changed before retirement')
      if (input.baseSha && source.baseSha && input.baseSha !== source.baseSha) throw new Error('Workspace base changed before retirement')
      const baseSha = input.baseSha ?? source.baseSha ?? resultSha
      lifecycleGit(input.worktreePath, ['cat-file', '-e', `${baseSha}^{commit}`])
      const contents = this.inspectContent(input.worktreePath, snapshot?.tree)
      const key = hash(input.worktreePath).slice(0, 32)
      const prefix = `refs/mousse/lifecycle/${this.store.profileId}/${input.taskId}/${key}`
      const headBranch = lifecycleGit(input.worktreePath, ['branch', '--show-current'])
      const manifest: WorktreeReconstructionManifest = { schemaVersion: 1, profileId: this.store.profileId, ...input, ...identity, baseSha, resultSha, treeSha, checkoutFingerprint: this.checkoutFingerprint(input.worktreePath), baseRef: `${prefix}/base`, resultRef: `${prefix}/result`, ...(dirty ? { snapshotSha: snapshot!.sha, snapshotTree: snapshot!.tree, snapshotRef: `${prefix}/snapshot` } : {}), ...(headBranch ? { headBranch } : {}), ...contents, state: 'prepared' }
      const manifestPath = this.pathFor(input.taskId, input.worktreePath)
      // Intent precedes pins. Recovery can distinguish an incomplete preparation from retirement.
      if (!existsSync(manifestPath) || JSON.stringify(JSON.parse(readFileSync(manifestPath, 'utf8'))) !== JSON.stringify(manifest)) atomicWriteJsonSync(manifestPath, manifest)
      for (const [ref, sha] of [[manifest.baseRef, baseSha], [manifest.resultRef, resultSha], ...(manifest.snapshotRef ? [[manifest.snapshotRef, manifest.snapshotSha!]] : [])]) {
        const old = readDirectLifecycleRef(input.worktreePath, ref) ?? '0'.repeat(sha.length)
        lifecycleGit(input.worktreePath, ['update-ref', '--no-deref', ref, sha, old])
      }
      this.verifyPins(manifest)
      return manifest
    })
  }
  /**
   * Moves the worktree into Mousse's trash in one step; Git's registration follows it there. Nothing is deleted and
   * nothing has to be proven unchanged first: a write that lands after `prepare` moves with the folder. The folder is
   * deleted later by `expireTrash`, after a snapshot of it, or right away when `purging` (a permanent deletion the
   * person confirmed). Owned branches whose tips the pins keep are deleted once no worktree has them checked out.
   */
  retire(manifestPath: string, options: { purging?: boolean } = {}): WorktreeReconstructionManifest {
    const manifest = this.load(manifestPath)
    return this.store.withGate(manifest.taskId, () => {
      this.assertOwnership(manifest.taskId, manifest.commonDir, manifest.repositoryId)
      this.verifyPins(manifest)
      const save = (): void => { if (!options.purging) atomicWriteJsonSync(manifestPath, manifest) }
      this.settleTrashRegistration(manifest)
      if (!existsSync(manifest.worktreePath)) {
        if (this.registered(manifest)) throw new Error('Missing worktree remains registered; recovery is required')
        // Permanent deletion: what waits in the trash goes too.
        if (options.purging && manifest.trashPath && existsSync(manifest.trashPath)) this.removeTrashed(manifest)
        manifest.state = manifest.trashPath && existsSync(manifest.trashPath) ? 'trashed' : 'retired'; save(); return manifest
      }
      this.verifySource(manifest, options.purging)
      const identity = this.inspectIdentity(manifest.worktreePath, manifest.branch, manifest.repositoryId)
      if (JSON.stringify(identity.rootIdentity) !== JSON.stringify(manifest.rootIdentity) || identity.gitDirectory !== manifest.gitDirectory || identity.commonDir !== manifest.commonDir) throw new Error('Workspace directory was replaced')
      const excluded = new Set([this.ownership?.cleanupTaskId ?? manifest.taskId])
      if (this.ownership?.cleanupTaskId) {
        const records = this.store.list()
        for (let added = true; added;) { added = false; for (const record of records) if (record.parentTaskId && excluded.has(record.parentTaskId) && record.state !== 'trashed' && !excluded.has(record.taskId)) { excluded.add(record.taskId); added = true } }
      }
      const overlaps = (left: string, right: string) => { const rel = relative(resolve(left), resolve(right)); return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) }
      const shared = getExternalResourceClaims(this.store, excluded).some((resource) => !(resource.peerProfileId === this.store.profileId && excluded.has(resource.ownerTaskId)) && isAbsolute(resource.identity) && (overlaps(resource.identity, manifest.worktreePath) || overlaps(manifest.worktreePath, resource.identity)))
      if (shared) throw new Error('Another task or profile retains this checkout; retirement is blocked')
      this.verifyPins(manifest)
      const trashPath = this.trashPathFor(manifest)
      if (existsSync(trashPath)) throw new Error(`An earlier copy of this worktree is still in the trash at ${trashPath}; it is kept`)
      mkdirSync(dirname(trashPath), { recursive: true })
      // The destination is fixed by the manifest, so a crash after the move finds the folder there.
      manifest.trashPath = trashPath; save()
      try { renameFolder(manifest.worktreePath, trashPath) }
      catch (error) { throw new Error(`The worktree could not be moved to the trash; files in it may be in use (${(error as Error).message.split(/\r?\n/)[0]})`) }
      this.settleTrashRegistration(manifest)
      if (this.registered(manifest)) throw new Error('Git still registers the worktree at its old path')
      if (options.purging) { this.removeTrashed(manifest); manifest.state = 'retired'; return manifest }
      manifest.state = 'trashed'; manifest.trashedAt = new Date().toISOString(); save()
      this.releaseBranches(manifest); save()
      return manifest
    })
  }
  /**
   * Deletes a worktree that has waited in the trash with nothing in it changing for `WORKTREE_TRASH_QUIET_MS`: a snapshot
   * of its files is pinned first (it replaces the pins `prepare` made), then Git removes it. What a snapshot cannot hold
   * (ignored or untracked files Git does not see, staged changes, an operation in progress) keeps it in the trash, and
   * the reason is returned. Needs the repository lease; the thread may be busy, since its own worktree is elsewhere.
   * Order: `inUse` (Windows: open files), then the snapshot, then a second read of the folder; a change since the
   * snapshot is captured again and the delete waits for the next run. Undefined means there was nothing to do.
   */
  expireTrash(manifestPath: string, options: { now?: number; inUse?: (path: string) => string | undefined; /** Test seam: runs between the snapshot and the check before the delete. */ afterCapture?: (path: string) => void } = {}): { removed: true } | { kept: string; waiting?: true } | undefined {
    const manifest = this.load(manifestPath)
    return this.store.withGate(manifest.taskId, () => {
      this.assertRepositoryLease(manifest.commonDir, manifest.repositoryId)
      // A move a crash interrupted before it was recorded: the folder is in the trash and starts waiting now.
      if (manifest.state === 'prepared' && manifest.trashPath && existsSync(manifest.trashPath) && !existsSync(manifest.worktreePath)) {
        this.settleTrashRegistration(manifest)
        manifest.state = 'trashed'; manifest.trashedAt = new Date(options.now ?? Date.now()).toISOString(); atomicWriteJsonSync(manifestPath, manifest)
      }
      if (manifest.state !== 'trashed' || !manifest.trashPath) return undefined
      const trashPath = manifest.trashPath
      if (!existsSync(trashPath)) {
        // Deleted by someone else: the pins from `prepare` are what is left.
        manifest.state = 'retired'; delete manifest.trashPath; delete manifest.trashedAt; atomicWriteJsonSync(manifestPath, manifest)
        return undefined
      }
      this.settleTrashRegistration(manifest)
      const now = options.now ?? Date.now()
      if (now - Date.parse(manifest.trashedAt!) < WORKTREE_TRASH_QUIET_MS) return { kept: 'Waiting in the trash', waiting: true }
      if (now - newestChange(trashPath) < WORKTREE_TRASH_QUIET_MS) return { kept: 'Files in it changed within the last hour', waiting: true }
      this.verifyPins(manifest)
      // In use (Windows: open files) is asked before anything is captured, so whatever it lets through is in the snapshot.
      const busy = options.inUse?.(trashPath)
      if (busy) return { kept: busy }
      const first = this.captureTrashed(manifestPath, manifest)
      if ('kept' in first) return first
      options.afterCapture?.(trashPath)
      // Right before the delete, the folder is read again: a change since the snapshot is captured and the delete waits.
      const again = this.trashedState(manifest)
      if (again !== first.state) {
        const retaken = this.captureTrashed(manifestPath, manifest)
        return { kept: `Files in it changed while it was being deleted${'kept' in retaken ? `; ${retaken.kept}` : '; they are kept as a snapshot'}. It is looked at again on the next run.`, waiting: true }
      }
      this.removeTrashed(manifest)
      manifest.state = 'retired'; delete manifest.trashPath; delete manifest.trashedAt
      atomicWriteJsonSync(manifestPath, manifest)
      this.releaseBranches(manifest); atomicWriteJsonSync(manifestPath, manifest)
      return { removed: true }
    })
  }
  /**
   * Takes a snapshot of the folder in the trash and pins it in place of the earlier pins (`result` at its HEAD,
   * `snapshot` when it has uncommitted files), recording both in the manifest. What a snapshot cannot hold keeps it.
   */
  private captureTrashed(manifestPath: string, manifest: WorktreeReconstructionManifest): { state: string } | { kept: string } {
    const trashPath = manifest.trashPath!
    const head = lifecycleGit(trashPath, ['rev-parse', 'HEAD'])
    const treeSha = lifecycleGit(trashPath, ['rev-parse', 'HEAD^{tree}'])
    const snapshot = lifecycleGit(trashPath, ['status', '--porcelain=v1', '--untracked-files=all']) ? takeSnapshot(trashPath, { reason: 'trash expiry', threadId: manifest.taskId }) : undefined
    const dirty = Boolean(snapshot && snapshot.tree !== treeSha)
    let contents: ReturnType<WorktreeRetirementService['inspectContent']>
    try { contents = this.inspectContent(trashPath, dirty ? snapshot!.tree : undefined) }
    catch (error) { return { kept: `Kept in the trash at ${trashPath}: ${(error as Error).message}` } }
    const prefix = manifest.resultRef.slice(0, -'/result'.length)
    lifecycleGit(trashPath, ['update-ref', '--no-deref', manifest.resultRef, head, manifest.resultSha])
    if (dirty) lifecycleGit(trashPath, ['update-ref', '--no-deref', `${prefix}/snapshot`, snapshot!.sha, readDirectLifecycleRef(trashPath, `${prefix}/snapshot`) ?? '0'.repeat(snapshot!.sha.length)])
    const headBranch = lifecycleGit(trashPath, ['branch', '--show-current'])
    // A clean folder drops the snapshot fields; an earlier snapshot ref stays where it is, as every pin does.
    delete manifest.snapshotSha; delete manifest.snapshotTree; delete manifest.snapshotRef; delete manifest.headBranch; delete manifest.sparse
    Object.assign(manifest, { resultSha: head, treeSha, ...(dirty ? { snapshotSha: snapshot!.sha, snapshotTree: snapshot!.tree, snapshotRef: `${prefix}/snapshot` } : {}), ...(headBranch ? { headBranch } : {}), ...contents })
    atomicWriteJsonSync(manifestPath, manifest)
    this.verifyPins(manifest)
    return { state: this.trashedState(manifest) }
  }
  /** What the folder in the trash holds now, to compare with what was captured: HEAD, the tree of its files and every entry's bytes. */
  private trashedState(manifest: WorktreeReconstructionManifest): string {
    const trashPath = manifest.trashPath!
    try {
      return JSON.stringify([lifecycleGit(trashPath, ['rev-parse', 'HEAD']), worktreeTree(trashPath), walkOwnedContent(trashPath, true)])
    } catch (error) { return `unreadable: ${(error as Error).message}` }
  }
  /** Points Git's registration at the trash after a move that a crash interrupted. Idempotent. */
  private settleTrashRegistration(manifest: WorktreeReconstructionManifest): void {
    const trashPath = manifest.trashPath
    if (!trashPath || !existsSync(join(trashPath, '.git')) || this.registeredAt(manifest.commonDir, trashPath)) return
    lifecycleGit(manifest.commonDir, ['worktree', 'repair', trashPath])
  }
  /** Deletes the folder in the trash through Git, so its registration goes with it. */
  private removeTrashed(manifest: WorktreeReconstructionManifest): void {
    const trashPath = manifest.trashPath!
    assertLifecyclePath(join(this.store.profileHome, 'trash'), trashPath)
    try { lifecycleGit(manifest.commonDir, ['worktree', 'remove', '--force', trashPath]) }
    catch (error) {
      // Git deleted `.git` and unregistered it, then stopped at a file in use: what is left is no checkout any more.
      if (!existsSync(trashPath) || existsSync(join(trashPath, '.git')) || this.registeredAt(manifest.commonDir, trashPath)) throw error
      rmSync(trashPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    }
    if (existsSync(trashPath) || this.registeredAt(manifest.commonDir, trashPath)) throw new Error('Git did not remove the worktree from the trash')
  }
  /**
   * Deletes the worktree's owned `mousse/*` branches whose tips the pins keep (a tip that is HEAD or the commit a pinned
   * snapshot was taken on, or an ancestor of one), unless a worktree has the branch checked out. A branch the agent made
   * itself is never touched. Each deletion is recorded so a restore brings the branch back.
   */
  private releaseBranches(manifest: WorktreeReconstructionManifest): void {
    const checkedOut = new Set(lifecycleGit(manifest.commonDir, ['worktree', 'list', '--porcelain']).split(/\r?\n/).filter((line) => line.startsWith('branch refs/heads/')).map((line) => line.slice('branch refs/heads/'.length)))
    const pins = [manifest.resultSha, manifest.snapshotSha].filter((sha): sha is string => Boolean(sha))
    for (const name of new Set([manifest.branch, manifest.headBranch])) {
      if (!name || !/^mousse\/(thread|agent|workflow)\//.test(name) || checkedOut.has(name)) continue
      const tip = this.tip(manifest, name)
      if (!tip || !pins.some((pin) => pin === tip || spawnSync('git', withoutRepoPrograms(manifest.commonDir, ['merge-base', '--is-ancestor', tip, pin]), { cwd: manifest.commonDir, env: repoProgramEnv(), stdio: 'ignore', windowsHide: true }).status === 0)) continue
      lifecycleGit(manifest.commonDir, ['update-ref', '-d', `refs/heads/${name}`, tip])
      manifest.deletedBranches = [...(manifest.deletedBranches ?? []).filter((entry) => entry.name !== name), { name, sha: tip }]
    }
  }
  /** Brings back the branches `releaseBranches` deleted, at their tips, where nothing has taken the name since. */
  private restoreBranches(manifest: WorktreeReconstructionManifest): void {
    for (const entry of manifest.deletedBranches ?? []) {
      if (!this.tip(manifest, entry.name)) lifecycleGit(manifest.commonDir, ['update-ref', `refs/heads/${entry.name}`, entry.sha, '0'.repeat(entry.sha.length)])
    }
    delete manifest.deletedBranches
  }
  /**
   * `untrusted` is for a checkout of someone else's commits: `prepare` runs on the new worktree before anything is checked
   * out into it (it puts the safety configuration in place) and `env` goes to the checkout.
   */
  reconstruct(manifestPath: string, untrusted?: { prepare(worktreePath: string): void; env: NodeJS.ProcessEnv }): WorktreeReconstructionManifest {
    const manifest = this.load(manifestPath)
    return this.store.withGate(manifest.taskId, () => {
      this.assertOwnership(manifest.taskId, manifest.commonDir, manifest.repositoryId)
      this.verifySource(manifest); this.verifyPins(manifest)
      this.settleTrashRegistration(manifest)
      if (!existsSync(manifest.worktreePath) && manifest.trashPath && existsSync(manifest.trashPath)) {
        assertLifecyclePath(dirname(manifest.worktreePath), manifest.worktreePath)
        if (this.registered(manifest)) throw new Error('Absent worktree has a stale registration')
        // Still in the trash, maybe still in use: the folder itself comes back, as it is now. Nothing is rebuilt beside it.
        mkdirSync(dirname(manifest.worktreePath), { recursive: true })
        renameFolder(manifest.trashPath, manifest.worktreePath)
        lifecycleGit(manifest.commonDir, ['worktree', 'repair', manifest.worktreePath])
        this.restoreBranches(manifest)
        const identity = this.inspectIdentity(manifest.worktreePath, manifest.branch, manifest.repositoryId)
        delete manifest.trashPath; delete manifest.trashedAt
        Object.assign(manifest, identity, { state: 'materialized' }); atomicWriteJsonSync(manifestPath, manifest)
        return manifest
      }
      if (!existsSync(manifest.worktreePath)) {
        assertLifecyclePath(dirname(manifest.worktreePath), manifest.worktreePath)
        if (this.registered(manifest)) throw new Error('Absent worktree has a stale registration')
        mkdirSync(dirname(manifest.worktreePath), { recursive: true })
        this.restoreBranches(manifest)
        // On the branch it was on when the tip is still the HEAD it had; otherwise at that HEAD, detached. The branches stay the agent's to move.
        const onBranch = [manifest.headBranch, manifest.branch].find((name) => name && this.tip(manifest, name) === manifest.resultSha)
        if (!onBranch || !this.tryAdd(manifest, [manifest.worktreePath, onBranch])) lifecycleGit(manifest.commonDir, ['worktree', 'add', '--no-checkout', '--detach', manifest.worktreePath, manifest.resultSha])
        untrusted?.prepare(manifest.worktreePath)
        if (this.checkoutFingerprint(manifest.worktreePath) !== manifest.checkoutFingerprint) throw new Error('Checkout conversion policy changed; reconstruction requires recovery')
        if (manifest.sparse) lifecycleGit(manifest.worktreePath, ['sparse-checkout', 'set', manifest.sparse.cone ? '--cone' : '--no-cone', '--stdin'], manifest.sparse.patterns)
        lifecycleGit(manifest.worktreePath, ['checkout', 'HEAD'], undefined, undefined, untrusted?.env)
        for (const auxiliary of manifest.auxiliary) {
          const target = join(manifest.worktreePath, auxiliary.path)
          assertLifecyclePath(manifest.worktreePath, target); mkdirSync(dirname(target), { recursive: true })
          writeFileSync(target, Buffer.from(auxiliary.content, 'base64'))
        }
        if (manifest.auxiliary.some((entry) => entry.path === '.mousse/materialized-inputs.exclude')) lifecycleGit(manifest.worktreePath, ['config', '--worktree', 'core.excludesFile', join(manifest.worktreePath, '.mousse', 'materialized-inputs.exclude')])
        // The uncommitted files come back as the snapshot held them, over the fresh checkout of the HEAD it was taken on.
        if (manifest.snapshotTree) moveFiles(manifest.worktreePath, manifest.treeSha, manifest.snapshotTree)
        for (const entry of manifest.content) {
          const target = join(manifest.worktreePath, entry.path)
          if (entry.kind === 'directory') { assertLifecyclePath(manifest.worktreePath, target); mkdirSync(target, { recursive: true }) }
          if (entry.kind !== 'link') { assertLifecyclePath(manifest.worktreePath, target); chmodSync(target, entry.mode & 0o777) }
        }
      }
      const identity = this.inspectIdentity(manifest.worktreePath, manifest.branch, manifest.repositoryId)
      if (lifecycleGit(manifest.worktreePath, ['rev-parse', 'HEAD^{tree}']) !== manifest.treeSha || (manifest.snapshotTree && worktreeTree(manifest.worktreePath) !== manifest.snapshotTree) || JSON.stringify(this.inspectContent(manifest.worktreePath, manifest.snapshotTree).content) !== JSON.stringify(manifest.content)) throw new Error('Reconstructed workspace does not match retained content')
      this.verifyPins(manifest)
      delete manifest.trashPath; delete manifest.trashedAt
      Object.assign(manifest, identity, { state: 'materialized' }); atomicWriteJsonSync(manifestPath, manifest)
      return manifest
    })
  }
  verifyPins(manifest: WorktreeReconstructionManifest): void {
    assertLifecyclePath(dirname(manifest.commonDir), manifest.commonDir)
    if (hash(realpathSync(manifest.commonDir).toLowerCase()).slice(0, 32) !== manifest.repositoryId) throw new Error('Repository identity is unavailable or changed')
    for (const [ref, sha] of [[manifest.baseRef, manifest.baseSha], [manifest.resultRef, manifest.resultSha], ...(manifest.snapshotRef ? [[manifest.snapshotRef, manifest.snapshotSha!]] : [])]) if (readDirectLifecycleRef(manifest.commonDir, ref) !== sha) throw new Error('Reconstruction pin changed or is unavailable')
    if (lifecycleGit(manifest.commonDir, ['rev-parse', `${manifest.resultSha}^{tree}`]) !== manifest.treeSha) throw new Error('Retained result tree changed')
    if (manifest.snapshotSha && lifecycleGit(manifest.commonDir, ['rev-parse', `${manifest.snapshotSha}^{tree}`]) !== manifest.snapshotTree) throw new Error('Retained snapshot tree changed')
  }
  private tip(manifest: WorktreeReconstructionManifest, branch: string): string | undefined {
    try { return lifecycleGit(manifest.commonDir, ['rev-parse', '--verify', '-q', `refs/heads/${branch}`]) } catch { return undefined }
  }
  /** Adds the worktree on a branch; false when Git refuses, as when another worktree has the branch checked out. */
  private tryAdd(manifest: WorktreeReconstructionManifest, target: string[]): boolean {
    try { lifecycleGit(manifest.commonDir, ['worktree', 'add', '--no-checkout', ...target]); return true } catch { return false }
  }
  private registered(manifest: WorktreeReconstructionManifest): boolean { return this.registeredAt(manifest.commonDir, manifest.worktreePath) }
  private registeredAt(commonDir: string, path: string): boolean { return lifecycleGit(commonDir, ['worktree', 'list', '--porcelain']).split(/\r?\n/).some((line) => line.startsWith('worktree ') && same(line.slice(9), path)) }
  private verifySource(input: RetirementInput, purging = false): { baseSha?: string; resultSha?: string } {
    const task = this.store.require(input.taskId)
    if (['purged', 'blocked'].includes(task.state) || task.state === 'purge-started' && (!purging || !task.purge?.items.some((item) => item.kind === 'worktree' && item.identity === input.worktreePath && item.status === 'pending'))) throw new Error('Workspace owner is unavailable for retirement or recall')
    // Locate a moved source by its relative position in the stable owner history.
    let sourcePath = input.sourcePath
    for (const location of task.locations) { const rel = relative(location, sourcePath); if (rel && !rel.startsWith('..') && !isAbsolute(rel)) { sourcePath = join(task.location, rel); break } }
    const insideTask = !relative(task.location, sourcePath).startsWith('..') && !isAbsolute(relative(task.location, sourcePath))
    if (insideTask) assertLifecyclePath(task.location, sourcePath)
    else assertLifecyclePath(this.store.profileHome, sourcePath)
    const value: unknown = JSON.parse(readFileSync(sourcePath, 'utf8'))
    if (!input.repositoryId || !/^[a-f0-9]{32}$/.test(input.repositoryId)) throw new Error('Workspace source requires verified repository identity')
    const installationHome = basename(dirname(this.store.profileHome)) === 'profiles' ? dirname(dirname(this.store.profileHome)) : this.store.profileHome
    const worktreeBase = join(installationHome, 'repositories', input.repositoryId, 'worktrees')
    const owns = (row: Record<string, unknown>): boolean => row.worktreePath === input.worktreePath && row.branch === input.branch
    let owned = false
    let baseSha: string | undefined, resultSha: string | undefined
    if (insideTask && dirname(sourcePath) === task.location && basename(sourcePath) === 'workspace.json') {
      const row = value as Record<string, unknown>
      const journal = new ThreadJournal(task.location, { readOnly: true }).list()
      const provisions = journal.filter((entry) => {
        const intent = entry.expectedPreState as { branch?: string; worktreePath?: string } | undefined
        const leaf = intent?.branch?.slice(`mousse/thread/${task.taskId}/`.length)
        return entry.schemaVersion === 1 && entry.operationType === 'workspace-provision' && entry.state === 'planned' && intent?.branch?.startsWith(`mousse/thread/${task.taskId}/`) && Boolean(leaf && /^[a-z0-9][a-z0-9_-]{0,127}$/i.test(leaf)) && typeof intent.worktreePath === 'string' && same(intent.worktreePath, input.worktreePath) && same(input.worktreePath, join(worktreeBase, 'threads', task.taskId, leaf!))
      })
      let branchOwned = provisions.some((entry) => (entry.expectedPreState as { branch?: string }).branch === input.branch)
      if (!branchOwned && typeof row.conversationBranchId === 'string') {
        const branchesPath = join(task.location, 'conversation-branches.json')
        assertLifecyclePath(task.location, branchesPath)
        const stat = lstatSync(branchesPath)
        if (!stat.isFile() || stat.size > 32 * 1024 * 1024) throw new Error('Conversation branch authority is not a bounded record')
        const branches: unknown = JSON.parse(readFileSync(branchesPath, 'utf8'))
        if (!Array.isArray(branches)) throw new Error('Conversation branch authority is invalid')
        const branch = (branches as ConversationBranch[]).find((entry) => entry?.id === row.conversationBranchId)
        if (branch && branch.creationReason === 'fork' && branch.lifecycle === 'active' && /^[a-f0-9-]{36}$/i.test(branch.id) && typeof branch.parentTurnId === 'string' && /^[a-z0-9][a-z0-9_-]{0,127}$/i.test(branch.parentTurnId) && branch.gitBranch === input.branch && input.branch === `mousse/thread/${branch.parentTurnId}/${branch.id}` && branch.retainedRef === `refs/mousse/conversation-branches/${branch.id}` && row.retainedRef === branch.retainedRef) {
          branchOwned = journal.some((entry) => {
            const details = entry.details as { branchId?: string; actionId?: string } | undefined
            if (entry.operationType !== 'conversation-fork' || entry.state !== 'completed' || details?.branchId !== branch.id || !details.actionId) return false
            return journal.some((actionEntry) => {
              const action = (actionEntry.details as { action?: ThreadAction } | undefined)?.action
              return actionEntry.operationType === 'action-checkpoint' && actionEntry.operationId === details.actionId && action?.id === details.actionId && action.turnId === branch.parentTurnId && action.conversationBranchId === branch.parentBranchId && journal.some((completed) => completed.operationType === 'action-checkpoint' && completed.operationId === action.id && completed.state === 'completed')
            })
          })
        }
      }
      owned = row.schemaVersion === 1 && row.threadId === task.taskId && provisions.length > 0 && branchOwned && owns(row)
      baseSha = typeof row.baseSha === 'string' ? row.baseSha : undefined
    } else if (insideTask && dirname(sourcePath) === task.location && basename(sourcePath) === 'agent-episodes.json') {
      const state = new AgentEpisodeStore(task.location).read()
      const episode = state.episodes.find((entry) => entry.policy.workspace === 'isolated' && entry.binding.worktreePath === input.worktreePath && entry.binding.branch === input.branch && input.branch === `mousse/agent/${entry.id}`)
      owned = Boolean(episode && same(input.worktreePath, WorktreeIdentity.forAgent(join(worktreeBase, 'agents'), episode.id).path))
      baseSha = episode?.binding.baseSha
      resultSha = episode?.result?.resultSha
    } else if (insideTask && dirname(sourcePath) === task.location && ['agents.json', 'mousse-agent-sessions.json'].includes(basename(sourcePath)) && Array.isArray(value)) {
      owned = value.some((row) => row && typeof row === 'object' && owns(row) && typeof (row.agentId ?? row.id) === 'string' && input.branch === `mousse/agent/${row.agentId ?? row.id}` && same(input.worktreePath, WorktreeIdentity.forAgent(join(worktreeBase, 'agents'), row.agentId ?? row.id).path))
    } else if (!insideTask && dirname(sourcePath) === join(this.store.profileHome, 'workflow-agent-bindings', 'workspaces') && value && typeof value === 'object' && !Array.isArray(value)) {
      const row = value as Record<string, unknown>
      const key = typeof row.idempotencyKey === 'string' ? row.idempotencyKey : ''
      const agentId = `wf-${hash(`${this.store.profileId}:${task.taskId}:${key}`).slice(0, 40)}`
      const expectedPath = WorktreeIdentity.forAgent(join(installationHome, 'wf', input.repositoryId.slice(0, 16), hash(`${this.store.profileId}:${task.taskId}`).slice(0, 24)), agentId).path
      owned = row.version === 1 && row.kind === 'git-worktree' && row.profileId === this.store.profileId && row.threadId === task.taskId && Boolean(key) && basename(sourcePath) === `${/^[a-f0-9]{64}$/i.test(key) ? key.toLowerCase() : hash(key)}.json` && row.retainedRef === `refs/mousse/workflows/${this.store.profileId}/${task.taskId}/${agentId}` && input.branch === `mousse/agent/${agentId}` && same(input.worktreePath, expectedPath) && owns(row)
      baseSha = typeof row.baseSha === 'string' ? row.baseSha : undefined
      resultSha = typeof row.resultSha === 'string' ? row.resultSha : undefined
    }
    if (!owned) throw new Error('Known source no longer owns the exact task, generated workspace location and branch; legacy or relocated checkout is retained')
    if ([baseSha, resultSha].some((sha) => sha !== undefined && !/^[a-f0-9]{40,64}$/.test(sha))) throw new Error('Owner source contains an invalid Git boundary')
    return { baseSha, resultSha }
  }
  private inspectIdentity(path: string, branch: string, expectedRepository?: string) {
    assertLifecyclePath(dirname(path), path)
    if (!isAbsolute(path) || !lstatSync(join(path, '.git')).isFile() || !/^mousse\/(thread|agent|workflow)\//.test(branch)) throw new Error('Only owned linked worktrees can retire')
    // The branch is the owner's record of the thread's own branch; the agent may have switched to another, so it is not compared with HEAD's.
    if (!same(realpathSync(path), lifecycleRead(path, ['rev-parse', '--show-toplevel']))) throw new Error('Worktree root changed')
    const commonDir = realpathSync(resolve(path, lifecycleRead(path, ['rev-parse', '--git-common-dir'])))
    const repositoryId = hash(commonDir.toLowerCase()).slice(0, 32)
    if (expectedRepository && expectedRepository !== repositoryId) throw new Error('Worktree repository changed')
    const gitDirectory = realpathSync(resolve(path, lifecycleRead(path, ['rev-parse', '--git-dir'])))
    const stat = lstatSync(path)
    const identity = { commonDir, repositoryId, gitDirectory, rootIdentity: { dev: stat.dev, ino: stat.ino, birthtimeMs: stat.birthtimeMs } }
    if (!this.registered({ ...identity, worktreePath: path } as WorktreeReconstructionManifest)) throw new Error('Worktree is not registered')
    return identity
  }
  /**
   * Throws unless the checkout holds only tracked, exactly reconstructible content. Reads only; writes nothing.
   * `snapshotTree` is the tree of the worktree's files (a snapshot, see `takeSnapshot`): uncommitted files are then
   * acceptable, because the snapshot holds them, and the files are compared with it instead of with HEAD. What a
   * snapshot does not hold is refused: staged changes, an unresolved conflict, a merge or rebase in progress, a sparse checkout.
   */
  inspectContent(path: string, snapshotTree?: string): Pick<WorktreeReconstructionManifest, 'content' | 'auxiliary' | 'sparse'> {
    if (!snapshotTree) {
      if (lifecycleRead(path, ['status', '--porcelain=v1', '--untracked-files=all'])) throw new Error('Dirty, conflicted or untracked content requires retention')
    } else {
      if (operationInProgress(path)) throw new Error('A merge, rebase or other Git operation in progress requires retention')
      if (lifecycleRead(path, ['ls-files', '-u'])) throw new Error('Conflicted content requires retention')
      if (lifecycleRead(path, ['diff', '--cached', '--name-only'])) throw new Error('Staged changes require retention')
    }
    const entries = walkOwnedContent(path, true)
    const tracked = new Map(lifecycleRead(path, ['ls-tree', '-r', '-z', snapshotTree ?? 'HEAD']).split('\0').filter(Boolean).map((line) => { const tab = line.indexOf('\t'), header = line.slice(0, tab).split(' '); return [line.slice(tab + 1), { mode: header[0], sha: header[2] }] }))
    const sparseEnabled = (() => { try { return lifecycleGit(path, ['config', '--bool', 'core.sparseCheckout']) === 'true' } catch { return false } })()
    const sparse = sparseEnabled ? { patterns: readFileSync(resolve(path, lifecycleGit(path, ['rev-parse', '--git-path', 'info/sparse-checkout'])), 'utf8'), cone: (() => { try { return lifecycleGit(path, ['config', '--bool', 'core.sparseCheckoutCone']) === 'true' } catch { return false } })() } : undefined
    // A snapshot sees a file outside the sparse patterns as deleted, so it cannot stand for the checkout.
    if (snapshotTree && sparse) throw new Error('A sparse checkout with uncommitted files requires retention')
    const skipped = new Set<string>()
    for (const flag of lifecycleRead(path, ['ls-files', '-v', '-z']).split('\0').filter(Boolean)) {
      if (/^[a-z]/.test(flag) || (flag.startsWith('S ') && (!sparse || existsSync(join(path, flag.slice(2)))))) throw new Error('Hidden index flags require explicit retention')
      if (flag.startsWith('S ')) skipped.add(flag.slice(2))
    }
    for (const name of tracked.keys()) if (!entries.some((entry) => entry.path === name) && !skipped.has(name)) throw new Error('Missing tracked content is not explained by sparse checkout')
    const auxiliary: Array<{ path: string; content: string }> = []
    const files = entries.filter((entry) => entry.kind === 'file' && tracked.has(entry.path))
    if (files.length) {
      const attributes = lifecycleGit(path, ['check-attr', '-z', '--stdin', 'filter'], files.map((entry) => entry.path).join('\0') + '\0').split('\0')
      for (let index = 2; index < attributes.length; index += 3) if (!['unspecified', 'unset'].includes(attributes[index])) throw new Error('External checkout filters require retained auxiliary payloads')
      const materialized = execFileSync('git', withoutRepoPrograms(path, ['cat-file', '--batch', '--filters', '-Z']), { cwd: path, env: repoProgramEnv(), input: files.map((entry) => `${tracked.get(entry.path)!.sha} ${entry.path}\0`).join(''), windowsHide: true, timeout: 30_000, maxBuffer: 600 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] })
      let offset = 0
      for (const entry of files) {
        const headerEnd = materialized.indexOf(0, offset)
        const header = materialized.subarray(offset, headerEnd).toString('utf8').split(' ')
        if (headerEnd < offset || header[0] !== tracked.get(entry.path)!.sha || header[1] !== 'blob') throw new Error('Incomplete materialized-content proof')
        offset = headerEnd + 1
        // Git reports the raw object size even with --filters. The expected actual byte count
        // safely delimits the proof: every digest, terminator, next header and final length must match.
        if (hash(materialized.subarray(offset, offset + entry.bytes)) !== entry.digest || materialized[offset + entry.bytes] !== 0) throw new Error('Tracked bytes cannot be reconstructed exactly from the retained result')
        offset += entry.bytes + 1
      }
      if (offset !== materialized.length) throw new Error('Materialized result has unexpected bytes')
    }
    for (const entry of entries) {
      if (entry.kind === 'directory') continue
      if (tracked.has(entry.path)) {
        const expected = tracked.get(entry.path)!
        if (expected.mode === '160000') throw new Error('Nested repository cannot be retired')
        if (entry.kind === 'link' && expected.mode !== '120000') throw new Error('Unexpected link in workspace')
        if (entry.kind === 'link' && lifecycleGit(path, ['hash-object', '--stdin'], readlinkSync(join(path, entry.path))) !== expected.sha) throw new Error('Tracked link differs from the durable result tree')
        continue
      }
      if (!MOUSSE_CONTROL_FILE_PATHS.includes(entry.path) || entry.kind !== 'file' || entry.bytes > 1024 * 1024) throw new Error(`Uncaptured ignored or untracked content requires retention: ${entry.path}`)
      auxiliary.push({ path: entry.path, content: readFileSync(join(path, entry.path)).toString('base64') })
    }
    // Modes contain platform type bits; reconstruction uses the same platform and Git checkout policy.
    return { content: entries, auxiliary, ...(sparse ? { sparse } : {}) }
  }
  private checkoutFingerprint(path: string): string {
    const read = (key: string): string => { try { return lifecycleGit(path, ['config', '--get', key]) } catch (error) { if ((error as { status?: number }).status !== 1) throw error; return '' } }
    const common = resolve(path, lifecycleGit(path, ['rev-parse', '--git-common-dir']))
    const infoAttributes = join(common, 'info', 'attributes')
    const externalAttributes = read('core.attributesFile')
    return hash(JSON.stringify({ autocrlf: read('core.autocrlf'), eol: read('core.eol'), symlinks: read('core.symlinks'), infoAttributes: existsSync(infoAttributes) ? hash(readFileSync(infoAttributes)) : '', externalAttributes, externalDigest: externalAttributes ? hash(readFileSync(externalAttributes)) : '' }))
  }
  private assertRepositoryLease(commonDir: string, repositoryId: string): void {
    const lease = this.ownership?.repositoryLease
    if (!lease || lease.owner.pid !== process.pid || lease.owner.processInstanceId !== PROCESS_INSTANCE_ID || lease.identity.key !== repositoryId || !same(lease.identity.commonDir, commonDir) || !same(lease.path, join(lease.identity.metadataDir, 'repository-mutation.lease'))) throw new Error('Retirement requires the exact held repository lease')
    const current = JSON.parse(readFileSync(lease.path, 'utf8')) as { token?: string; processInstanceId?: string }
    if (current.token !== lease.owner.token || current.processInstanceId !== PROCESS_INSTANCE_ID) throw new Error('Retirement repository ownership was lost')
  }
  private assertOwnership(taskId: string, commonDir: string, repositoryId: string): void {
    this.assertRepositoryLease(commonDir, repositoryId)
    const ownership = this.ownership!
    const task = this.store.require(taskId)
    if (ownership.taskLease) {
      assertHeldThreadLease(task.location, ownership.taskLease)
      this.store.captureAdmission(taskId, task.location)
      return
    }
    if (!ownership.cleanupTaskId) throw new Error('Retirement requires task execution ownership or an exact cleanup reservation')
    const cleanup = this.store.require(ownership.cleanupTaskId)
    if (!['trashed', 'purge-started'].includes(cleanup.state) || cleanup.generation !== ownership.cleanupGeneration || cleanup.cleanupOwner?.token !== ownership.cleanupToken || cleanup.cleanupOwner?.pid !== process.pid || cleanup.cleanupOwner?.processInstanceId !== PROCESS_INSTANCE_ID) throw new Error('Retirement cleanup ownership was lost')
    let owner = task
    const seen = new Set<string>()
    while (owner.taskId !== cleanup.taskId) {
      if (seen.has(owner.taskId) || !owner.parentTaskId || owner.state !== 'active') throw new Error('Cleanup reservation does not own this workspace')
      seen.add(owner.taskId); owner = this.store.require(owner.parentTaskId)
    }
  }
}
