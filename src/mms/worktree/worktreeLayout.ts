import { chmod, lstat, mkdir, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { registerOwnedGitRoot } from '../git/gitPolicy'
import { waitForFolderAccess } from '../files/folderAccess'
import { AppError } from '../../shared/errors'

/**
 * Where Mousse puts worktrees, and whether a path is one of the places it puts them. Every place that makes, checks,
 * measures, cleans up or trashes a worktree asks here, so the layout is written down once.
 *
 * - **Default**, Mousse's own folder: `<home>/repositories/<repository key>/worktrees/threads/<thread>/<conversation
 *   branch>` for a thread, `…/worktrees/agents/<agent>` for an agent. Its trash is the profile's (`<profile>/trash`).
 * - **A worktree folder the person chose** (Settings → Storage → Worktree folder), on another drive for example:
 *   `<folder>/<project>-<short key>/<thread slug>` for a thread, `<folder>/<project>-<short key>/agents/<agent>` for an
 *   agent, where the short key is the first 12 characters of the repository key. Its trash is `<folder>/.mousse-trash`,
 *   on the same drive, because moving a folder to the trash is a rename, and a rename cannot cross drives.
 *
 * A worktree's path is recorded when it is made, and it stays there: choosing another folder only changes where new
 * worktrees go, and nothing is ever moved. So every folder chosen before that may still hold worktrees stays known
 * (`StorageSettings.previousWorktreeFolders`), and its worktrees stay Mousse's.
 *
 * Only Mousse's own folders inside a chosen folder are Mousse's: the repository folders and the trash. The central Git
 * check treats those as owned (`registerOwnedGitRoot` with `onlyChildren`); anything else in the chosen folder stays the
 * person's.
 */

/** The trash folder inside a chosen worktree folder. */
export const WORKTREE_TRASH_FOLDER = '.mousse-trash'
/** How many characters of the repository key name its folder in a chosen worktree folder. */
export const SHORT_KEY_LENGTH = 12
/** A repository's folder in a chosen worktree folder: `<project>-<short key>`. */
const REPOSITORY_FOLDER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,47}-([a-f0-9]{12})$/
/** The folders Mousse makes inside a chosen worktree folder, which the Git check treats as owned. */
export const MOUSSE_FOLDERS_IN_WORKTREE_FOLDER = /^(?:\.mousse-trash|[A-Za-z0-9][A-Za-z0-9._-]{0,47}-[a-f0-9]{12})$/
/** A thread's worktree folder name in a chosen worktree folder; also what a retirement source accepts as a leaf. */
const SLUG = /^[a-z0-9][a-z0-9_-]{0,127}$/i
/** How often a thread waiting for its drive looks again. */
export const DRIVE_POLL_MS = 2_000

const fold = (path: string): string => process.platform === 'win32' || process.platform === 'darwin' ? path.toLowerCase() : path

/** The parts of `path` below `root`, or undefined when it is not inside (or is `root` itself). */
function below(root: string, path: string): string[] | undefined {
  const rel = relative(fold(resolve(root)), fold(resolve(path)))
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined
  // The parts in the path's own spelling.
  const parts = resolve(path).slice(resolve(root).length).replace(/^[\\/]+/, '').split(/[\\/]+/).filter(Boolean)
  return parts.length ? parts : undefined
}

const same = (a: string, b: string): boolean => fold(resolve(a)) === fold(resolve(b))

// ---------------------------------------------------------------------------------------------------------
// The folders each profile chose

interface Chosen { current?: string; previous: string[] }
/** By profile folder: the worktree folder it chose and the ones it chose before. */
const chosen = new Map<string, Chosen>()
/** By chosen folder: the undo of its registration with the Git check. */
const ownedRegistrations = new Map<string, () => void>()

function syncOwnedRoots(): void {
  const known = new Set(knownWorktreeFolders())
  for (const [folder, undo] of ownedRegistrations) if (!known.has(folder)) { undo(); ownedRegistrations.delete(folder) }
  for (const folder of known) if (!ownedRegistrations.has(folder)) ownedRegistrations.set(folder, registerOwnedGitRoot(folder, { onlyChildren: MOUSSE_FOLDERS_IN_WORKTREE_FOLDER }))
}

/** By chosen folder: whether its drive keeps file modes, once looked at (`probeFileModes`). */
const keepsModes = new Map<string, boolean>()

/**
 * Whether the drive `folder` is on keeps file modes: a file made there is given 0644 and then 0755 and read back. exFAT
 * and FAT keep none (every file reads as 0700 or 0777). Remembered per folder; Windows, where Git ignores modes, always
 * says yes.
 */
export async function probeFileModes(folder: string): Promise<boolean> {
  if (process.platform === 'win32') return true
  const probe = join(folder, `.mousse-mode-check-${randomBytes(6).toString('hex')}`)
  let keeps = true
  try {
    await writeFile(probe, '', { mode: 0o644 })
    await chmod(probe, 0o644)
    const first = (await stat(probe)).mode & 0o777
    await chmod(probe, 0o755)
    const second = (await stat(probe)).mode & 0o777
    keeps = first === 0o644 && second === 0o755
  } catch { return keepsModes.get(resolve(folder)) ?? true } finally { await rm(probe, { force: true }).catch(() => undefined) }
  keepsModes.set(resolve(folder), keeps)
  return keeps
}

/** Whether `path` is in a chosen worktree folder on a drive that keeps no file modes, as last looked at. */
export function ignoresFileModes(path: string): boolean {
  const folder = chosenFolderHolding(path)
  return folder !== undefined && keepsModes.get(folder) === false
}

/**
 * Records the worktree folders of the profile at `profileHome`: the one new worktrees go to (none: Mousse's own), and
 * the ones it chose before. Every one of them is registered with the Git check as Mousse's, for its Mousse folders only.
 */
export function setWorktreeFolders(profileHome: string, settings: { worktreeFolder: string | null; previousWorktreeFolders: readonly string[] }): void {
  const current = settings.worktreeFolder ? resolve(settings.worktreeFolder) : undefined
  chosen.set(resolve(profileHome), { current, previous: settings.previousWorktreeFolders.map((folder) => resolve(folder)).filter((folder) => folder !== current) })
  syncOwnedRoots()
  // Looked at in the background: a drive that is not connected, or a permission prompt, holds nothing.
  for (const folder of knownWorktreeFolders()) if (!keepsModes.has(folder)) void folderPresent(folder).then((present) => present ? probeFileModes(folder) : undefined).catch(() => undefined)
}

/** Forgets what the profile at `profileHome` chose (the profile closed). */
export function forgetWorktreeFolders(profileHome: string): void {
  chosen.delete(resolve(profileHome))
  syncOwnedRoots()
}

/** Every worktree folder any profile chose, now or before. */
export function knownWorktreeFolders(): string[] {
  const all = new Set<string>()
  for (const entry of chosen.values()) {
    if (entry.current) all.add(entry.current)
    for (const folder of entry.previous) all.add(folder)
  }
  return [...all]
}

/**
 * The worktree folder new worktrees go to for the profile `path` is in (its home, or a thread folder inside it), or
 * undefined for Mousse's own folder.
 */
export function chosenWorktreeFolder(path: string | undefined): string | undefined {
  if (!path) return undefined
  let best: { home: string; current?: string } | undefined
  for (const [home, entry] of chosen) {
    if ((same(home, path) || below(home, path)) && (!best || home.length > best.home.length)) best = { home, current: entry.current }
  }
  return best?.current
}

// ---------------------------------------------------------------------------------------------------------
// Where a new worktree goes

/** Mousse's own folder for a repository's worktrees. */
export function defaultWorktreeBase(home: string, repositoryId: string): string {
  return join(home, 'repositories', repositoryId, 'worktrees')
}

/** A thread's worktree in Mousse's own folder. */
export function defaultThreadWorktreePath(home: string, repositoryId: string, threadId: string, conversationBranchId: string): string {
  return join(defaultWorktreeBase(home, repositoryId), 'threads', threadId, conversationBranchId)
}

/** The folder of a repository's agent worktrees in Mousse's own folder. */
export function defaultAgentWorktreeBase(home: string, repositoryId: string): string {
  return join(defaultWorktreeBase(home, repositoryId), 'agents')
}

/** A repository's folder name in a chosen worktree folder: `<project>-<short key>`, readable and unique. */
export function repositoryFolderName(projectName: string, repositoryId: string): string {
  const name = projectName.normalize('NFKD').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, 48).replace(/[._-]+$/, '')
  return `${name || 'project'}-${repositoryId.slice(0, SHORT_KEY_LENGTH).toLowerCase()}`
}

/**
 * A thread's folder name in a chosen worktree folder, from its branch `mousse/<slug>`. A branch named by ids (from before
 * branches were named after the first message) gives `thread-<id>`.
 */
export function threadSlug(branch: string | undefined, threadId: string): string {
  const own = branch?.startsWith('mousse/') ? branch.slice('mousse/'.length) : undefined
  const fallback = `thread-${threadId.replace(/[^A-Za-z0-9]/g, '').slice(0, 8).toLowerCase() || 'new'}`
  if (!own || own.includes('/')) return fallback
  const slug = own.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, 64).replace(/[_-]+$/, '')
  return SLUG.test(slug) ? slug : fallback
}

/** Whether the folder is there and is a folder, once its volume answers (a macOS permission prompt holds only this call). */
export async function folderPresent(folder: string): Promise<boolean> {
  await waitForFolderAccess([folder])
  try { return (await stat(folder)).isDirectory() } catch { return false }
}

/**
 * The repository's folder in `folder`: the one already there for its key (whatever the project was called when it was
 * made), or a new `<project>-<short key>`. Made when missing; `folder` itself never is.
 */
async function repositoryFolderIn(folder: string, projectName: string, repositoryId: string): Promise<string> {
  const key = repositoryId.slice(0, SHORT_KEY_LENGTH).toLowerCase()
  let names: string[] = []
  try { names = (await readdir(folder)).sort() } catch { /* Made below. */ }
  for (const name of names) {
    if (REPOSITORY_FOLDER.exec(name)?.[1] !== key) continue
    const found = join(folder, name)
    if ((await lstat(found).catch(() => undefined))?.isDirectory()) return found
  }
  const made = join(folder, repositoryFolderName(projectName, repositoryId))
  await mkdir(made)
  return made
}

/** `name` in `parent`, or with a short suffix from the thread's id (then a number) when something already has it. */
async function freeName(parent: string, name: string, threadId: string): Promise<string> {
  const taken = async (candidate: string): Promise<boolean> => Boolean(await lstat(join(parent, candidate)).catch(() => undefined))
  if (!await taken(name)) return join(parent, name)
  const suffix = threadId.replace(/[^A-Za-z0-9]/g, '').slice(0, 6).toLowerCase() || 'x'
  const base = `${name.slice(0, 120)}-${suffix}`
  if (!await taken(base)) return join(parent, base)
  for (let index = 2; index < 1000; index++) if (!await taken(`${base}-${index}`)) return join(parent, `${base}-${index}`)
  throw new Error(`No free folder name for the worktree in ${parent}`)
}

export interface WorktreePlacement {
  /** Where the worktree goes. Its parent folder exists; the worktree's own folder does not yet. */
  path: string
  /** The chosen worktree folder it is in; unset for Mousse's own folder. */
  folder?: string
  /** The chosen worktree folder was not there (its drive is not connected), so it went to Mousse's own folder instead. */
  notConnected?: string
}

/** What a thread is told when its worktree went to Mousse's own folder because the chosen one is not connected. */
export function notConnectedPlacementNote(folder: string): string {
  return `The worktree folder ${folder} is not connected, so this thread's worktree is in Mousse's own folder instead. Worktrees already in ${folder} stay there.`
}

/**
 * Where a new thread's worktree goes. In a chosen folder that is there: `<folder>/<project>-<short key>/<slug>`, with a
 * short suffix when the name is taken. In Mousse's own folder otherwise, which is also where it goes when the chosen
 * folder is not there (`notConnected`): the chosen folder is never made again on a drive that is not connected.
 */
export async function placeThreadWorktree(input: { home: string; folder?: string; repositoryId: string; projectName: string; threadId: string; conversationBranchId: string; branch?: string }): Promise<WorktreePlacement> {
  if (input.folder) {
    if (await folderPresent(input.folder)) {
      if (!keepsModes.has(resolve(input.folder))) await probeFileModes(input.folder)
      const repositoryFolder = await repositoryFolderIn(input.folder, input.projectName, input.repositoryId)
      return { path: await freeName(repositoryFolder, threadSlug(input.branch, input.threadId), input.threadId), folder: input.folder }
    }
  }
  const path = defaultThreadWorktreePath(input.home, input.repositoryId, input.threadId, input.conversationBranchId)
  await mkdir(dirname(path), { recursive: true })
  return { path, ...(input.folder ? { notConnected: input.folder } : {}) }
}

/** The folder a new agent worktree goes in: `<folder>/<project>-<short key>/agents` in a chosen folder that is there, Mousse's own otherwise. Made when missing. */
export async function placeAgentWorktreeBase(input: { home: string; folder?: string; repositoryId: string; projectName: string }): Promise<string> {
  const base = input.folder && await folderPresent(input.folder)
    ? join(await repositoryFolderIn(input.folder, input.projectName, input.repositoryId), 'agents')
    : defaultAgentWorktreeBase(input.home, input.repositoryId)
  await mkdir(base, { recursive: true })
  return base
}

// ---------------------------------------------------------------------------------------------------------
// Whether a path is one of Mousse's worktree places

/** Where `path` is in a chosen worktree folder's repository folder: the folder, the repository folder and the parts below it. */
export function chosenFolderPlace(path: string): { folder: string; repositoryFolder: string; shortKey: string; rest: string[] } | undefined {
  for (const folder of knownWorktreeFolders()) {
    const parts = below(folder, path)
    const key = parts && REPOSITORY_FOLDER.exec(parts[0]!)?.[1]
    if (parts && key) return { folder, repositoryFolder: join(folder, parts[0]!), shortKey: key, rest: parts.slice(1) }
  }
  return undefined
}

/** The chosen worktree folder `path` is in, as a worktree or in its trash, or undefined. */
export function chosenFolderHolding(path: string): string | undefined {
  for (const folder of knownWorktreeFolders()) {
    const parts = below(folder, path)
    if (parts && MOUSSE_FOLDERS_IN_WORKTREE_FOLDER.test(parts[0]!)) return folder
  }
  return undefined
}

const keyMatches = (shortKey: string, repositoryId: string): boolean => repositoryId.slice(0, SHORT_KEY_LENGTH).toLowerCase() === shortKey

/**
 * Whether `path` is a place a thread's worktree of the repository is made: in Mousse's own folder, exactly
 * `threads/<thread>/<conversation branch>` (or any conversation branch's when none is given); in a chosen folder, a
 * folder directly in the repository's folder, other than `agents`.
 */
export function isThreadWorktreePlace(path: string, input: { home: string; repositoryId: string; threadId: string; conversationBranchId?: string }): boolean {
  const own = join(defaultWorktreeBase(input.home, input.repositoryId), 'threads', input.threadId)
  if (input.conversationBranchId !== undefined) { if (same(path, join(own, input.conversationBranchId))) return true }
  else { const parts = below(own, path); if (parts?.length === 1 && SLUG.test(parts[0]!)) return true }
  const placed = chosenFolderPlace(path)
  return Boolean(placed && keyMatches(placed.shortKey, input.repositoryId) && placed.rest.length === 1 && placed.rest[0] !== 'agents' && SLUG.test(placed.rest[0]!))
}

/** The folders an agent worktree of the repository may be in: Mousse's own `agents` folder, and that of each of its folders in a chosen folder that is there. */
export async function agentWorktreeBases(home: string, repositoryId: string): Promise<string[]> {
  const bases = [defaultAgentWorktreeBase(home, repositoryId)]
  const key = repositoryId.slice(0, SHORT_KEY_LENGTH).toLowerCase()
  for (const folder of knownWorktreeFolders()) {
    if (!await folderPresent(folder)) continue
    let names: string[] = []
    try { names = await readdir(folder) } catch { continue }
    for (const name of names.sort()) if (REPOSITORY_FOLDER.exec(name)?.[1] === key) bases.push(join(folder, name, 'agents'))
  }
  return bases
}

/** Whether `path` is the agent's worktree in Mousse's own folder or in a chosen folder's repository folder. */
export function isAgentWorktreePlace(path: string, input: { home: string; repositoryId: string; agentId: string }): boolean {
  if (same(path, join(defaultAgentWorktreeBase(input.home, input.repositoryId), input.agentId))) return true
  const placed = chosenFolderPlace(path)
  return Boolean(placed && keyMatches(placed.shortKey, input.repositoryId) && placed.rest.length === 2 && placed.rest[0] === 'agents' && placed.rest[1] === input.agentId)
}

/** The folders where worktrees nothing names may be left: each repository's in Mousse's own folder and in each chosen folder that is there. */
export async function worktreeContainers(home: string): Promise<Array<{ path: string; repository: string; kind: 'threads' | 'agents' | 'folder'; chosen?: string }>> {
  const containers: Array<{ path: string; repository: string; kind: 'threads' | 'agents' | 'folder'; chosen?: string }> = []
  const repositories = join(home, 'repositories')
  let names: string[] = []
  try { names = await readdir(repositories) } catch { /* None yet. */ }
  for (const repository of names) for (const kind of ['threads', 'agents'] as const) containers.push({ path: join(repositories, repository, 'worktrees', kind), repository, kind })
  for (const folder of knownWorktreeFolders()) {
    if (!await folderPresent(folder)) continue
    let children: string[] = []
    try { children = await readdir(folder) } catch { continue }
    for (const name of children.sort()) {
      const key = REPOSITORY_FOLDER.exec(name)?.[1]
      if (!key) continue
      containers.push({ path: join(folder, name), repository: key, kind: 'folder', chosen: folder })
      containers.push({ path: join(folder, name, 'agents'), repository: key, kind: 'agents', chosen: folder })
    }
  }
  return containers
}

// ---------------------------------------------------------------------------------------------------------
// The trash

/** The trash a worktree at `worktreePath` is moved to: its chosen folder's, on the same drive, or the profile's. */
export function trashRootFor(worktreePath: string, profileHome: string): string {
  const placed = chosenFolderPlace(worktreePath)
  return placed ? join(placed.folder, WORKTREE_TRASH_FOLDER) : join(profileHome, 'trash')
}

/** The trash that holds `path`: a chosen worktree folder's, or the profile's. */
export function trashRootOf(path: string, profileHome: string): string {
  for (const folder of knownWorktreeFolders()) {
    const root = join(folder, WORKTREE_TRASH_FOLDER)
    if (below(root, path)) return root
  }
  return join(profileHome, 'trash')
}

// ---------------------------------------------------------------------------------------------------------
// A drive that is not connected

/** What a thread whose worktree is on a drive that is not connected says. */
export function driveNotConnectedText(folder: string): string {
  return `Drive not connected: ${folder}`
}

/**
 * The chosen worktree folder holding `path` (a worktree or its trash) when that folder is not there, which is how a
 * drive that is not connected looks; undefined when `path` is not in a chosen folder or the folder is there. Such a
 * worktree is there but out of reach: never missing, never deleted, never rebuilt in its place.
 */
export async function disconnectedWorktreeFolder(path: string | undefined): Promise<string | undefined> {
  const folder = path ? chosenFolderHolding(path) : undefined
  return folder && !await folderPresent(folder) ? folder : undefined
}

/**
 * A thread's worktree is on a drive that is not connected. The thread waits for it; nothing about the worktree changes,
 * so it carries on as it was once the drive is back.
 */
export class DriveNotConnectedError extends AppError {
  constructor(readonly folder: string) {
    super({ code: 'workspace_drive_not_connected', message: driveNotConnectedText(folder), errorInfo: { category: 'unavailable', retryable: true }, details: { folder } })
  }
}

/** Refuses with {@link DriveNotConnectedError} when `path` is in a chosen worktree folder that is not there. */
export async function assertWorktreeFolderConnected(path: string | undefined): Promise<void> {
  const folder = await disconnectedWorktreeFolder(path)
  if (folder) throw new DriveNotConnectedError(folder)
}

/** Waits until `folder` is there again, looking every {@link DRIVE_POLL_MS}; `signal` ends the wait with its reason. */
export async function waitForWorktreeFolder(folder: string, signal?: AbortSignal, pollMs = DRIVE_POLL_MS): Promise<void> {
  while (!await folderPresent(folder)) {
    if (signal?.aborted) throw signal.reason
    await new Promise<void>((settle, reject) => {
      const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); settle() }, pollMs)
      const onAbort = (): void => { clearTimeout(timer); reject(signal!.reason) }
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }
}

// ---------------------------------------------------------------------------------------------------------
// Choosing a folder

/** Why a folder cannot be the worktree folder, as the person reads it. */
export class WorktreeFolderRefused extends Error {
  constructor(message: string) { super(message); this.name = 'WorktreeFolderRefused' }
}

/**
 * Checks a folder the person chose for new worktrees and returns its real path; refuses with the reason otherwise. It
 * must be a full path, outside Mousse's own data folder, not inside a Git checkout, not holding a repository of the
 * person's own at its top, and writable. It is made when it does not exist yet (its parent must). Every access waits
 * for the folder's volume first, so a permission prompt for an external drive holds only this request.
 */
export async function checkWorktreeFolder(folder: string, home: string): Promise<string> {
  if (typeof folder !== 'string' || !folder.trim() || folder.includes('\0') || !isAbsolute(folder)) throw new WorktreeFolderRefused('Choose a folder by its full path.')
  const requested = resolve(folder)
  await waitForFolderAccess([requested, dirname(requested)])
  const realHome = await realpath(home).catch(() => resolve(home))
  const realOf = async (path: string): Promise<string> => {
    const missing: string[] = []
    for (let at = path; ; at = dirname(at)) {
      const real = await realpath(at).catch(() => undefined)
      if (real) return join(real, ...missing.reverse())
      if (dirname(at) === at) return path
      missing.push(basename(at))
    }
  }
  const real = await realOf(requested)
  if (same(real, realHome) || below(realHome, real) || below(real, realHome)) throw new WorktreeFolderRefused("This folder is part of Mousse's own data folder. Choose Default to keep worktrees there.")
  // Inside a checkout: Git would see the worktrees as files of that repository.
  for (let at = dirname(real); ; at = dirname(at)) {
    if (await lstat(join(at, '.git')).catch(() => undefined)) throw new WorktreeFolderRefused(`This folder is inside the Git repository ${at}. Choose a folder outside any repository.`)
    if (dirname(at) === at) break
  }
  if (await lstat(join(real, '.git')).catch(() => undefined)) throw new WorktreeFolderRefused(`This folder is a Git repository. Choose a folder outside any repository.`)
  const existing = await stat(real).catch(() => undefined)
  if (existing && !existing.isDirectory()) throw new WorktreeFolderRefused('This is a file, not a folder.')
  if (existing) {
    for (const name of (await readdir(real)).sort()) {
      if (MOUSSE_FOLDERS_IN_WORKTREE_FOLDER.test(name)) continue
      if (await lstat(join(real, name, '.git')).catch(() => undefined)) throw new WorktreeFolderRefused(`This folder holds the Git repository ${join(real, name)}. Choose an empty folder, or one only Mousse's worktrees are in.`)
    }
  } else {
    if (!(await stat(dirname(real)).catch(() => undefined))?.isDirectory()) throw new WorktreeFolderRefused(`The folder ${dirname(real)} does not exist.`)
    try { await mkdir(real) } catch (error) { throw new WorktreeFolderRefused(`Mousse can't make this folder: ${(error as Error).message}`) }
  }
  const probe = join(real, `.mousse-write-check-${randomBytes(6).toString('hex')}`)
  try { await writeFile(probe, ''); await rm(probe, { force: true }) } catch (error) {
    throw new WorktreeFolderRefused(`Mousse can't write in this folder: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`)
  }
  const checked = await realpath(real)
  await probeFileModes(checked)
  return checked
}

/** Whether a chosen folder still holds anything of Mousse's: a repository folder or a trash with anything in it. Unknown (not there) counts as holding. */
export async function worktreeFolderHoldsWorktrees(folder: string): Promise<boolean> {
  if (!await folderPresent(folder)) return true
  let names: string[] = []
  try { names = await readdir(folder) } catch { return true }
  for (const name of names) {
    if (!MOUSSE_FOLDERS_IN_WORKTREE_FOLDER.test(name)) continue
    try { if ((await readdir(join(folder, name))).length) return true } catch { return true }
  }
  return false
}
