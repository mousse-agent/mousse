import { lstatSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { isStricter, type PermissionMode } from '../../shared/permissionMode'
import { MOUSSE_CONTROL_FILE_PATHS } from '../worktree/controlFiles'
import { enclosingRepositories, gitControlCache, type GitControlCache } from './gitControl'
import {
  isInsidePath,
  resolveWithinRoot,
  type GuardedPath,
  type PathGuard,
  type PathIntent
} from './pathGuard'
import { PathContainmentError, outside, protectedPath, realPathOrAncestor } from './realPath'
import { sensitiveFolderContaining } from './sensitiveFolders'

export { PathContainmentError, realPathOrAncestor, type PathRefusal } from './realPath'

export const OTHER_NAMES = 'This file has other names (a hard link), so another computer cannot change it.'

/** Whether `path` is a file that is also known under another name, which could be a hook or another protected file. */
function hasOtherNames(path: string): boolean {
  try {
    const info = lstatSync(path)
    return info.isFile() && info.nlink > 1
  } catch {
    return false
  }
}

/** A path of another disk or share, or a Windows device: it names something that is not in the folder. */
const DRIVE_OR_NETWORK = /^(?:[\\/]{2}|[a-zA-Z]:)/

/** The names Windows gives its devices; `nul.txt` is the device too. */
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)$/i

/** What Windows makes of a name: a trailing dot or space is dropped, and `name::$DATA` is a stream of `name`. */
function windowsName(name: string): string {
  return name.replace(/[. ]+$/, '')
}

/** Whether a folder name is the one Git keeps its data in (on Windows also under its other spellings). */
export function isGitName(name: string, windows = process.platform === 'win32'): boolean {
  const folded = (windows ? windowsName(name) : name).toLowerCase()
  if (folded === '.git') return true
  // NTFS gives `.git` the short name `GIT~1`, which opens the same folder.
  return windows && /^git~\d+$/.test(folded)
}

/** The rules for one segment of a path that came from another computer, before anything is looked up on disk. */
function checkSegments(path: string, windows: boolean): void {
  for (const segment of path.split(/[\\/]+/)) {
    if (!segment || segment === '.' || segment === '..') continue
    if (!windows) continue
    // A stream (`file:name`), a device (`NUL`) and a name Windows rewrites (`.git.`) do not name what they say.
    if (segment.includes(':'))
      throw outside('That name is not a plain file or folder name.')
    if (WINDOWS_DEVICE.test(windowsName(segment).split('.')[0].trimEnd()))
      throw outside('That name is a device, not a file.')
    if (windowsName(segment) !== segment)
      throw outside('That name ends in a dot or a space, which this computer would rewrite.')
  }
}

/**
 * Files that start programs without anyone running them on the owner: the settings an agent harness loads from a
 * project (Mousse loads them in `data/paths.ts` and the Claude Code and Cursor drivers: hooks, allowed tools, MCP
 * servers, environment) and the runners Git calls on a commit (`husky`, `lefthook`, `pre-commit`). Another computer
 * triggers them itself, with `chat` (the next turn) or `write` (a commit), so a device may change them only when its
 * limit already lets it run commands: Full access. Names are matched in any folder and in any case.
 * Not here, because they run only when a person on the owner runs them, or behind the tool's own trust prompt:
 * `package.json` scripts, `Makefile`, `.vscode/tasks.json`, `.envrc`, CI files and source code.
 */
const PROGRAM_FILES = [
  '.claude/settings.json',
  '.claude/settings.local.json',
  '.mcp.json',
  '.cursor/mcp.json',
  '.cursor/hooks.json',
  '.cursor/cli.json',
  '.cursor/environment.json',
  '.codex/config.toml',
  '.codex/hooks.json',
  'opencode.json',
  '.opencode/opencode.json',
  '.pre-commit-config.yaml',
  '.pre-commit-config.yml'
] as const
const PROGRAM_FOLDERS = ['.husky', '.lefthook', '.claude/hooks', '.mousse/workflows'] as const
const LEFTHOOK_FILE = /^\.?lefthook(-local)?\.(ya?ml|json|toml)$/

/** Whether a change to this name (relative to the folder, `/`-separated, any case) starts programs by itself. */
export function startsPrograms(name: string): boolean {
  const folded = `/${name.toLowerCase()}`
  if (PROGRAM_FILES.some((file) => folded.endsWith(`/${file}`))) return true
  if (LEFTHOOK_FILE.test(folded.slice(folded.lastIndexOf('/') + 1))) return true
  return PROGRAM_FOLDERS.some((folder) => folded.includes(`/${folder}/`))
}

export interface RoutedGuardOptions {
  /** The most the calling device may run, from this computer's policy for it. Anything but `full` is below Full access. */
  ceiling?: PermissionMode
  /** What the repositories of the folder read from the working tree. */
  git?: GitControlCache
  /** Control files of Mousse, relative to a checkout. */
  controlFiles?: readonly string[]
  /** What a real path holds if it is a credentials or settings folder of this computer. */
  sensitive?: (realPath: string) => string | undefined
  windows?: boolean
}

/**
 * The guard for a call from another of the user's computers. A path is allowed when what it names on
 * disk, once every link, junction, short name and difference of case is resolved, lies inside the root's
 * real folder, and not in a credentials or settings folder of this computer even when the project is.
 * A change is refused as well, at any limit, when it would reach
 * - Git's own folder (`.git`, at any depth, a worktree's `.git` file included), whose hooks and config run
 *   programs on the next commit;
 * - a folder `core.hooksPath` names, or a file Git includes as configuration (`include.path`, `includeIf`), in the
 *   folder's repository or a repository nested in it;
 * - a control file of Mousse;
 * - a file with other names (a hard link), which could be one of the above under another name;
 * and, below Full access, a file that starts programs by itself (`startsPrograms`).
 * A file that is read or written is opened at its real path, not through the path it was asked by.
 */
export class RoutedGuard implements PathGuard {
  readonly contained = true
  private readonly windows: boolean
  private readonly ceiling: PermissionMode
  private readonly git: GitControlCache
  private readonly controlFiles: readonly string[]
  private readonly sensitive: (realPath: string) => string | undefined
  constructor(options: RoutedGuardOptions = {}) {
    this.windows = options.windows ?? process.platform === 'win32'
    this.ceiling = options.ceiling ?? 'accept_edits'
    this.git = options.git ?? gitControlCache
    this.sensitive = options.sensitive ?? ((real) => sensitiveFolderContaining(real))
    this.controlFiles = (options.controlFiles ?? MOUSSE_CONTROL_FILE_PATHS).map((path) =>
      path.toLowerCase()
    )
  }

  /** Looks up, without blocking the daemon, what the repositories around a change say about hooks and configuration. */
  async prepare(root: string, path: string, intent: PathIntent): Promise<void> {
    if (intent !== 'write') return
    let place: { realRoot: string; real: string }
    try {
      place = this.locate(root, path, intent)
    } catch {
      // `resolve` says why.
      return
    }
    for (const repository of enclosingRepositories(place.realRoot, place.real)) await this.git.prepare(repository)
  }

  resolve(root: string, path: string, intent: PathIntent): GuardedPath {
    const { realRoot, real, lexical } = this.locate(root, path, intent)
    const relativeName = relative(realRoot, real).replace(/\\/g, '/')
    const holds = this.sensitive(real)
    if (holds) throw protectedPath(`That folder holds ${holds}, so another computer cannot reach it.`)
    if (intent === 'write') {
      // Both spellings: the one that was asked for, and the one it resolves to.
      const asked = relative(resolve(root), lexical).replace(/\\/g, '/')
      for (const name of [asked, relativeName]) this.assertChangeable(name)
      for (const repository of enclosingRepositories(realRoot, real)) {
        const control = this.git.get(repository)
        if (!control || control instanceof Error)
          throw protectedPath("This folder's hook and configuration settings could not be read, so nothing was written.")
        for (const folder of control.hookFolders)
          if (isInsidePath(real, folder, true))
            throw protectedPath('Git runs the programs in this folder, so another computer cannot change them.')
        for (const file of control.configFiles)
          if (isInsidePath(real, file, true))
            throw protectedPath('Git reads this file as configuration, and can run programs it names, so another computer cannot change it.')
      }
      // Checked here so a refused save is refused before anything is recorded; the save checks it again as it opens the file.
      if (hasOtherNames(real)) throw protectedPath(OTHER_NAMES)
    }
    return { absolute: real, relative: relativeName }
  }

  /** The folder's real path and what the path really names, if it is inside the folder. */
  private locate(root: string, path: string, intent: PathIntent): { realRoot: string; real: string; lexical: string } {
    if (typeof path !== 'string' || path.includes('\0')) throw outside()
    if (isAbsolute(path) || DRIVE_OR_NETWORK.test(path)) throw outside()
    checkSegments(path, this.windows)
    let lexical: string
    try {
      lexical = resolveWithinRoot(root, path)
    } catch {
      throw outside()
    }
    let realRoot: string
    try {
      realRoot = realpathSync.native(resolve(root))
    } catch {
      throw outside("The thread's folder cannot be checked.")
    }
    // The place itself, except for a path that is looked at as Git looks at it: then a link at the end stays a link.
    const real =
      intent === 'inspect' && lexical !== resolve(root)
        ? join(realPathOrAncestor(dirname(lexical)), basename(lexical))
        : realPathOrAncestor(lexical)
    // Both are real paths, which name a folder the way the file system does, so they are compared exactly:
    // folding case would take a folder beside the root, on a volume that tells them apart, for the root.
    if (!isInsidePath(real, realRoot, false)) throw outside('That path leads outside the thread’s folder.')
    return { realRoot, real, lexical }
  }

  private assertChangeable(name: string): void {
    if (name.split('/').some((segment) => isGitName(segment, this.windows)))
      throw protectedPath('Another computer cannot change Git’s own files (.git).')
    if (this.controlFiles.includes(name.toLowerCase()))
      throw protectedPath('Another computer cannot change Mousse’s control files.')
    if (startsPrograms(name) && isStricter(this.ceiling, 'full'))
      throw new PathContainmentError(
        'path_needs_full_access',
        'This file starts programs on this computer by itself (an agent setting or a hook runner), so changing it needs Full access for this device.'
      )
  }
}

const guards = new Map<PermissionMode, RoutedGuard>()

/** The guard the protocol handlers use for a call from another computer whose device may run turns up to `ceiling`. */
export function routedGuardFor(ceiling: PermissionMode): RoutedGuard {
  let guard = guards.get(ceiling)
  if (!guard) guards.set(ceiling, (guard = new RoutedGuard({ ceiling })))
  return guard
}
