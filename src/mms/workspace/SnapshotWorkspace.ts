import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { ThreadWorkspaceMetadata } from '../../shared/workspace'
import { atomicWriteJsonSync } from '../data/AtomicFs'
import { getMousseHomeDir } from '../data/paths'
import { registerHiddenStore, type HiddenStore } from '../git/hiddenStore'
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

/**
 * What a store never saves, besides the folder's own `.gitignore` files. Directories whose name says "generated
 * output" are matched only at the top of the folder, where a person's own `build/` source folder is not likely to be.
 */
export const BUILT_IN_EXCLUDES = [
  '.git/', '.mousse/', 'node_modules/', '.venv/', 'venv/', '__pycache__/', '.DS_Store',
  '/dist/', '/build/', '/target/', '/.next/', '/.cache/'
] as const

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

function storePathOf(record: SnapshotWorkspaceRecord, home = getMousseHomeDir()): string {
  if (record.kind === 'project') {
    if (!record.projectId) throw new Error('Snapshot workspace names no project.')
    return projectStorePath(record.projectId, home)
  }
  return threadStorePath(record.threadId, home)
}

function runGit(gitDir: string, args: string[]): string {
  return execFileSync('git', ['--git-dir', gitDir, ...args], { cwd: gitDir, env: repoProgramEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
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
        execFileSync('git', ['init', '--bare', '--quiet', '--template=', store.gitDir], { env: repoProgramEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
        // Git needs a work tree to add files; `--work-tree` supplies the folder, so the store itself stays independent of where it is.
        runGit(store.gitDir, ['config', 'core.bare', 'false'])
        // Mousse decides when to collect garbage (after it releases a snapshot's refs), never Git in the middle of an operation.
        runGit(store.gitDir, ['config', 'gc.auto', '0'])
        break
      } catch (error) {
        if (attempt >= 4) throw error
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 * (attempt + 1))
      }
    }
  }
  mkdirSync(join(store.gitDir, 'info'), { recursive: true })
  writeFileSync(join(store.gitDir, 'info', 'exclude'), `# Mousse: what a snapshot never holds, besides the folder's own .gitignore files.\n${BUILT_IN_EXCLUDES.join('\n')}\n`)
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

/** Removes a project's store with the project. Nothing else of the project's is touched. */
export function removeProjectSnapshots(projectId: string, home = getMousseHomeDir()): void {
  if (!/^[a-zA-Z0-9_-]{1,256}$/.test(projectId)) return
  rmSync(join(home, 'project-data', projectId), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
}

/** Removes the store of a thread with no project when the thread is deleted for good. */
export function removeThreadSnapshots(threadId: string, home = getMousseHomeDir()): void {
  if (!/^[a-zA-Z0-9_-]{1,256}$/.test(threadId)) return
  rmSync(join(home, 'thread-snapshots', threadId), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
}

/** Collects the garbage in a store Mousse owns. Never run on a repository of the person's. */
export function collectStoreGarbage(store: HiddenStore): void {
  runGit(store.gitDir, ['gc', '--prune=now', '--quiet'])
}
