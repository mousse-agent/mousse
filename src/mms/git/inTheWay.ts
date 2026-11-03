import { lstat, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { LISTING, tryGitRawAsync } from '../actions/git'

/**
 * What a Git command that writes the person's files (a branch switch, a new branch started from a ref, a pull) would
 * write over or delete that no commit holds. Git writes over and deletes ignored files without asking, and a rebase
 * replays commits under rules that can change on the way, so Mousse checks first and refuses, naming what is there.
 *
 * The files on disk are only listed by Git (`ls-files --others`), never added to the object store, and nothing is
 * snapshotted for the check. The only objects written are what `git merge-tree` builds to work out a merge or a
 * rebase's steps: its trees and the merged contents of files both sides changed, which nothing points at.
 */

/** Why a file is in the way. */
export type InTheWayKind = 'ignored' | 'untracked' | 'submodule' | 'nested' | 'unreadable'

export interface InTheWay {
  /** As it is spelled on disk, from the top of the checkout. A folder ends with a slash. */
  path: string
  kind: InTheWayKind
}

/** A path a step writes, and what it leaves there: a file's mode, `160000` for a submodule, `000000` when deleted. */
export interface PlannedWrite {
  path: string
  mode: string
  /** The submodule that was at this path before the step, if any. */
  wasSubmodule?: boolean
  /**
   * The start of a side name Git gives a file in a folder/file conflict (`x~`): the name it writes is this followed by
   * one of the labels Mousse's merge and rebase use (`SIDE_LABEL`).
   */
  sidePrefix?: boolean
}

/** A Git read the check needs failed; the operation is refused, since what it would overwrite is unknown. */
export class InTheWayCheckError extends Error {
  constructor(readonly detail: string) {
    super(`Could not check which files would be overwritten: ${detail}`)
    this.name = 'InTheWayCheckError'
  }
}

/**
 * The labels Git puts after the tilde of a side name for the commands Mousse runs: `HEAD`, `@{upstream}` (a merge of the
 * upstream), and a replayed commit's short hash with its subject (a rebase). An editor's backup `x~` is not one.
 */
const SIDE_LABEL = /^(?:HEAD|@\{upstream\}|[0-9a-f]{4,64}(?: \(.*\))?)$/s

const GITLINK = '160000'
const DELETED = '000000'
const fields = (text: string): string[] => text.split('\0')

/** A read whose output grows with the repository: it may print up to the listing limit, and fails past it. */
async function gitRead(top: string, args: string[], input?: string): Promise<string> {
  const run = await tryGitRawAsync(top, args, input, LISTING)
  if (!run.ok) throw new InTheWayCheckError(firstLine(run.stderr) || `git ${args[0]} failed`)
  return run.stdout
}
const firstLine = (text: string): string => text.split('\n').map((line) => line.trim()).find(Boolean) ?? ''

/** The empty tree of the repository's hash, for a checkout with no commit yet. */
export async function emptyTree(top: string): Promise<string> {
  return (await gitRead(top, ['hash-object', '-t', 'tree', '--stdin'], '')).trim()
}

/** Every path that differs between two trees, as a move from `from` to `to` writes it. */
export async function plannedWrites(top: string, from: string, to: string): Promise<PlannedWrite[]> {
  // Raw records: `:<old mode> <new mode> <old> <new> <status>` NUL `<path>` NUL.
  const parts = fields(await gitRead(top, ['diff-tree', '-r', '-z', '--no-renames', '--no-ext-diff', from, to, '--']))
  const writes: PlannedWrite[] = []
  for (let index = 0; index + 1 < parts.length; index += 2) {
    const meta = parts[index]!
    if (!meta.startsWith(':')) break
    const [oldMode = '', newMode = ''] = meta.slice(1).split(' ')
    writes.push({ path: parts[index + 1]!, mode: newMode, ...(oldMode === GITLINK ? { wasSubmodule: true } : {}) })
  }
  return writes
}

export interface MergeResult {
  tree: string
  conflicted: boolean
  /** Paths left with conflicts, side names (`x~HEAD`) included. */
  conflicts: string[]
}

/** What can be changed for tests: `mergeTree: false` works out writes as on a Git without `merge-tree --write-tree`. */
const settings = { mergeTree: true }

export function configureInTheWay(next: { mergeTree?: boolean } = {}): void {
  settings.mergeTree = next.mergeTree ?? true
}

/**
 * The tree `git merge` or one step of a rebase would leave, worked out without touching the files (`merge-tree`).
 * `base` is given for a rebase step (the replayed commit's parent); `ours` and `theirs` may then be trees.
 * `strategyOptions` are the merge's `-X` options.
 *
 * Null when this Git cannot do it: `--write-tree` needs Git 2.38, `--merge-base` 2.40, and an option it does not know
 * makes it print its usage (exit 129). The caller then counts writes the conservative way (`conservativeWrites`).
 * Any other failure fails the check, rather than guess.
 */
export async function mergeResult(top: string, ours: string, theirs: string, options: { base?: string; strategyOptions?: readonly string[] } = {}): Promise<MergeResult | null> {
  if (!settings.mergeTree) return null
  const args = ['merge-tree', '--write-tree', '-z', '--name-only', '--no-messages', ...(options.strategyOptions ?? []).map((option) => `--strategy-option=${option}`), ...(options.base ? [`--merge-base=${options.base}`] : []), ours, theirs]
  const run = await tryGitRawAsync(top, args, undefined, LISTING)
  if (run.status === 129 || /unknown (?:option|switch)|usage: git merge-tree/i.test(run.stderr)) return null
  const [tree = '', ...rest] = fields(run.stdout)
  if ((run.status !== 0 && run.status !== 1) || !/^[0-9a-f]{40,64}$/.test(tree)) throw new InTheWayCheckError(firstLine(run.stderr) || 'git merge-tree could not work out the merge')
  const end = rest.indexOf('')
  return { tree, conflicted: run.status === 1, conflicts: [...new Set(end < 0 ? rest : rest.slice(0, end))] }
}

/**
 * Every path a merge of `upstream` into `head`, or a rebase of `head` onto it, can write, counted without
 * `merge-tree` (a Git older than 2.38, or 2.40 for a rebase): more than the command writes, never less.
 * - Every path `head` and `upstream` differ in.
 * - Every path a local commit touches (`upstream..head`, merged commits included): a rebase replays them, and a
 *   merge can move their files.
 * - Those local paths moved as the upstream's renames since the two parted move them: a renamed file, and the
 *   folders its rename implies, as rename detection would carry a local file into a renamed folder.
 * - The side names a folder/file conflict can give any of them.
 * A read that fails fails the check.
 */
export async function conservativeWrites(top: string, head: string, upstream: string): Promise<PlannedWrite[]> {
  const writes = await plannedWrites(top, head, upstream)
  const commits = (await gitRead(top, ['rev-list', '--no-merges', `${upstream}..${head}`])).split('\n').map((line) => line.trim()).filter(Boolean)
  const local: PlannedWrite[] = []
  for (const commit of commits) {
    const parent = await tryGitRawAsync(top, ['rev-parse', '--verify', '--quiet', `${commit}^1^{tree}`])
    local.push(...await plannedWrites(top, parent.ok ? parent.stdout.trim() : await emptyTree(top), commit))
  }
  const moved: PlannedWrite[] = []
  const base = await tryGitRawAsync(top, ['merge-base', head, upstream])
  // Exit 1: no common commit, so no rename to follow.
  if (!base.ok && base.status !== 1) throw new InTheWayCheckError(firstLine(base.stderr) || 'git merge-base failed')
  if (base.ok) {
    const files = new Map<string, string>()
    const folders = new Map<string, string>()
    const parts = fields(await gitRead(top, ['diff-tree', '-r', '-z', '-M', '--name-status', base.stdout.trim(), upstream, '--']))
    for (let index = 0; index < parts.length && parts[index];) {
      const status = parts[index]!
      if (/^[RC]/.test(status)) {
        const from = parts[index + 1]!, to = parts[index + 2]!
        if (status.startsWith('R')) {
          files.set(from, to)
          // `a/b/x` to `c/b/x` moves the folders `a/b` to `c/b` and `a` to `c`.
          let oldFolder = parentOf(from), newFolder = parentOf(to)
          while (oldFolder && newFolder && oldFolder !== newFolder) {
            if (!folders.has(oldFolder)) folders.set(oldFolder, newFolder)
            if (nameOf(oldFolder) !== nameOf(newFolder)) break
            oldFolder = parentOf(oldFolder); newFolder = parentOf(newFolder)
          }
        }
        index += 3
      } else index += 2
    }
    for (const write of local) {
      const renamed = files.get(write.path)
      if (renamed) moved.push({ path: renamed, mode: '100644' })
      for (const [from, to] of folders) if (write.path.startsWith(`${from}/`)) moved.push({ path: `${to}${write.path.slice(from.length)}`, mode: '100644' })
    }
  }
  const sides = [...local, ...moved].map((write) => ({ path: `${write.path}~`, mode: '100644', sidePrefix: true }))
  return [...writes, ...local, ...moved, ...sides]
}

const parentOf = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf('/')))
const nameOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1)

/** The conflicts of a merge or rebase step as writes: the file itself, and any side name Git may give it. */
export function conflictWrites(conflicts: readonly string[]): PlannedWrite[] {
  return conflicts.flatMap((path) => {
    const tilde = path.lastIndexOf('~')
    // Only a tilde inside the last name, after at least one character of it.
    const side = tilde > path.lastIndexOf('/') + 1 ? [{ path: path.slice(0, tilde + 1), mode: '100644', sidePrefix: true }] : []
    return [{ path, mode: '100644' }, ...side]
  })
}

export interface InTheWayOptions {
  /** Count untracked files (not ignored) as in the way. A switch leaves them to Git, which refuses, or to the stash. */
  untracked: boolean
}

interface Listed { path: string; folder: boolean; kind: InTheWayKind }

/**
 * The files on disk that `writes` would write over or delete and no commit holds, judged against the checkout as it
 * is now: an ignored file (or, with `untracked`, an untracked one) at a written path, in a folder a written file
 * replaces, or where a written file needs a folder; a populated submodule a write replaces; a nested repository a
 * write reaches into; a folder Git cannot read. A sparse checkout's paths outside its patterns are not written and
 * not checked.
 */
export async function findInTheWay(top: string, planned: readonly PlannedWrite[], options: InTheWayOptions): Promise<InTheWay[]> {
  let writes = planned
  if (!writes.length) return []
  const config = async (key: string) => (await tryGitRawAsync(top, ['config', '--bool', '--get', key])).stdout.trim() === 'true'
  if (await config('core.sparseCheckout')) writes = await insideSparsePatterns(top, writes)
  if (!writes.length) return []
  const ignoreCase = await config('core.ignorecase')
  const fold = ignoreCase ? (path: string) => path.toLowerCase() : (path: string) => path

  const listing = async (ignored: boolean) => {
    const run = await tryGitRawAsync(top, ['ls-files', '-z', '--others', '--exclude-standard', '--directory', '--no-empty-directory', ...(ignored ? ['--ignored'] : [])], undefined, LISTING)
    if (!run.ok) throw new InTheWayCheckError(firstLine(run.stderr) || 'git ls-files failed')
    return run
  }
  const [ignoredRun, othersRun] = await Promise.all([listing(true), listing(false)])
  const listed: Listed[] = []
  for (const [run, kind] of [[ignoredRun, 'ignored'], [othersRun, 'untracked']] as const) {
    for (const entry of fields(run.stdout).filter(Boolean)) {
      const folder = entry.endsWith('/')
      const path = folder ? entry.slice(0, -1) : entry
      const nested = folder && await exists(join(top, path, '.git'))
      listed.push({ path, folder, kind: nested ? 'nested' : kind })
    }
  }
  // Git names a folder it cannot open and goes on without it.
  const unreadable = new Set<string>()
  for (const run of [ignoredRun, othersRun]) {
    for (const match of run.stderr.matchAll(/could not open directory '([^']+?)\/?': /g)) unreadable.add(match[1]!)
  }
  for (const path of unreadable) listed.push({ path, folder: true, kind: 'unreadable' })

  const counts = (kind: InTheWayKind) => kind !== 'untracked' || options.untracked
  const byPath = new Map<string, Listed>()
  // Every folder above a listed path, so the listed paths inside a folder a write replaces are found at once.
  const within = new Map<string, Listed[]>()
  for (const item of listed) {
    const key = fold(item.path)
    // Ignored first: a path listed as both is ignored.
    if (!byPath.has(key)) byPath.set(key, item)
    const parts = key.split('/')
    for (let depth = 1; depth < parts.length; depth++) {
      const above = parts.slice(0, depth).join('/')
      const inside = within.get(above)
      if (inside) inside.push(item)
      else within.set(above, [item])
    }
  }

  const found = new Map<string, InTheWay>()
  const add = (path: string, kind: InTheWayKind) => { if (counts(kind) && !found.has(fold(path))) found.set(fold(path), { path, kind }) }
  const named = (item: Listed) => (item.folder ? `${item.path}/` : item.path)
  // Files inside a folder Git lists as untracked, which may hide ignored ones: Git is asked which are ignored.
  const toClassify: string[] = []
  // Untracked folders a write replaces whole, when untracked files do not count: the ignored files in them still do.
  const replacedUntracked = new Set<string>()
  const sidePrefixes = writes.filter((write) => write.sidePrefix).map((write) => fold(write.path))
  for (const item of listed) {
    if (item.folder) continue
    const key = fold(item.path)
    if (sidePrefixes.some((prefix) => key.startsWith(prefix) && SIDE_LABEL.test(item.path.slice(prefix.length)))) add(item.path, item.kind)
  }
  const inFolder = (item: Listed) => {
    if (item.kind === 'untracked' && item.folder && !options.untracked) replacedUntracked.add(item.path)
    // A nested repository is named by its folder, whatever file of it a write reaches.
    add(named(item), item.kind)
  }
  for (const write of writes) {
    if (write.sidePrefix) continue
    const key = fold(write.path)
    const parts = key.split('/')
    // A submodule added where a folder is leaves that folder's files as they are; Git only records the link.
    const keepsFolder = write.mode === GITLINK
    const exact = byPath.get(key)
    if (exact && !(keepsFolder && exact.folder)) inFolder(exact)
    if (!keepsFolder) for (const item of within.get(key) ?? []) inFolder(item)
    for (let depth = 1; depth < parts.length; depth++) {
      const above = byPath.get(parts.slice(0, depth).join('/'))
      if (!above) continue
      if (!above.folder) add(above.path, above.kind)
      // Inside a listed folder only what is there is written over; a new file is only added beside the others.
      else if (above.kind === 'unreadable') add(named(above), above.kind)
      else {
        const there = await firstInTheWay(top, above.path, write.path.slice(above.path.length + 1), keepsFolder)
        // A nested repository is named by its folder, whatever file of it would be overwritten.
        if (there !== null && above.kind === 'nested') add(named(above), above.kind)
        else if (there !== null) {
          const path = `${above.path}/${await diskSpelling(top, there, above.path, ignoreCase)}`
          if (above.kind === 'untracked') toClassify.push(path)
          else add(path, above.kind)
        }
      }
      break
    }
  }
  if (toClassify.length) {
    const run = await tryGitRawAsync(top, ['check-ignore', '-z', '--stdin'], toClassify.map((path) => `${path}\0`).join(''), LISTING)
    // Exit 1: none of them is ignored.
    if (!run.ok && run.status !== 1) throw new InTheWayCheckError(firstLine(run.stderr) || 'git check-ignore failed')
    const ignored = new Set(fields(run.stdout).filter(Boolean))
    for (const path of toClassify) add(path, ignored.has(path) ? 'ignored' : 'untracked')
  }
  for (const folder of replacedUntracked) {
    // Listed one by one within the folder: the listing of the whole checkout leaves them out of an untracked folder.
    const inside = await gitRead(top, ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--', `:(literal)${folder}/`])
    for (const path of fields(inside).filter(Boolean)) add(path, 'ignored')
  }
  for (const path of await replacedSubmodules(top, writes)) add(`${path}/`, 'submodule')
  return [...found.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

/** Only the writes a sparse checkout makes in the folder; on a Git without `check-rules`, all of them. */
async function insideSparsePatterns(top: string, writes: readonly PlannedWrite[]): Promise<readonly PlannedWrite[]> {
  const paths = [...new Set(writes.map((write) => write.path))]
  const run = await tryGitRawAsync(top, ['sparse-checkout', 'check-rules', '-z'], paths.map((path) => `${path}\0`).join(''), LISTING)
  if (!run.ok) return writes
  const inside = new Set(fields(run.stdout).filter(Boolean))
  return writes.filter((write) => inside.has(write.path))
}

/**
 * Submodules whose folder holds files and that a write replaces: a file where the submodule is, or files inside it.
 * Git leaves a submodule's own files alone when only its commit changes or it is removed, but writes over them when
 * the path becomes a file or a folder of the repository.
 */
async function replacedSubmodules(top: string, writes: readonly PlannedWrite[]): Promise<string[]> {
  const submodules = new Set(writes.filter((write) => write.wasSubmodule || write.mode === GITLINK).map((write) => write.path))
  const replaced: string[] = []
  for (const path of submodules) {
    const overwritten = writes.some((write) => (write.path === path && write.mode !== GITLINK && write.mode !== DELETED) || write.path.startsWith(`${path}/`))
    if (!overwritten) continue
    const entries = await readdir(join(top, path)).catch(() => [] as string[])
    if (entries.length) replaced.push(path)
  }
  return replaced
}

async function exists(path: string): Promise<boolean> {
  return lstat(path).then(() => true, (error: NodeJS.ErrnoException) => error.code !== 'ENOENT' && error.code !== 'ENOTDIR')
}

/** `rest` as its names are spelled on disk below `folder`, on a file system that ignores case. */
async function diskSpelling(top: string, rest: string, folder: string, ignoreCase: boolean): Promise<string> {
  if (!ignoreCase) return rest
  let at = folder
  const spelled: string[] = []
  for (const name of rest.split('/').filter(Boolean)) {
    const names = await readdir(join(top, at)).catch(() => [] as string[])
    const real = names.includes(name) ? name : names.find((entry) => entry.toLowerCase() === name.toLowerCase()) ?? name
    spelled.push(real)
    at = `${at}/${real}`
  }
  return spelled.join('/')
}

/**
 * The first name on the way from `folder` down to `rest` that a write there would overwrite, or null: a file (or link)
 * partway down, where the write needs a folder, or whatever is at `rest` itself. A folder at `rest` counts too, unless
 * the write is a submodule, which leaves a folder's files as they are. A name that is not there ends the walk.
 */
async function firstInTheWay(top: string, folder: string, rest: string, keepsFolder: boolean): Promise<string | null> {
  const names = rest.split('/')
  for (let depth = 1; depth <= names.length; depth++) {
    const path = names.slice(0, depth).join('/')
    const stat = await lstat(join(top, folder, path)).catch((error: NodeJS.ErrnoException) => {
      // A name Git cannot look at is treated as there.
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null
      return 'unknown' as const
    })
    if (stat === null) return null
    if (stat === 'unknown') return path
    const last = depth === names.length
    if (!stat.isDirectory()) return path
    if (last) return keepsFolder ? null : `${path}/`
  }
  return null
}
