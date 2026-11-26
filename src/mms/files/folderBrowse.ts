import { readdir, realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { DomainRpcError } from '../protocol/domainRegistry'
import { isNetworkOrDevicePath } from '../bridge/remote/remoteFolders'
import { isInsidePath } from './pathGuard'
import { currentFolderEnvironment, sensitiveFolderContaining, type FolderRuleEnvironment } from './sensitiveFolders'
import { listFilesPlaces, type FilesPlaces } from './drives'

/** The most folders one answer lists; a larger folder says it was cut. */
export const FOLDER_BROWSE_MAX = 500

export interface BrowsedFolder {
  name: string
  path: string
}

export interface FolderBrowseResult {
  /** The folder listed; null for the starting places (the home folder and the drives). */
  path: string | null
  /** The folder above it, or null at the top. */
  parent: string | null
  folders: BrowsedFolder[]
  truncated?: boolean
}

export interface FolderBrowseOptions {
  /** The Mousse data folders, which are not listed. */
  homes: readonly string[]
  rules?: FolderRuleEnvironment
  places?: () => Promise<FilesPlaces>
}

/**
 * The folders inside a folder of this computer, for a window on another computer that picks where something goes
 * (a clone). Only folder names cross, never files; hidden folders, the Mousse data folder and folders that hold
 * credentials or settings (`sensitiveFolders`) are not listed and cannot be opened. Without `path`, the home folder
 * and the drives (or root and volumes) to start from; network drives are left out.
 */
export async function browseFolders(path: string | undefined, options: FolderBrowseOptions): Promise<FolderBrowseResult> {
  const rules = options.rules ?? currentFolderEnvironment()
  if (path === undefined || path === '') {
    const places = await (options.places ?? listFilesPlaces)()
    const drives = places.drives.filter((drive) => !isNetworkOrDevicePath(drive.path) && !(drive.volume ?? '').includes('\\'))
    return {
      path: null,
      parent: null,
      folders: [{ name: 'Home', path: places.home }, ...drives.map((drive) => ({ name: drive.label, path: drive.path }))]
    }
  }
  if (path.includes('\0') || !isAbsolute(path) || isNetworkOrDevicePath(path)) throw new DomainRpcError('invalid_params', 'path must be a full local folder path')
  let real: string
  try {
    real = await realpath(resolve(path))
    if (!(await stat(real)).isDirectory()) throw new Error('not a folder')
  } catch {
    throw new DomainRpcError('not_found', 'That folder does not exist on this computer.')
  }
  const hidden = (folder: string) =>
    options.homes.some((home) => isInsidePath(folder, home)) || sensitiveFolderContaining(folder, rules) !== undefined
  if (isNetworkOrDevicePath(real) || hidden(real)) throw new DomainRpcError('forbidden', 'That folder cannot be browsed from another computer.')
  const entries = await readdir(real, { withFileTypes: true })
  const folders: BrowsedFolder[] = []
  let truncated = false
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))) {
    // Links are left out: where one leads is not checked here.
    if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name.startsWith('$')) continue
    const child = join(real, entry.name)
    if (hidden(child)) continue
    if (folders.length >= FOLDER_BROWSE_MAX) {
      truncated = true
      break
    }
    folders.push({ name: entry.name, path: child })
  }
  const up = dirname(real)
  return { path: real, parent: up === real ? null : up, folders, ...(truncated ? { truncated: true } : {}) }
}
