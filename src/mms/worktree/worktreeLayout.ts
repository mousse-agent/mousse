import { execFile } from 'node:child_process'
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs'
import { chmod, lstat, mkdir, readdir, readFile, realpath, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { registerOwnedGitRoot } from '../git/gitPolicy'
import { repositoryKeyOf } from '../git/RepositoryIdentity'
import { waitForFolderAccess } from '../files/folderAccess'
import { AppError } from '../../shared/errors'
import type { WorktreeFolderEntry } from '../../shared/settings'

/**
 * Where Mousse puts worktrees, and whether a path is one of the places it puts them. Every place that makes, checks,
 * measures, cleans up or trashes a worktree asks here, so the layout is written down once.
 *
 * - **Default**, Mousse's own folder: `<home>/repositories/<repository key>/worktrees/threads/<thread>/<conversation
 *   branch>` for a thread, `…/worktrees/agents/<agent>` for an agent. Its trash is the profile's (`<profile>/trash`).
 * - **A worktree folder the person chose** (Settings → Storage → Worktree folder), on another drive for example:
 *   `<folder>/<project>-<short key>/<thread slug>-<thread tag>` for a thread, `<folder>/<project>-<short key>/agents/<agent>`
 *   for an agent. The short key is the first 12 characters of the repository key, and the thread tag the first 6 of the
 *   thread's id, so no two threads ever get the same folder. Its trash is `<folder>/.mousse-trash`, on the same drive,
 *   because moving a folder to the trash is a rename, and a rename cannot cross drives.
 *
 * **What makes a folder the one chosen.** When the person chooses a folder, Mousse writes `.mousse-worktrees.json` in it,
 * with a random id, and records the id with the folder. The folder counts as connected only while it holds that id: an
 * empty mount point, another drive mounted at the same path, or the person's own folder there is "not connected". Each
 * repository's folder Mousse makes there holds `.mousse-repository.json`, with the folder's id and the repository's key.
 *
 * **What is Mousse's there.** Only the folders Mousse made, as their markers say, and only while the folder is connected:
 * the repository folders and the trash. They are registered with the central Git check as owned; anything else in the
 * chosen folder stays the person's, whatever it is called.
 *
 * A worktree's path is recorded when it is made, and it stays there: choosing another folder only changes where new
 * worktrees go, and nothing is ever moved. So every folder chosen before stays known while anything of Mousse's names a
 * path in it (`StorageSettings.previousWorktreeFolders`), and its worktrees stay Mousse's.
 *
 * Drives that keep no file modes (exFAT, FAT, most SMB shares) are refused when chosen: a linked worktree reads its
 * repository's config, made on another disk, so every file there would read as changed, and macOS adds `._` files.
 */

/** The trash folder inside a chosen worktree folder. */
export const WORKTREE_TRASH_FOLDER = '.mousse-trash'
/** The marker of a chosen worktree folder: its id. */
export const WORKTREE_FOLDER_MARKER = '.mousse-worktrees.json'
/** The marker of a repository's folder Mousse made in a chosen worktree folder. */
export const REPOSITORY_FOLDER_MARKER = '.mousse-repository.json'
/** How many characters of the repository key name its folder in a chosen worktree folder. */
export const SHORT_KEY_LENGTH = 12
/** How many characters of the thread's id end its worktree's folder name in a chosen worktree folder. */
export const THREAD_TAG_LENGTH = 6
/** A thread's worktree folder name in a chosen worktree folder; also what a retirement source accepts as a leaf. */
const SLUG = /^[a-z0-9][a-z0-9_-]{0,127}$/i
/** Names a thread's folder never takes in a repository's folder: its agents' folder and its marker. */
const RESERVED_NAMES = new Set(['agents', WORKTREE_TRASH_FOLDER, REPOSITORY_FOLDER_MARKER])
/** How often a thread waiting for its drive looks again. */
export const DRIVE_POLL_MS = 2_000
const MARKER_ID = /^[a-f0-9]{32}$/
const REPOSITORY_ID = /^[a-f0-9]{32}$/

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

/** The tag of a thread's id that ends its worktree's folder name: its first six letters and digits. */
export function threadTag(threadId: string): string {
  return threadId.replace(/[^A-Za-z0-9]/g, '').slice(0, THREAD_TAG_LENGTH).toLowerCase() || 'thread'
}

// ---------------------------------------------------------------------------------------------------------
// The folders each profile chose, and what is verified Mousse's in them

interface Chosen { current?: WorktreeFolderEntry; previous: WorktreeFolderEntry[] }
/** By profile folder: the worktree folder it chose and the ones it chose before. */
const chosen = new Map<string, Chosen>()
/** By verified repository folder: the chosen folder it is in, the repository it is for, and the undo of its ownership. */
const repositoryFolders = new Map<string, { folder: string; repositoryId: string; undo: () => void }>()
/** By chosen folder: the undo of its trash's ownership, while it is connected. */
const trashOwnership = new Map<string, () => void>()

/**
 * Records the worktree folders of the profile at `profileHome`: the one new worktrees go to (none: Mousse's own), and
 * the ones it chose before, each with its id. What Mousse made in them is registered with the Git check once each is
 * found connected ({@link refreshWorktreeFolders}, which starts here in the background).
 */
export function setWorktreeFolders(profileHome: string, settings: { worktreeFolder: WorktreeFolderEntry | null; previousWorktreeFolders: readonly WorktreeFolderEntry[] }): void {
  const entry = (value: WorktreeFolderEntry): WorktreeFolderEntry => ({ path: resolve(value.path), id: value.id })
  const current = settings.worktreeFolder ? entry(settings.worktreeFolder) : undefined
  chosen.set(resolve(profileHome), { current, previous: settings.previousWorktreeFolders.map(entry).filter((folder) => !current || !same(folder.path, current.path)) })
  forgetUnknown()
  void refreshWorktreeFolders().catch(() => undefined)
}

/** Forgets what the profile at `profileHome` chose (the profile closed). */
export function forgetWorktreeFolders(profileHome: string): void {
  chosen.delete(resolve(profileHome))
  forgetUnknown()
}

/** Drops the ownership of folders no profile knows any more. */
function forgetUnknown(): void {
  const known = new Set(knownWorktreeFolders())
  for (const [path, entry] of repositoryFolders) if (!known.has(entry.folder)) { entry.undo(); repositoryFolders.delete(path) }
  for (const [folder, undo] of trashOwnership) if (!known.has(folder)) { undo(); trashOwnership.delete(folder) }
}

/** Every worktree folder any profile chose, now or before. */
export function knownWorktreeFolders(): string[] {
  return [...new Set(knownEntries().map((entry) => entry.path))]
}

function knownEntries(): WorktreeFolderEntry[] {
  const all: WorktreeFolderEntry[] = []
  for (const entry of chosen.values()) {
    if (entry.current) all.push(entry.current)
    all.push(...entry.previous)
  }
  return all
}

/** The ids a known folder was chosen with (two profiles that chose the same folder share its marker, so its id). */
function idsOf(folder: string): Set<string> {
  return new Set(knownEntries().filter((entry) => same(entry.path, folder)).map((entry) => entry.id))
}

/**
 * The worktree folder new worktrees go to for the profile `path` is in (its home, or a thread folder inside it), or
 * undefined for Mousse's own folder.
 */
export function chosenWorktreeFolder(path: string | undefined): string | undefined {
  if (!path) return undefined
  let best: { home: string; current?: WorktreeFolderEntry } | undefined
  for (const [home, entry] of chosen) {
    if ((same(home, path) || below(home, path)) && (!best || home.length > best.home.length)) best = { home, current: entry.current }
  }
  return best?.current?.path
}

/** The id in a folder's marker, or undefined. */
async function markerIdOf(folder: string): Promise<string | undefined> {
  try {
    const marker = join(folder, WORKTREE_FOLDER_MARKER)
    if (!(await lstat(marker)).isFile()) return undefined
    const value = JSON.parse(await readFile(marker, 'utf8')) as { schemaVersion?: unknown; id?: unknown }
    return value.schemaVersion === 1 && typeof value.id === 'string' && MARKER_ID.test(value.id) ? value.id : undefined
  } catch { return undefined }
}

/** The folder ids the repository markers directly in `folder` name. */
async function repositoryMarkerIds(folder: string): Promise<Set<string>> {
  const ids = new Set<string>()
  let names: string[] = []
  try { names = await readdir(folder) } catch { return ids }
  for (const name of names) {
    try {
      const value = JSON.parse(await readFile(join(folder, name, REPOSITORY_FOLDER_MARKER), 'utf8')) as { schemaVersion?: unknown; folderId?: unknown; repositoryId?: unknown }
      if (value.schemaVersion === 1 && typeof value.folderId === 'string' && MARKER_ID.test(value.folderId) && typeof value.repositoryId === 'string' && REPOSITORY_ID.test(value.repositoryId)) ids.add(value.folderId)
    } catch { /* Not a repository folder of Mousse's. */ }
  }
  return ids
}

/** Writes a chosen folder's marker with `id`, whole and then named, so a marker is never half there. */
async function writeFolderMarker(folder: string, id: string): Promise<void> {
  const temporary = join(folder, `${WORKTREE_FOLDER_MARKER}.${randomBytes(4).toString('hex')}.tmp`)
  await writeFile(temporary, `${JSON.stringify({ schemaVersion: 1, id, chosenAt: new Date().toISOString() })}\n`, { flag: 'wx' })
  await rename(temporary, join(folder, WORKTREE_FOLDER_MARKER))
}

/** A repository folder's marker, when it names `folderId`. */
async function repositoryMarkerOf(path: string, folderId: string): Promise<string | undefined> {
  try {
    const stat = await lstat(path)
    if (!stat.isDirectory()) return undefined
    const marker = join(path, REPOSITORY_FOLDER_MARKER)
    if (!(await lstat(marker)).isFile()) return undefined
    const value = JSON.parse(await readFile(marker, 'utf8')) as { schemaVersion?: unknown; folderId?: unknown; repositoryId?: unknown }
    return value.schemaVersion === 1 && value.folderId === folderId && typeof value.repositoryId === 'string' && REPOSITORY_ID.test(value.repositoryId) ? value.repositoryId : undefined
  } catch { return undefined }
}

/**
 * Whether the folder is there, once its volume answers, and is the one chosen: it holds the marker with an id it was
 * chosen with. A volume that does not answer (a hung network drive, a pending permission prompt that is stuck) counts as
 * not connected at once, so it never holds Storage, cleanup or other repositories. What Mousse made in the folder is
 * registered with the Git check while it is connected, and dropped as soon as it is not.
 */
export async function folderConnected(folder: string): Promise<boolean> {
  const ids = idsOf(folder)
  let connected = false
  try {
    await waitForFolderAccess([folder], { whenNotAnswering: 'fail' })
    let id = (await stat(folder)).isDirectory() ? await markerIdOf(folder) : undefined
    // A folder whose marker went missing (deleted by hand, say) is still the one chosen when Mousse's repository folders
    // in it carry an id it was chosen with: the marker is written again from them. Another marker is never replaced.
    if (id === undefined && !await lstat(join(folder, WORKTREE_FOLDER_MARKER)).catch(() => undefined)) {
      const found = [...await repositoryMarkerIds(folder)].find((candidate) => ids.has(candidate))
      if (found) { await writeFolderMarker(folder, found); id = found }
    }
    connected = id !== undefined && ids.has(id)
    if (connected) await registerContents(resolve(folder), id!)
  } catch { connected = false }
  if (!connected) dropContents(resolve(folder))
  return connected
}

/** {@link folderConnected} for every known folder, so what is Mousse's in them is registered. */
export async function refreshWorktreeFolders(): Promise<void> {
  await Promise.all(knownWorktreeFolders().map((folder) => folderConnected(folder)))
}

async function registerContents(folder: string, id: string): Promise<void> {
  if (!trashOwnership.has(folder)) trashOwnership.set(folder, registerOwnedGitRoot(join(folder, WORKTREE_TRASH_FOLDER)))
  let names: string[] = []
  try { names = await readdir(folder) } catch { /* Nothing to register. */ }
  const found = new Set<string>()
  for (const name of names) {
    const path = join(folder, name)
    const repositoryId = await repositoryMarkerOf(path, id)
    if (!repositoryId) continue
    found.add(path)
    if (!repositoryFolders.has(path)) repositoryFolders.set(path, { folder, repositoryId, undo: registerOwnedGitRoot(path) })
  }
  for (const [path, entry] of repositoryFolders) if (entry.folder === folder && !found.has(path)) { entry.undo(); repositoryFolders.delete(path) }
}

function dropContents(folder: string): void {
  for (const [path, entry] of repositoryFolders) if (same(entry.folder, folder)) { entry.undo(); repositoryFolders.delete(path) }
  const trash = trashOwnership.get(folder)
  if (trash) { trash(); trashOwnership.delete(folder) }
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

/** A repository's folder name in a chosen worktree folder: `<project>-<short key>`, readable. */
export function repositoryFolderName(projectName: string, repositoryId: string): string {
  const name = projectName.normalize('NFKD').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, 48).replace(/[._-]+$/, '')
  return `${name || 'project'}-${repositoryId.slice(0, SHORT_KEY_LENGTH).toLowerCase()}`
}

/**
 * A thread's folder name in a chosen worktree folder: the slug of its branch `mousse/<slug>` (a branch named by ids, from
 * before branches were named after the first message, gives `thread`), then the thread's tag, `<slug>-<tag>`.
 */
export function threadFolderName(branch: string | undefined, threadId: string): string {
  const own = branch?.startsWith('mousse/') ? branch.slice('mousse/'.length) : undefined
  const slug = own && !own.includes('/') ? own.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, 64).replace(/[_-]+$/, '') : ''
  return `${SLUG.test(slug) ? slug : 'thread'}-${threadTag(threadId)}`
}

/** Whether `name` is a folder name the thread's worktree may have: `<slug>-<tag>`, or that with a number. */
function isThreadFolderName(name: string, threadId: string): boolean {
  if (RESERVED_NAMES.has(name.toLowerCase()) || !SLUG.test(name)) return false
  const tag = threadTag(threadId)
  return new RegExp(`^[a-z0-9][a-z0-9_-]*-${tag}(?:-[0-9]{1,3})?$`, 'i').test(name)
}

/**
 * The repository's folder in `folder` (whose id is `id`): the one Mousse made there for it, as its marker says, whatever
 * the project was called then; or a new `<project>-<short key>` (with a number when a folder of that name is someone
 * else's), made with its marker. `folder` itself is never made.
 */
async function repositoryFolderIn(folder: string, id: string, projectName: string, repositoryId: string): Promise<string> {
  let names: string[] = []
  try { names = (await readdir(folder)).sort() } catch { /* Made below. */ }
  for (const name of names) {
    const path = join(folder, name)
    if (await repositoryMarkerOf(path, id) === repositoryId) return path
  }
  const base = repositoryFolderName(projectName, repositoryId)
  for (let index = 1; index < 100; index++) {
    const made = join(folder, index === 1 ? base : `${base}-${index}`)
    try { await mkdir(made) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue; throw error }
    await writeFile(join(made, REPOSITORY_FOLDER_MARKER), `${JSON.stringify({ schemaVersion: 1, folderId: id, repositoryId })}\n`, { flag: 'wx' })
    if (!repositoryFolders.has(made)) repositoryFolders.set(made, { folder: resolve(folder), repositoryId, undo: registerOwnedGitRoot(made) })
    return made
  }
  throw new Error(`No free folder name for the repository in ${folder}`)
}

/**
 * `name` in `parent`, or with a number when something already has it there or `taken` says a record or Git still names
 * it: a name is never given out again while anything names it.
 */
async function freeName(parent: string, name: string, taken?: (path: string) => Promise<boolean>): Promise<string> {
  const used = async (candidate: string): Promise<boolean> => Boolean(await lstat(join(parent, candidate)).catch(() => undefined)) || Boolean(await taken?.(join(parent, candidate)))
  if (!await used(name)) return join(parent, name)
  for (let index = 2; index < 1000; index++) if (!await used(`${name}-${index}`)) return join(parent, `${name}-${index}`)
  throw new Error(`No free folder name for the worktree in ${parent}`)
}

export interface WorktreePlacement {
  /** Where the worktree goes. Its parent folder exists; the worktree's own folder does not yet. */
  path: string
  /** The chosen worktree folder it is in; unset for Mousse's own folder. */
  folder?: string
  /** The chosen worktree folder was not connected, so it went to Mousse's own folder instead. */
  notConnected?: string
}

/** What a thread is told when its worktree went to Mousse's own folder because the chosen one is not connected. */
export function notConnectedPlacementNote(folder: string): string {
  return `The worktree folder ${folder} is not connected, so this thread's worktree is in Mousse's own folder instead. Worktrees already in ${folder} stay there.`
}

/** The chosen folder's id, when it is connected. */
async function connectedId(folder: string): Promise<string | undefined> {
  return await folderConnected(folder) ? await markerIdOf(folder) : undefined
}

/**
 * Where a new thread's worktree goes. In a chosen folder that is connected: `<folder>/<project>-<short key>/<slug>-<tag>`,
 * with a number when the name is taken or named. In Mousse's own folder otherwise, which is also where it goes when the
 * chosen folder is not connected (`notConnected`): the chosen folder is never made again on a drive that is not there.
 */
export async function placeThreadWorktree(input: { home: string; folder?: string; repositoryId: string; projectName: string; threadId: string; conversationBranchId: string; branch?: string; taken?: (path: string) => Promise<boolean> }): Promise<WorktreePlacement> {
  if (input.folder) {
    const id = await connectedId(input.folder)
    if (id) {
      const repositoryFolder = await repositoryFolderIn(input.folder, id, input.projectName, input.repositoryId)
      return { path: await freeName(repositoryFolder, threadFolderName(input.branch, input.threadId), input.taken), folder: input.folder }
    }
  }
  const path = defaultThreadWorktreePath(input.home, input.repositoryId, input.threadId, input.conversationBranchId)
  await mkdir(dirname(path), { recursive: true })
  return { path, ...(input.folder ? { notConnected: input.folder } : {}) }
}

/** The folder a new agent worktree goes in: `<folder>/<project>-<short key>/agents` in a chosen folder that is connected, Mousse's own otherwise. Made when missing. */
export async function placeAgentWorktreeBase(input: { home: string; folder?: string; repositoryId: string; projectName: string }): Promise<string> {
  const id = input.folder ? await connectedId(input.folder) : undefined
  const base = id
    ? join(await repositoryFolderIn(input.folder!, id, input.projectName, input.repositoryId), 'agents')
    : defaultAgentWorktreeBase(input.home, input.repositoryId)
  await mkdir(base, { recursive: true })
  return base
}

/**
 * The folder of a workflow's isolated agent worktrees: `<folder>/<project>-<short key>/agents` in a chosen folder that is
 * connected, Mousse's own `<home>/wf/<repository>/<owner>` otherwise. Made when missing.
 */
export async function placeWorkflowAgentWorktreeBase(input: { home: string; folder?: string; repositoryId: string; projectName: string; ownerDigest: string }): Promise<string> {
  const id = input.folder ? await connectedId(input.folder) : undefined
  const base = id
    ? join(await repositoryFolderIn(input.folder!, id, input.projectName, input.repositoryId), 'agents')
    : defaultWorkflowAgentWorktreeBase(input.home, input.repositoryId, input.ownerDigest)
  await mkdir(base, { recursive: true })
  return base
}

/** Mousse's own folder of a workflow's isolated agent worktrees. */
export function defaultWorkflowAgentWorktreeBase(home: string, repositoryId: string, ownerDigest: string): string {
  return join(home, 'wf', repositoryId.slice(0, 16), ownerDigest)
}

// ---------------------------------------------------------------------------------------------------------
// Whether a path is one of Mousse's worktree places

/**
 * Where `path` is in a repository folder Mousse made in a connected chosen folder (verified by its marker): the chosen
 * folder, the repository folder, its repository and the parts below it. Undefined anywhere else, a folder of the same
 * name that is the person's included.
 */
export function chosenFolderPlace(path: string): { folder: string; repositoryFolder: string; repositoryId: string; rest: string[] } | undefined {
  for (const [repositoryFolder, entry] of repositoryFolders) {
    const parts = below(repositoryFolder, path)
    if (parts) return { folder: entry.folder, repositoryFolder, repositoryId: entry.repositoryId, rest: parts }
  }
  return undefined
}

/** The chosen worktree folder `path` is in (as its record names it: a worktree or its trash), or undefined. */
export function chosenFolderHolding(path: string): string | undefined {
  for (const folder of knownWorktreeFolders()) if (below(folder, path)) return folder
  return undefined
}

/**
 * Whether `path` is a place this thread's worktree of the repository is made: in Mousse's own folder, exactly
 * `threads/<thread>/<conversation branch>` (or any conversation branch's when none is given); in a chosen folder, a
 * folder directly in the repository's verified folder named for this thread (`<slug>-<tag>`).
 */
export function isThreadWorktreePlace(path: string, input: { home: string; repositoryId: string; threadId: string; conversationBranchId?: string }): boolean {
  const own = join(defaultWorktreeBase(input.home, input.repositoryId), 'threads', input.threadId)
  if (input.conversationBranchId !== undefined) { if (same(path, join(own, input.conversationBranchId))) return true }
  else { const parts = below(own, path); if (parts?.length === 1 && SLUG.test(parts[0]!)) return true }
  const placed = chosenFolderPlace(path)
  return Boolean(placed && placed.repositoryId === input.repositoryId && placed.rest.length === 1 && isThreadFolderName(placed.rest[0]!, input.threadId))
}

/** The folders an agent worktree of the repository may be in: Mousse's own `agents` folder, and that of its verified folder in each connected chosen folder. */
export async function agentWorktreeBases(home: string, repositoryId: string): Promise<string[]> {
  await refreshWorktreeFolders()
  return [defaultAgentWorktreeBase(home, repositoryId), ...[...repositoryFolders].filter(([, entry]) => entry.repositoryId === repositoryId).map(([path]) => join(path, 'agents'))]
}

/** Whether `path` is the agent's worktree in Mousse's own folder or in a verified repository folder of a chosen folder. */
export function isAgentWorktreePlace(path: string, input: { home: string; repositoryId: string; agentId: string }): boolean {
  if (same(path, join(defaultAgentWorktreeBase(input.home, input.repositoryId), input.agentId))) return true
  const placed = chosenFolderPlace(path)
  return Boolean(placed && placed.repositoryId === input.repositoryId && placed.rest.length === 2 && placed.rest[0] === 'agents' && placed.rest[1] === input.agentId)
}

/** Whether `path` is a workflow's isolated agent worktree, in Mousse's own `wf` folder or a chosen folder's agents folder. */
export function isWorkflowAgentWorktreePlace(path: string, input: { home: string; repositoryId: string; ownerDigest: string; agentId: string }): boolean {
  return same(path, join(defaultWorkflowAgentWorktreeBase(input.home, input.repositoryId, input.ownerDigest), input.agentId)) || isAgentWorktreePlace(path, input)
}

/** The folders where worktrees nothing names may be left: each repository's in Mousse's own folder and in each connected chosen folder. */
export async function worktreeContainers(home: string): Promise<Array<{ path: string; repository: string; kind: 'threads' | 'agents' | 'folder'; chosen?: string }>> {
  const containers: Array<{ path: string; repository: string; kind: 'threads' | 'agents' | 'folder'; chosen?: string }> = []
  const repositories = join(home, 'repositories')
  let names: string[] = []
  try { names = await readdir(repositories) } catch { /* None yet. */ }
  for (const repository of names) for (const kind of ['threads', 'agents'] as const) containers.push({ path: join(repositories, repository, 'worktrees', kind), repository, kind })
  await refreshWorktreeFolders()
  for (const [path, entry] of [...repositoryFolders].sort(([a], [b]) => a.localeCompare(b))) {
    containers.push({ path, repository: entry.repositoryId, kind: 'folder', chosen: entry.folder })
    containers.push({ path: join(path, 'agents'), repository: entry.repositoryId, kind: 'agents', chosen: entry.folder })
  }
  return containers
}

/** Names in a repository's folder in a chosen folder that are never a worktree: its agents' folder and its marker. */
export function isReservedInRepositoryFolder(name: string): boolean {
  return RESERVED_NAMES.has(name.toLowerCase())
}

// ---------------------------------------------------------------------------------------------------------
// A worktree's own registration

/** What {@link worktreeRegistrationOf} found: the repository (by key) that registers the worktree, or why none does. */
export type WorktreeRegistration = { repositoryId: string; commonDir: string } | { problem: string }

/**
 * The repository that registers the checkout at `path` as one of its linked worktrees, proven by the round trip alone:
 * its `.git` must be a file that leads to an administration folder `<common>/worktrees/<name>`, whose `gitdir` leads back
 * to this `.git`. Its key is that of the common folder now, so a repository moved since (and repaired with
 * `git worktree repair`) is still found. Read from the files alone; no Git runs in a folder that might be someone else's.
 */
export async function worktreeRegistrationOf(path: string): Promise<WorktreeRegistration> {
  try {
    const dotGit = join(path, '.git')
    if (!(await lstat(dotGit)).isFile()) return { problem: `${path} is not a linked worktree` }
    const pointer = /^gitdir:\s*(.+?)\s*$/m.exec(await readFile(dotGit, 'utf8'))?.[1]
    if (!pointer) return { problem: `${path} is not a linked worktree` }
    const admin = await realpath(resolve(path, pointer))
    if (basename(dirname(admin)) !== 'worktrees') return { problem: `${path} is not a linked worktree of a repository` }
    const back = resolve(admin, (await readFile(join(admin, 'gitdir'), 'utf8')).trim())
    if (!same(await realpath(back).catch(() => back), await realpath(dotGit))) return { problem: `The repository's record of ${path} names another folder` }
    const common = await realpath(resolve(admin, (await readFile(join(admin, 'commondir'), 'utf8').catch(() => '../..')).trim()))
    if (!same(dirname(admin), join(common, 'worktrees'))) return { problem: `${path} is not a linked worktree of a repository` }
    return { repositoryId: repositoryKeyOf(common), commonDir: common }
  } catch (error) {
    return { problem: `${path} is not a worktree Mousse can check (${(error as NodeJS.ErrnoException).code ?? (error as Error).message})` }
  }
}

/** {@link worktreeRegistrationOf}, blocking: only for the one caller that cannot wait (`verifySync`). */
export function worktreeRegistrationOfSync(path: string): WorktreeRegistration {
  try {
    const dotGit = join(path, '.git')
    if (!lstatSync(dotGit).isFile()) return { problem: `${path} is not a linked worktree` }
    const pointer = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, 'utf8'))?.[1]
    if (!pointer) return { problem: `${path} is not a linked worktree` }
    const admin = realpathSync(resolve(path, pointer))
    if (basename(dirname(admin)) !== 'worktrees') return { problem: `${path} is not a linked worktree of a repository` }
    const back = resolve(admin, readFileSync(join(admin, 'gitdir'), 'utf8').trim())
    if (!same(existsSync(back) ? realpathSync(back) : back, realpathSync(dotGit))) return { problem: `The repository's record of ${path} names another folder` }
    const common = realpathSync(resolve(admin, existsSync(join(admin, 'commondir')) ? readFileSync(join(admin, 'commondir'), 'utf8').trim() : '../..'))
    if (!same(dirname(admin), join(common, 'worktrees'))) return { problem: `${path} is not a linked worktree of a repository` }
    return { repositoryId: repositoryKeyOf(common), commonDir: common }
  } catch (error) {
    return { problem: `${path} is not a worktree Mousse can check (${(error as NodeJS.ErrnoException).code ?? (error as Error).message})` }
  }
}

// ---------------------------------------------------------------------------------------------------------
// The trash

/** The trash a worktree at `worktreePath` is moved to: its chosen folder's, on the same drive, or the profile's. */
export function trashRootFor(worktreePath: string, profileHome: string): string {
  const folder = chosenFolderHolding(worktreePath)
  return folder ? join(folder, WORKTREE_TRASH_FOLDER) : join(profileHome, 'trash')
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
 * The chosen worktree folder holding `path` (a worktree or its trash) when that folder is not connected: not there, not
 * answering, or not the folder that was chosen (no marker, or another's). Undefined when `path` is not in a chosen
 * folder or the folder is connected. Such a worktree is there but out of reach: never missing, never deleted, never
 * rebuilt in its place, and nothing about it is settled until it is back.
 */
export async function disconnectedWorktreeFolder(...paths: Array<string | undefined>): Promise<string | undefined> {
  for (const path of paths) {
    const folder = path ? chosenFolderHolding(path) : undefined
    if (folder && !await folderConnected(folder)) return folder
  }
  return undefined
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

/** Refuses with {@link DriveNotConnectedError} when a path is in a chosen worktree folder that is not connected. */
export async function assertWorktreeFolderConnected(...paths: Array<string | undefined>): Promise<void> {
  const folder = await disconnectedWorktreeFolder(...paths)
  if (folder) throw new DriveNotConnectedError(folder)
}

/** Waits until `folder` is connected again, looking every {@link DRIVE_POLL_MS}; `signal` ends the wait with its reason. */
export async function waitForWorktreeFolder(folder: string, signal?: AbortSignal, pollMs = DRIVE_POLL_MS): Promise<void> {
  while (!await folderConnected(folder)) {
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
 * Whether the drive `folder` is on keeps file modes: a file made there is given 0644 and then 0755 and read back. exFAT
 * and FAT keep none (every file reads as 0700 or 0777), nor do most SMB shares. Windows, where Git ignores modes, says yes.
 */
export async function probeFileModes(folder: string): Promise<boolean> {
  if (process.platform === 'win32') return true
  const probe = join(folder, `.mousse-mode-check-${randomBytes(6).toString('hex')}`)
  try {
    await writeFile(probe, '', { mode: 0o644 })
    await chmod(probe, 0o644)
    const first = (await stat(probe)).mode & 0o777
    await chmod(probe, 0o755)
    const second = (await stat(probe)).mode & 0o777
    return first === 0o644 && second === 0o755
  } finally { await rm(probe, { force: true }).catch(() => undefined) }
}

/** The kind of file system `path` is on as a person names it (exFAT, FAT, SMB), or undefined. Best effort, bounded. */
async function fileSystemName(path: string): Promise<string | undefined> {
  const run = (command: string, args: string[]): Promise<string> => new Promise((settle) => {
    execFile(command, args, { encoding: 'utf8', timeout: 3_000 }, (error, stdout) => settle(error ? '' : stdout))
  })
  let type: string | undefined
  if (process.platform === 'darwin' || process.platform === 'linux') {
    const mounts = process.platform === 'linux'
      ? (await readFile('/proc/mounts', 'utf8').catch(() => '')).split('\n').map((line) => line.split(' ')).filter((parts) => parts.length > 2).map((parts) => ({ at: parts[1]!.replace(/\\040/g, ' '), type: parts[2]! }))
      : (await run('/sbin/mount', [])).split('\n').flatMap((line) => { const match = / on (.+) \(([^,)]+)/.exec(line); return match ? [{ at: match[1]!, type: match[2]! }] : [] })
    let best = ''
    for (const mount of mounts) if ((same(mount.at, path) || below(mount.at, path)) && mount.at.length >= best.length) { best = mount.at; type = mount.type }
  }
  const names: Record<string, string> = { exfat: 'exFAT', msdos: 'FAT', vfat: 'FAT', fat: 'FAT', fat32: 'FAT', smbfs: 'SMB', cifs: 'SMB', smb3: 'SMB', ntfs: 'NTFS', fuseblk: 'a FUSE drive' }
  return type ? names[type.toLowerCase()] ?? type : undefined
}

/** A drive that keeps no file modes is refused, by name. */
export function noFileModesText(fileSystem: string | undefined): string {
  return `This drive${fileSystem ? ` (${fileSystem})` : ''} can't store file permissions, which Git worktrees need. Pick a folder on an APFS, HFS+, NTFS or ext4 drive.`
}

/**
 * Checks a folder the person chose for new worktrees and marks it as chosen; returns its real path and its id. It must
 * be a full path, outside Mousse's own data folder, not inside a Git checkout, not holding a repository of the person's
 * own at its top, writable, and on a drive that keeps file modes. It is made when it does not exist yet (its parent
 * must). A folder chosen before (on this or another computer) keeps its id; otherwise a new one is written in its
 * marker. Every access waits for the folder's volume first, so a permission prompt for an external drive holds only
 * this request.
 */
export async function checkWorktreeFolder(folder: string, home: string, storedIds: readonly string[] = []): Promise<WorktreeFolderEntry> {
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
  // The folder's id: its marker's; without one, the id its repository folders carry (one it was chosen with here first),
  // so choosing it again never puts a new identity under worktrees that are already there.
  let previousId = existing ? await markerIdOf(real) : undefined
  let rewriteMarker = false
  if (existing && previousId === undefined && !await lstat(join(real, WORKTREE_FOLDER_MARKER)).catch(() => undefined)) {
    const carried = [...await repositoryMarkerIds(real)]
    const stored = carried.find((id) => storedIds.includes(id))
    if (stored) previousId = stored
    else if (carried.length === 1) previousId = carried[0]
    else if (carried.length > 1) throw new WorktreeFolderRefused('This folder holds worktrees of more than one chosen worktree folder. Choose one of those folders instead.')
    else if (storedIds.length === 1) previousId = storedIds[0]
    rewriteMarker = previousId !== undefined
  }
  if (existing) {
    for (const name of (await readdir(real)).sort()) {
      // Mousse's own folders, as their markers say; any other folder that holds a repository is the person's.
      if (name === WORKTREE_TRASH_FOLDER || previousId && await repositoryMarkerOf(join(real, name), previousId)) continue
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
  let keepsModes = false
  try { keepsModes = await probeFileModes(real) } catch { keepsModes = false }
  if (!keepsModes) {
    // Made only to be checked: an empty folder Mousse made just now is left as it was found.
    if (!existing) await rmdir(real).catch(() => undefined)
    throw new WorktreeFolderRefused(noFileModesText(await fileSystemName(real)))
  }
  const checked = await realpath(real)
  const id = previousId ?? randomBytes(16).toString('hex')
  if (!previousId || rewriteMarker) await writeFolderMarker(checked, id)
  return { path: checked, id }
}

/**
 * Whether a chosen folder must stay known: it is not connected (what it holds is unknown), it holds a repository folder
 * or a trash with anything in it, or a record names a path in it (`named`).
 */
export async function worktreeFolderStillNeeded(entry: WorktreeFolderEntry, named: readonly string[]): Promise<boolean> {
  if (named.some((path) => same(path, entry.path) || below(entry.path, path))) return true
  const ids = idsOf(entry.path)
  ids.add(entry.id)
  let id: string | undefined
  try {
    await waitForFolderAccess([entry.path], { whenNotAnswering: 'fail' })
    id = (await stat(entry.path)).isDirectory() ? await markerIdOf(entry.path) : undefined
  } catch { return true }
  if (!id || !ids.has(id)) return true
  let names: string[] = []
  try { names = await readdir(entry.path) } catch { return true }
  for (const name of names) {
    const path = join(entry.path, name)
    if (name !== WORKTREE_TRASH_FOLDER && !await repositoryMarkerOf(path, id)) continue
    try { if ((await readdir(path)).some((child) => child !== REPOSITORY_FOLDER_MARKER)) return true } catch { return true }
  }
  return false
}
