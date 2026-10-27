import { spawnSync } from 'node:child_process'
import { lstatSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { MOUSSE_CONTROL_FILE_PATHS } from '../worktree/controlFiles'
import {
  isInsidePath,
  resolveWithinRoot,
  type GuardedPath,
  type PathGuard,
  type PathIntent
} from './pathGuard'

export type PathRefusal = 'path_outside_folder' | 'path_protected'

/** A path another computer may not read or change. `code` says which kind of refusal it is. */
export class PathContainmentError extends Error {
  constructor(
    readonly code: PathRefusal,
    message: string
  ) {
    super(message)
    this.name = 'PathContainmentError'
  }
}

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

const OUTSIDE = 'Path is outside the project root'
const outside = (message = OUTSIDE): PathContainmentError =>
  new PathContainmentError('path_outside_folder', message)
const protectedPath = (message: string): PathContainmentError =>
  new PathContainmentError('path_protected', message)

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
 * The real path of `path`, or of its deepest existing folder with the part that does not exist yet
 * after it. A link that leads nowhere is refused: writing through it would create what it points at.
 */
export function realPathOrAncestor(path: string): string {
  const missing: string[] = []
  let current = resolve(path)
  for (;;) {
    try {
      const real = realpathSync.native(current)
      return missing.length ? join(real, ...missing) : real
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR')
        throw outside(`That path cannot be checked (${code ?? 'unknown error'}).`)
    }
    try {
      lstatSync(current)
      // It exists but does not resolve: a link whose target is missing.
      throw outside('That path is a link that leads nowhere.')
    } catch (error) {
      if (error instanceof PathContainmentError) throw error
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR')
        throw outside(`That path cannot be checked (${code ?? 'unknown error'}).`)
    }
    const parent = dirname(current)
    if (parent === current) throw outside('That path cannot be checked.')
    missing.unshift(basename(current))
    current = parent
  }
}

/** The folders a repository takes hooks from other than its own: the real paths of every `core.hooksPath` it has. */
export function hookFolders(root: string): string[] {
  const read = (args: string[]) =>
    spawnSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
      timeout: 10_000,
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
    })
  const configured = read(['config', '--type=path', '--get-all', 'core.hooksPath'])
  // No Git on this computer: nothing can run a hook.
  if ((configured.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return []
  if (configured.error || (configured.status !== 0 && configured.status !== 1))
    throw protectedPath("This folder's hook settings could not be read, so nothing was written.")
  const values = configured.stdout.split(/\r?\n/).filter(Boolean)
  if (!values.length) return []
  const folders: string[] = []
  let top: string | undefined
  for (const value of values) {
    let folder: string
    if (isAbsolute(value)) folder = resolve(value)
    else {
      // A relative path is taken from the top of the working tree.
      if (top === undefined) {
        const found = read(['rev-parse', '--show-toplevel'])
        top = found.status === 0 ? found.stdout.trim() : root
      }
      folder = resolve(top, value)
    }
    try {
      folders.push(realPathOrAncestor(folder))
    } catch {
      // A setting that does not resolve still names a place; keep it as it is spelled.
      folders.push(folder)
    }
  }
  return folders
}

export interface RoutedGuardOptions {
  /** Folders whose files Git runs as hooks. Read for a write only. */
  hookFolders?: (root: string) => string[]
  /** Control files of Mousse, relative to a checkout. */
  controlFiles?: readonly string[]
  windows?: boolean
  caseless?: boolean
}

/**
 * The guard for a call from another of the user's computers. A path is allowed when what it names on
 * disk, once every link, junction, short name and difference of case is resolved, lies inside the root's
 * real folder. A change is refused as well when it would reach
 * - Git's own folder (`.git`, at any depth, a worktree's `.git` file included), whose hooks and config run
 *   programs on the next commit;
 * - a folder `core.hooksPath` names, for the same reason;
 * - a control file of Mousse;
 * - a file with other names (a hard link), which could be one of the above under another name.
 * A file that is read or written is opened at its real path, not through the path it was asked by.
 */
export class RoutedGuard implements PathGuard {
  readonly contained = true
  private readonly windows: boolean
  private readonly caseless: boolean
  private readonly controlFiles: readonly string[]
  constructor(private readonly options: RoutedGuardOptions = {}) {
    this.windows = options.windows ?? process.platform === 'win32'
    this.caseless = options.caseless ?? (this.windows || process.platform === 'darwin')
    this.controlFiles = (options.controlFiles ?? MOUSSE_CONTROL_FILE_PATHS).map((path) =>
      path.toLowerCase()
    )
  }

  resolve(root: string, path: string, intent: PathIntent): GuardedPath {
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
    if (!isInsidePath(real, realRoot, this.caseless)) throw outside('That path leads outside the thread’s folder.')
    const relativeName = relative(realRoot, real).replace(/\\/g, '/')
    if (intent === 'write') {
      // Both spellings: the one that was asked for, and the one it resolves to.
      const asked = relative(resolve(root), lexical).replace(/\\/g, '/')
      for (const name of [asked, relativeName]) this.assertChangeable(name)
      for (const folder of this.options.hookFolders?.(realRoot) ?? [])
        if (isInsidePath(real, folder, this.caseless))
          throw protectedPath('Git runs the programs in this folder, so another computer cannot change them.')
      // Checked here so a refused save is refused before anything is recorded; the save checks it again as it opens the file.
      if (hasOtherNames(real)) throw protectedPath(OTHER_NAMES)
    }
    return { absolute: real, relative: relativeName }
  }

  private assertChangeable(name: string): void {
    if (name.split('/').some((segment) => isGitName(segment, this.windows)))
      throw protectedPath('Another computer cannot change Git’s own files (.git).')
    if (this.controlFiles.includes(name.toLowerCase()))
      throw protectedPath('Another computer cannot change Mousse’s control files.')
  }
}

/** The guard the protocol handlers use for a call from another computer. */
export const routedGuard = new RoutedGuard({ hookFolders })
