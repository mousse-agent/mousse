import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { ThreadWorkspaceMetadata } from '../../shared/workspace'
import { atomicWriteJsonSync } from '../data/AtomicFs'
import { getMousseHomeDir } from '../data/paths'
import { BUILT_IN_EXCLUDES, ensureStoreRules, inHiddenStore, insideFolder, isolatedEnv, registerHiddenStore, type HiddenStore } from '../git/hiddenStore'
import { repoProgramEnv } from '../git/repoPrograms'
import { isUnsafeSnapshotRoot, SnapshotRefusedError } from '../actions/snapshots'

/**
 * Snapshot workspaces (docs/workspace-snapshots.md, "Folders without Git"): a thread whose folder has no Git Mousse may
 * use (a project that is not a Git repository, or has no commit yet, and a thread with no project, which runs in a
 * scratch folder) records its turns as snapshots in a hidden store, the same way a Git thread does in its worktree.
 *
 * The thread's own record is `snapshot-workspace.json`. It is deliberately not `workspace.json`: that file means "Mousse
 * made this worktree and may retire, rebuild and delete it", and the folder here is the person's.
 */
export const SNAPSHOT_WORKSPACE_FILE = 'snapshot-workspace.json'

/** What a store never saves, besides the folder's own `.gitignore` files (see `hiddenStore.ts`). */
export { BUILT_IN_EXCLUDES }

export interface SnapshotWorkspaceRecord {
  schemaVersion: 1
  /** `project`: the folder is a project's; the store is shared by the project's threads. `standalone`: a thread with no project; the store is the thread's own. */
  kind: 'project' | 'standalone'
  threadId: string
  /** The folder the agent works in. */
  workTree: string
  projectId?: string
  /** The thread's latest snapshot, as `workspace.json` `snapshotSha` is for a worktree. */
  snapshotSha?: string
  /** Snapshots are off for the folder, and why; cleared by the next turn that can take one. */
  off?: { reason: string; at: string }
}

export interface SnapshotWorkspace {
  record: SnapshotWorkspaceRecord
  store: HiddenStore
  threadDirectory: string
}

/** The store of a project that is not a Git repository, shared by its threads. */
export function projectStorePath(projectId: string, home = getMousseHomeDir()): string {
  return join(home, 'project-data', projectId, 'snapshots.git')
}

/**
 * The store of a thread that has no project. It is kept beside the project stores, not inside the thread's own folder: a
 * permanent delete reads and bounds everything in that folder, and a store can be large. It is removed when the thread is
 * deleted for good (`removeThreadSnapshots`).
 */
export function threadStorePath(threadId: string, home = getMousseHomeDir()): string {
  return join(home, 'thread-snapshots', threadId, 'snapshots.git')
}

export function snapshotWorkspacePath(threadDirectory: string): string {
  return join(threadDirectory, SNAPSHOT_WORKSPACE_FILE)
}

const STORAGE_IDENTITY = /^[a-zA-Z0-9_-]{1,256}$/

/** The store a record names. The ids come from a file, so they are checked before they become part of a path. */
function storePathOf(record: SnapshotWorkspaceRecord, home = getMousseHomeDir()): string {
  if (record.kind === 'project') {
    if (!record.projectId || !STORAGE_IDENTITY.test(record.projectId)) throw new Error('Snapshot workspace names no valid project.')
    return projectStorePath(record.projectId, home)
  }
  if (!STORAGE_IDENTITY.test(record.threadId)) throw new Error('Snapshot workspace names no valid thread.')
  return threadStorePath(record.threadId, home)
}

/** Git on the store itself, isolated from the person's config like every store command. */
function runGit(store: HiddenStore, args: string[]): string {
  return execFileSync('git', ['--git-dir', store.gitDir, ...args], { cwd: store.gitDir, env: isolatedEnv(store, repoProgramEnv()), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

/** Whether a store that exists has the settings `prepareStore` gives it (a creation another thread started may not have finished). */
function storeConfigured(store: HiddenStore): boolean {
  try {
    const config = readFileSync(join(store.gitDir, 'config'), 'utf8')
    return /^\s*bare\s*=\s*false\s*$/m.test(config) && /^\s*auto\s*=\s*0\s*$/m.test(config)
  } catch { return false }
}

/**
 * Makes the store if it is missing and writes its settings and exclude list; the same call keeps an older store current.
 * Two threads of one project may start their first turns together, so a creation that meets the other's lock is tried again.
 */
export function prepareStore(store: HiddenStore): void {
  if (!existsSync(join(store.gitDir, 'HEAD')) || !storeConfigured(store)) {
    for (let attempt = 0; ; attempt++) {
      try {
        mkdirSync(store.gitDir, { recursive: true })
        // No template: the person's init.templateDir would put its hooks and files into Mousse's store.
        execFileSync('git', ['init', '--bare', '--quiet', '--template=', store.gitDir], { env: isolatedEnv(store, repoProgramEnv()), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
        // Git needs a work tree to add files; `--work-tree` supplies the folder, so the store itself stays independent of where it is.
        runGit(store, ['config', 'core.bare', 'false'])
        // Mousse decides when to collect garbage (after it releases a snapshot's refs), never Git in the middle of an operation.
        runGit(store, ['config', 'gc.auto', '0'])
        break
      } catch (error) {
        if (attempt >= 4) throw error
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 * (attempt + 1))
      }
    }
  }
  // A new store gets its exclude list and attributes now; each snapshot keeps them current under the store's lock.
  if (!existsSync(join(store.gitDir, 'info', 'exclude'))) ensureStoreRules(store)
}

/** The thread's record, whether or not its folder or store is still there. */
export function readSnapshotWorkspaceRecord(threadDirectory: string): SnapshotWorkspaceRecord | undefined {
  try {
    const value = JSON.parse(readFileSync(snapshotWorkspacePath(threadDirectory), 'utf8')) as Partial<SnapshotWorkspaceRecord>
    if (value.schemaVersion !== 1 || (value.kind !== 'project' && value.kind !== 'standalone') || typeof value.threadId !== 'string' || typeof value.workTree !== 'string') return undefined
    return value as SnapshotWorkspaceRecord
  } catch {
    return undefined
  }
}

function writeRecord(threadDirectory: string, record: SnapshotWorkspaceRecord): void {
  atomicWriteJsonSync(snapshotWorkspacePath(threadDirectory), record)
}

export interface EnsureSnapshotWorkspaceInput {
  threadDirectory: string
  threadId: string
  /** The folder the agent works in. */
  workTree: string
  /** The project, for a folder that is a project's. Absent for a thread with no project. */
  projectId?: string
  home?: string
}

/**
 * The thread's snapshot workspace for `workTree`, made if it is not there yet. Refuses a folder that must never be
 * snapshotted (a home or system folder) and one that is not a folder. The store is registered so that operations on
 * the folder find it.
 */
export function ensureSnapshotWorkspace(input: EnsureSnapshotWorkspaceInput): SnapshotWorkspace {
  const workTree = realpathSync.native(resolve(input.workTree))
  if (!statSync(workTree).isDirectory()) throw new SnapshotRefusedError('Undo is off for this folder because it is not a folder.')
  if (isUnsafeSnapshotRoot(workTree)) throw new SnapshotRefusedError('Undo is off for this folder because it is a home or system folder.')
  const kind = input.projectId ? 'project' : 'standalone'
  const existing = readSnapshotWorkspaceRecord(input.threadDirectory)
  // A thread keeps its history when the folder it works in changes (another provider's scratch folder): the pin and the receipts stay.
  const record: SnapshotWorkspaceRecord = {
    schemaVersion: 1, kind, threadId: input.threadId, workTree,
    ...(input.projectId ? { projectId: input.projectId } : {}),
    ...(existing?.kind === kind && existing.projectId === input.projectId && existing.snapshotSha ? { snapshotSha: existing.snapshotSha } : {}),
    ...(existing?.off ? { off: existing.off } : {})
  }
  const store = registerHiddenStore({ workTree, gitDir: storePathOf(record, input.home) })
  prepareStore(store)
  // A project's store keeps a note of each thread that uses it: it stays while any does (`retireProjectSnapshots`).
  if (kind === 'project') noteSnapshotStoreUser(store.gitDir, input.threadId)
  if (JSON.stringify(existing) !== JSON.stringify(record)) writeRecord(input.threadDirectory, record)
  return { record, store, threadDirectory: input.threadDirectory }
}

/** The thread's snapshot workspace, with its store registered; undefined when the thread has none or its store is gone. */
export function loadSnapshotWorkspace(threadDirectory: string, home?: string): SnapshotWorkspace | undefined {
  const record = readSnapshotWorkspaceRecord(threadDirectory)
  if (!record || !existsSync(record.workTree)) return undefined
  let gitDir: string
  try { gitDir = storePathOf(record, home) } catch { return undefined }
  if (!existsSync(join(gitDir, 'HEAD'))) return undefined
  const workTree = realpathSync.native(record.workTree)
  return { record, store: registerHiddenStore({ workTree, gitDir }), threadDirectory }
}

/**
 * Says why snapshots are off for the thread's folder, or, with no reason, that they are on again. A thread that has no
 * record yet (its folder was refused before a store was made) gets one from `folder`, which has no store and so
 * never counts as a snapshot workspace.
 */
export function setSnapshotsOff(threadDirectory: string, reason: string | undefined, folder?: { threadId: string; workTree: string; projectId?: string }): void {
  const record = readSnapshotWorkspaceRecord(threadDirectory) ?? (reason !== undefined && folder
    ? { schemaVersion: 1 as const, kind: folder.projectId ? 'project' as const : 'standalone' as const, threadId: folder.threadId, workTree: resolve(folder.workTree), ...(folder.projectId ? { projectId: folder.projectId } : {}) }
    : undefined)
  if (!record) return
  if (reason === undefined) {
    if (!record.off) return
    const { off: _off, ...rest } = record
    writeRecord(threadDirectory, rest)
  } else if (record.off?.reason !== reason) {
    writeRecord(threadDirectory, { ...record, off: { reason, at: new Date().toISOString() } })
  }
}

/** The reason snapshots are off for the thread's folder, if they are. */
export function snapshotsOffReason(threadDirectory: string): string | undefined {
  return readSnapshotWorkspaceRecord(threadDirectory)?.off?.reason
}

/** Caches the thread's latest snapshot, the way `workspace.json` does for a worktree. */
export function recordSnapshotSha(threadDirectory: string, sha: string): void {
  const record = readSnapshotWorkspaceRecord(threadDirectory)
  if (record && record.snapshotSha !== sha) writeRecord(threadDirectory, { ...record, snapshotSha: sha })
}

/** The ref that pins the thread's latest snapshot. */
export function threadPinRef(threadId: string, branchId = 'main'): string {
  return `refs/mousse/threads/${threadId}/${branchId}`
}

/**
 * The record as the metadata the Undo, review and retention code reads from `workspace.json`, so that code needs no
 * second path. It never reaches a file; every worktree rule (retirement, cleanup, rebuilding) reads the real file.
 */
export function snapshotWorkspaceMetadata(workspace: SnapshotWorkspace): ThreadWorkspaceMetadata {
  const { record } = workspace
  return {
    schemaVersion: 1,
    threadId: record.threadId,
    repositoryId: `snapshot:${record.kind}`,
    conversationBranchId: 'main',
    branch: '',
    retainedRef: threadPinRef(record.threadId),
    worktreePath: record.workTree,
    projectRelativeSubdirectory: '.',
    baseSha: '',
    headSha: '',
    ...(record.snapshotSha ? { snapshotSha: record.snapshotSha } : {}),
    lifecycle: 'ready',
    lastVerifiedAt: new Date().toISOString(),
    workspaceId: `snapshot:${record.threadId}`,
    provenance: { ownerThreadId: record.threadId },
    snapshotOnly: true
  }
}

/** `snapshotWorkspaceMetadata` of the thread's workspace, with its store registered. */
export function loadSnapshotWorkspaceMetadata(threadDirectory: string): ThreadWorkspaceMetadata | undefined {
  const workspace = loadSnapshotWorkspace(threadDirectory)
  return workspace ? snapshotWorkspaceMetadata(workspace) : undefined
}

/**
 * The hidden store the thread records its turns in, when `cwd` is in its folder. Read from the thread's own record, never
 * from the folder: a person who runs `git init` in the folder later gets their repository, and this thread keeps its store.
 */
export function threadSnapshotStore(threadDirectory: string, cwd: string): HiddenStore | undefined {
  const store = loadSnapshotWorkspace(threadDirectory)?.store
  if (!store) return undefined
  const path = resolve(cwd)
  let real = path
  try { real = realpathSync.native(path) } catch { /* a path that is gone is compared as given */ }
  return insideFolder(store.workTree, path) || insideFolder(store.workTree, real) ? store : undefined
}

/** Runs `operation` with Mousse's Git commands in `cwd` going through the thread's store, when it has one for that folder. */
export function inThreadSnapshotScope<T>(threadDirectory: string, cwd: string, operation: () => T): T {
  const store = threadSnapshotStore(threadDirectory, cwd)
  return store ? inHiddenStore(store, operation) : operation()
}

/**
 * Whether the thread started in a project folder's hidden store: a snapshot of it was recorded there. It keeps that
 * store for the rest of its life, even when the folder later becomes a Git repository. A thread whose turns were all
 * refused (a folder too large) recorded nothing there and uses the repository like a new thread.
 */
export function startedInSnapshotStore(threadDirectory: string): boolean {
  const record = readSnapshotWorkspaceRecord(threadDirectory)
  return record?.kind === 'project' && Boolean(record.snapshotSha)
}

/** How long a store waits in Mousse's trash before it is deleted: the same as a retired worktree (`WORKTREE_TRASH_QUIET_MS`). */
export const SNAPSHOT_TRASH_QUIET_MS = 60 * 60_000

const usersDirectory = (gitDir: string): string => join(gitDir, 'mousse', 'threads')
const PROJECT_REMOVED = 'project-removed'

/** Notes that the thread records its turns in the store. */
export function noteSnapshotStoreUser(gitDir: string, threadId: string): void {
  if (!STORAGE_IDENTITY.test(threadId)) return
  const path = join(usersDirectory(gitDir), threadId)
  if (existsSync(path)) return
  mkdirSync(usersDirectory(gitDir), { recursive: true })
  writeFileSync(path, '')
}

/** Notes that the thread no longer uses the store (it was deleted for good). */
export function dropSnapshotStoreUser(gitDir: string, threadId: string): void {
  if (STORAGE_IDENTITY.test(threadId)) rmSync(join(usersDirectory(gitDir), threadId), { force: true })
}

function storeUsers(gitDir: string): string[] {
  try { return readdirSync(usersDirectory(gitDir)) } catch { return [] }
}

/** Where stores wait before they are deleted. */
export function snapshotTrashRoot(home = getMousseHomeDir()): string {
  return join(home, 'trash', 'snapshot-stores')
}

/**
 * Moves a store's folder (`project-data/<id>` or `thread-snapshots/<id>`) into Mousse's trash in one rename, with the
 * time it went there. Nothing is deleted: `expireSnapshotTrash` deletes it after `SNAPSHOT_TRASH_QUIET_MS`.
 */
export function trashSnapshotFolder(folder: string, label: string, home = getMousseHomeDir()): string | undefined {
  if (!existsSync(folder)) return undefined
  const root = snapshotTrashRoot(home)
  mkdirSync(root, { recursive: true })
  const target = join(root, `${label}-${Date.now()}-${randomUUID().slice(0, 8)}`)
  renameSync(folder, target)
  writeFileSync(join(target, 'trashed.json'), JSON.stringify({ trashedAt: new Date().toISOString(), from: folder }))
  return target
}

/**
 * A project was removed. Its store stays while any thread still records its turns there (those threads keep their
 * Undo, and the files kept under `refs/mousse/preserved/` stay with them); it is marked so the last thread to go moves
 * it to the trash (`releaseThreadSnapshots`). With no thread left, it moves to the trash now.
 */
export function retireProjectSnapshots(projectId: string, home = getMousseHomeDir()): 'kept' | 'trashed' | 'none' {
  if (!STORAGE_IDENTITY.test(projectId)) return 'none'
  const folder = join(home, 'project-data', projectId)
  const gitDir = projectStorePath(projectId, home)
  if (!existsSync(folder)) return 'none'
  if (storeUsers(gitDir).length) {
    mkdirSync(join(gitDir, 'mousse'), { recursive: true })
    writeFileSync(join(gitDir, 'mousse', PROJECT_REMOVED), new Date().toISOString())
    return 'kept'
  }
  return trashSnapshotFolder(folder, `project-${projectId}`, home) ? 'trashed' : 'none'
}

/** After a thread of a removed project let go of its store: the store goes to the trash once no thread uses it. */
export function trashProjectStoreIfUnused(projectId: string, home = getMousseHomeDir()): boolean {
  if (!STORAGE_IDENTITY.test(projectId)) return false
  const gitDir = projectStorePath(projectId, home)
  if (!existsSync(join(gitDir, 'mousse', PROJECT_REMOVED)) || storeUsers(gitDir).length) return false
  return Boolean(trashSnapshotFolder(join(home, 'project-data', projectId), `project-${projectId}`, home))
}

/** Moves the store of a thread with no project to the trash when the thread is deleted for good. */
export function removeThreadSnapshots(threadId: string, home = getMousseHomeDir()): void {
  if (!STORAGE_IDENTITY.test(threadId)) return
  trashSnapshotFolder(join(home, 'thread-snapshots', threadId), `thread-${threadId}`, home)
}

/** Deletes the stores that have waited in the trash for `SNAPSHOT_TRASH_QUIET_MS`. Returns what it deleted and what it kept. */
export function expireSnapshotTrash(now = Date.now(), home = getMousseHomeDir()): Array<{ name: string; removed: boolean; reason: string }> {
  const root = snapshotTrashRoot(home)
  let names: string[]
  try { names = readdirSync(root) } catch { return [] }
  return names.map((name) => {
    const folder = join(root, name)
    let trashedAt = Number.NaN
    try { trashedAt = Date.parse((JSON.parse(readFileSync(join(folder, 'trashed.json'), 'utf8')) as { trashedAt?: string }).trashedAt ?? '') } catch { /* read below */ }
    if (Number.isNaN(trashedAt)) {
      try { trashedAt = statSync(folder).mtimeMs } catch { return { name, removed: false, reason: 'Could not be read' } }
    }
    if (now - trashedAt < SNAPSHOT_TRASH_QUIET_MS) return { name, removed: false, reason: 'Waiting in the trash' }
    try {
      rmSync(folder, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
      return { name, removed: true, reason: 'Deleted from the trash after an hour' }
    } catch (error) {
      return { name, removed: false, reason: (error as Error).message }
    }
  })
}

/** Collects the garbage in a store Mousse owns. Never run on a repository of the person's. */
export function collectStoreGarbage(store: HiddenStore): void {
  runGit(store, ['gc', '--prune=now', '--quiet'])
}
