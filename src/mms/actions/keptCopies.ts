import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { copyFile, lstat, rm, stat, utimes } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { atomicWriteJsonSync } from '../data/AtomicFs'
import { ThreadJournal, type ThreadJournalRecord } from '../data/ThreadJournal'
import { KEEP_COPY_OPERATIONS, PRESERVED_REFS, type KeepCopyOperation } from '../../shared/resourceLifecycle'
import { DEFAULT_UNDO_RETENTION_POLICY, retentionWindowText } from '../../shared/undoRetention'
import { gitAsync, mousseCommitEnvNow, NOT_MOUSSE, tryGitAsync } from './git'
import { UndoRetentionService } from './UndoRetentionService'

/**
 * A copy of what an action is about to remove, kept before it removes anything, under the same
 * `refs/mousse/preserved/<operation>-<12 hex>` refs a restore keeps files under (`preservedFiles.ts`). The operation is
 * recorded in its owner's journal (a thread's, or a project's data folder for the person's own checkout), so the copy
 * is that owner's: the hourly Undo retention sweep deletes it after the owner's Undo window, and a purge of a thread
 * lists it. Discard keeps one; worktree cleanup reuses it.
 *
 * The copy is one commit laid out the way `git stash` lays one out:
 * - its tree is the working versions (`git restore --source=<ref> -- <path>`);
 * - parent 1 is HEAD (an empty commit when the branch has none yet);
 * - parent 2 is the staged versions (`git restore --source=<ref>^2 --staged -- <path>`);
 * - parent 3, only when the index has a conflict, holds its stages 1–3 as `stage-1/<path>`, `stage-2/<path>` and
 *   `stage-3/<path>`.
 *
 * The staged versions are written from a private copy of the real index before anything is added to it, then the
 * working versions are added to that copy: the real index, HEAD and branches are never touched.
 */
export type { KeepCopyOperation }
export { KEEP_COPY_OPERATIONS }

/** How much one copy may hold. Over it the action is refused, naming the largest paths. Lowered by tests. */
export const KEEP_COPY_LIMITS = { bytes: 2 * 1024 ** 3 }

/** How many of the largest paths a refusal names. */
const NAMED_LARGEST = 5

export interface KeptCopy {
  operationId: string
  ref: string
  sha: string
  /** The repository folder the copy is in. */
  top: string
  stagedTree: string
  workingTree: string
  /** Set when the index had a conflict at a kept path. */
  conflictTree?: string
  /** How long the owner keeps it: its Undo window. */
  windowMs: number
}

export interface KeepCopyInput {
  /** The owner's folder: the journal the operation is recorded in, and whose Undo window it is kept for. */
  owner: string
  /** The repository's top folder. */
  top: string
  operationType: KeepCopyOperation
  /** The action, as a refusal names it: `Discard`. */
  action: string
  /** Repository-relative paths the action removes or rewrites. Without, the whole working tree but `.mousse/`. */
  paths?: readonly string[]
  /** Without `paths`: ignored files too. */
  includeIgnored?: boolean
}

/** A copy would be larger than {@link KEEP_COPY_LIMITS}, so the action was refused before anything changed. */
export class KeepCopyTooLargeError extends Error {
  readonly code = 'keep_copy_too_large'
  constructor(action: string, readonly bytes: number, readonly largest: ReadonlyArray<{ path: string; bytes: number }>) {
    super(`${action} would remove ${sizeText(bytes)} of files, more than the ${sizeText(KEEP_COPY_LIMITS.bytes)} Mousse keeps a copy of. The largest: ${largest.map((item) => `${item.path} (${sizeText(item.bytes)})`).join(', ')}. Nothing was changed. Move or commit the largest files first, then try again.`)
    this.name = 'KeepCopyTooLargeError'
  }
}

function sizeText(bytes: number): string {
  const units = ['bytes', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++ }
  return unit === 0 ? `${bytes} bytes` : `${value >= 10 || Number.isInteger(value) ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

interface KeepDetails { phase: 'intent' | 'outcome'; ref?: string; sha?: string; top?: string; interrupted?: boolean; error?: string }

const detailsOf = (entry: ThreadJournalRecord): KeepDetails | undefined => {
  const details = entry.details as Partial<KeepDetails> | undefined
  return details && (details.phase === 'intent' || details.phase === 'outcome') ? details as KeepDetails : undefined
}

const isKeepOperation = (type: string): boolean => (KEEP_COPY_OPERATIONS as readonly string[]).includes(type)

/**
 * Settles keeps that stopped between their intent and their outcome (the process ended): each is recorded as what its
 * repository holds now, `completed` when its ref is there with the commit the intent named, `failed` otherwise. Nothing
 * is written to the repository and no removal is replayed: a removal only ever starts after a `completed` outcome. A
 * keep whose folder cannot be read now stays unsettled until a later call. Returns the refs recorded as kept.
 */
export async function settleInterruptedKeeps(owner: string): Promise<string[]> {
  const journal = new ThreadJournal(owner)
  const kept: string[] = []
  for (const entry of journal.latestByOperation().values()) {
    if (!isKeepOperation(entry.operationType) || entry.state !== 'prepared') continue
    const intent = detailsOf(entry)
    if (intent?.phase !== 'intent' || !intent.ref || !intent.top) continue
    if (!existsSync(intent.top)) continue
    const found = await tryGitAsync(intent.top, ['rev-parse', '--verify', '-q', `${intent.ref}^{commit}`])
    if (!found.ok && found.stderr) continue // Git could not answer; a later call tries again.
    const present = found.ok && found.stdout === intent.sha
    journal.append({ operationId: entry.operationId, operationType: entry.operationType, state: present ? 'completed' : 'failed',
      details: { phase: 'outcome', ...(present ? { ref: intent.ref, sha: intent.sha } : {}), interrupted: true } satisfies KeepDetails })
    if (present) kept.push(intent.ref)
  }
  return kept
}

/**
 * Keeps a copy of the staged, working and conflict versions of `paths` (or the whole working tree), then returns it.
 * The caller removes the files only after this returns, and holds the repository's mutation locks.
 *
 * Order: the copy's objects are written, its intent is recorded in the owner's journal, the ref is created, and the
 * outcome is recorded. A copy over {@link KEEP_COPY_LIMITS} is refused first, with {@link KeepCopyTooLargeError}, before
 * anything is recorded or written.
 */
export async function keepCopy(input: KeepCopyInput): Promise<KeptCopy> {
  const top = resolve(input.top)
  await settleInterruptedKeeps(input.owner)
  const gitDir = await gitAsync(top, ['rev-parse', '--absolute-git-dir'])
  const realIndex = resolve(top, await gitAsync(top, ['rev-parse', '--git-path', 'index']))
  const head = (await tryGitAsync(top, ['rev-parse', '--verify', '-q', 'HEAD^{commit}'])).stdout || undefined
  // Private index files in the Git folder, named as Mousse's own (`gitPolicy`'s owned index rule).
  const working = join(gitDir, `mousse-keep-${randomUUID()}.index`)
  const stages = join(gitDir, `mousse-keep-${randomUUID()}.index`)
  const env = { GIT_INDEX_FILE: working }
  try {
    if (existsSync(realIndex)) {
      await copyFile(realIndex, working)
      // With the real index's times, Git judges an entry racily clean exactly as it does in the real index, so a file
      // changed within the same second as its entry was written is still read again. A fresh time would let Git trust
      // the entry's size and time and leave the change out of the copy.
      const times = await stat(realIndex)
      await utimes(working, times.atime, times.mtime)
    }
    else await gitAsync(top, head ? ['read-tree', head] : ['read-tree', '--empty'], env)

    const selected = input.paths ? new Set(input.paths) : undefined
    const within = (path: string): boolean => !selected || selected.has(path)
    // A conflict's stages: kept for the paths the action names; every one leaves the copy of the index, which
    // cannot be written as a tree while it has any.
    const unmerged = (await big(top, ['ls-files', '-z', '-s', '--unmerged'], env)).split('\0').filter(Boolean).map((line) => {
      const tab = line.indexOf('\t')
      const [mode, sha, stage] = line.slice(0, tab).split(' ') as [string, string, string]
      return { mode, sha, stage, path: line.slice(tab + 1) }
    })
    if (unmerged.length) await gitAsync(top, ['update-index', '-z', '--force-remove', '--stdin'], env, `${[...new Set(unmerged.map((entry) => entry.path))].join('\0')}\0`)
    const stagedTree = await gitAsync(top, ['write-tree'], env)

    // What the copy adds that the repository does not hold yet: files that differ from the index, or are not in it.
    const paths = selected ? [...selected] : await workingTreeChanges(top, env, input.includeIgnored === true)
    const sizes = await sizesOf(top, paths)
    const bytes = sizes.reduce((sum, item) => sum + item.bytes, 0)
    if (bytes > KEEP_COPY_LIMITS.bytes) throw new KeepCopyTooLargeError(input.action, bytes, [...sizes].sort((a, b) => b.bytes - a.bytes).slice(0, NAMED_LARGEST))

    if (selected) {
      // One call for every path, however many: each is added as it is on disk, or dropped when it is gone. A folder
      // (a nested repository) is left as it is in the index.
      const folders = new Set(sizes.filter((item) => item.folder).map((item) => item.path))
      const files = paths.filter((path) => !folders.has(path))
      if (files.length) await gitAsync(top, ['update-index', '-z', '--add', '--remove', '--stdin'], env, `${files.join('\0')}\0`)
    } else {
      await gitAsync(top, ['add', '-A', ...(input.includeIgnored ? ['-f'] : []), '--', '.', NOT_MOUSSE], env)
    }
    const workingTree = await gitAsync(top, ['write-tree'], env)

    const conflicts = unmerged.filter((entry) => within(entry.path))
    let conflictTree: string | undefined
    if (conflicts.length) {
      const stageEnv = { GIT_INDEX_FILE: stages }
      await gitAsync(top, ['read-tree', '--empty'], stageEnv)
      await gitAsync(top, ['update-index', '--index-info'], stageEnv, conflicts.map((entry) => `${entry.mode} ${entry.sha}\tstage-${entry.stage}/${entry.path}`).join('\n') + '\n')
      conflictTree = await gitAsync(top, ['write-tree'], stageEnv)
    }

    const commitEnv = mousseCommitEnvNow()
    const base = head ?? await gitAsync(top, ['commit-tree', await gitAsync(top, ['mktree'], undefined, ''), '-m', 'mousse: no commit yet'], commitEnv)
    const stagedCommit = await gitAsync(top, ['commit-tree', stagedTree, '-p', base, '-m', 'mousse: staged versions'], commitEnv)
    const conflictCommit = conflictTree ? await gitAsync(top, ['commit-tree', conflictTree, '-p', base, '-m', 'mousse: conflict stages'], commitEnv) : undefined
    const sha = await gitAsync(top, ['commit-tree', workingTree, '-p', base, '-p', stagedCommit, ...(conflictCommit ? ['-p', conflictCommit] : []),
      '-m', `mousse: copy kept before ${input.action}`, '-m', `Working versions: this commit. Staged versions: ^2.${conflictCommit ? ' Conflict stages: ^3, as stage-1/, stage-2/ and stage-3/.' : ''}`], commitEnv)

    const operationId = randomUUID()
    const ref = `${PRESERVED_REFS}${operationId}-${sha.slice(0, 12)}`
    const journal = new ThreadJournal(input.owner)
    journal.append({ operationId, operationType: input.operationType, state: 'prepared', details: { phase: 'intent', ref, sha, top } satisfies KeepDetails })
    try {
      // Created, never moved: an empty old value means the ref must not exist yet.
      await gitAsync(top, ['update-ref', '--no-deref', ref, sha, ''])
    } catch (error) {
      journal.append({ operationId, operationType: input.operationType, state: 'failed', details: { phase: 'outcome', error: (error as Error).message.split('\n')[0] } satisfies KeepDetails })
      throw error
    }
    journal.append({ operationId, operationType: input.operationType, state: 'completed', details: { phase: 'outcome', ref, sha } satisfies KeepDetails })
    return { operationId, ref, sha, top, stagedTree, workingTree, ...(conflictTree ? { conflictTree } : {}), windowMs: keptCopyWindowMs(input.owner) }
  } finally {
    await rm(working, { force: true })
    await rm(stages, { force: true })
  }
}

/** Git's answer to a listing that can be long: `gitAsync` allows the larger output limit when it is given input. */
function big(top: string, args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  return gitAsync(top, args, env, '')
}

/** The working tree's files that differ from the (private) index or are not in it, as a whole-tree copy adds them. */
async function workingTreeChanges(top: string, env: NodeJS.ProcessEnv, includeIgnored: boolean): Promise<string[]> {
  const changed = await big(top, ['diff-files', '-z', '--name-only', '--', '.', NOT_MOUSSE], env)
  const others = await big(top, ['ls-files', '-z', '--others', ...(includeIgnored ? [] : ['--exclude-standard']), '--', '.', NOT_MOUSSE], env)
  return [...new Set([...changed.split('\0'), ...others.split('\0')].filter(Boolean))]
}

/** The size on disk of each path that is there; a folder counts nothing, as the copy does not add it. */
async function sizesOf(top: string, paths: readonly string[]): Promise<Array<{ path: string; bytes: number; folder?: true }>> {
  const result: Array<{ path: string; bytes: number; folder?: true }> = []
  for (let start = 0; start < paths.length; start += 64) {
    const batch = await Promise.all(paths.slice(start, start + 64).map(async (path) => {
      const info = await lstat(join(top, path)).catch(() => undefined)
      if (!info) return undefined
      return info.isDirectory() ? { path, bytes: 0, folder: true as const } : { path, bytes: info.size }
    }))
    for (const item of batch) if (item) result.push(item)
  }
  return result
}

/**
 * The owner's Undo window, which is how long its copies are kept. Read from its retention record; the answer is
 * remembered until the owner's journal changes, so a status read can carry it cheaply.
 */
export function keptCopyWindowMs(owner: string): number {
  const journal = join(owner, 'journal')
  let stamp = 'none'
  try { stamp = String(statSync(journal).mtimeMs) } catch { /* no journal yet: the default policy */ }
  const cached = windows.get(owner)
  if (cached?.stamp === stamp) return cached.windowMs
  let windowMs: number
  // A retention record Mousse cannot read blocks expiry, so nothing is deleted early; the window is then the default.
  try { windowMs = new UndoRetentionService(owner, Date.now, true).policy().windowMs } catch { windowMs = DEFAULT_UNDO_RETENTION_POLICY.windowMs }
  windows.set(owner, { stamp, windowMs })
  if (windows.size > 256) windows.delete(windows.keys().next().value!)
  return windowMs
}
const windows = new Map<string, { stamp: string; windowMs: number }>()

/** What a result says about a copy: where it is, for how long, and how to bring a file back. */
export function keptCopyNotice(kept: Pick<KeptCopy, 'ref' | 'windowMs'>): string {
  return `A copy is kept for ${retentionWindowText(kept.windowMs)} as ${kept.ref}. To bring a file back: git restore --source=${kept.ref} -- <path> (its staged version: --source=${kept.ref}^2 --staged).`
}

// ---------------------------------------------------------------------------------------------------------
// The person's own checkout: copies owned by the project's data folder

const OWNER_RECORD = 'owner.json'
const PROJECT_IDENTITY = /^[A-Za-z0-9_-]{1,128}$/

interface OwnerRecord { schemaVersion: 1; projectId: string; folders: string[] }

/** The folder whose journal owns copies kept from a project's own checkout, where no thread is involved. */
export function projectKeptFilesOwner(home: string, projectId: string): string {
  if (!PROJECT_IDENTITY.test(projectId)) throw new Error('A project id names the folder that keeps its copies.')
  return join(home, 'project-data', projectId, 'kept-files')
}

/**
 * Notes that the project's copies are kept in the repository of `top`, so the hourly sweep finds them there. The
 * owner's retention clock is started by that sweep, under its locks (its pass at start-up included), never here.
 */
export function registerProjectKeptFilesFolder(owner: string, projectId: string, top: string): void {
  const path = join(owner, OWNER_RECORD)
  const record = readOwnerRecord(path) ?? { schemaVersion: 1, projectId, folders: [] }
  const folder = resolve(top)
  if (!record.folders.includes(folder)) atomicWriteJsonSync(path, { ...record, folders: [...record.folders, folder] } satisfies OwnerRecord)
}

function readOwnerRecord(path: string): OwnerRecord | undefined {
  try {
    const record = JSON.parse(readFileSync(path, 'utf8')) as Partial<OwnerRecord>
    return record.schemaVersion === 1 && typeof record.projectId === 'string' && Array.isArray(record.folders) && record.folders.every((item) => typeof item === 'string')
      ? record as OwnerRecord : undefined
  } catch {
    return undefined
  }
}

/** Every project's owner of copies kept from its own checkout, with the folders they are in. */
export function projectKeptFilesOwners(home: string): Array<{ projectId: string; owner: string; folders: string[] }> {
  let projects: string[]
  try { projects = readdirSync(join(home, 'project-data')) } catch { return [] }
  const owners: Array<{ projectId: string; owner: string; folders: string[] }> = []
  for (const projectId of projects) {
    if (!PROJECT_IDENTITY.test(projectId)) continue
    const owner = projectKeptFilesOwner(home, projectId)
    const record = readOwnerRecord(join(owner, OWNER_RECORD))
    if (record) owners.push({ projectId, owner, folders: record.folders })
  }
  return owners
}
