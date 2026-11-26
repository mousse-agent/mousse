import { realpathSync } from 'node:fs'
import { isInsidePath } from '../../files/pathGuard'
import { currentFolderEnvironment, sensitiveFolderHolding, type FolderRuleEnvironment } from '../../files/sensitiveFolders'

/**
 * A Windows network or device path (`\\host\share`, `\\?\C:\x`, `\\.\pipe\x`). Resolving one makes
 * this computer reach out to a host the caller names, and the lookup blocks until it answers.
 */
export function isNetworkOrDevicePath(path: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32' && /^[\\/]{2}/.test(path)
}

/**
 * A path with a hidden folder in it (`~/.private-project`, `C:\$Recycle.Bin\x`): folder browsing for another computer
 * does not list these, so they cannot be opened or cloned into by naming them either.
 */
export function hasHiddenSegment(path: string): boolean {
  return path.split(/[\\/]+/).some((segment) => segment.startsWith('.') || segment.startsWith('$'))
}

/** Why another computer may not make `folders` (spellings of one folder: as given, and its real path) a project. */
export type RemoteFolderProblem =
  /** Inside the Mousse data folder, or a folder that holds it (a user's home folder does). */
  | { kind: 'data' }
  /** Holds credentials or settings (`sensitiveFolders`), is inside such a folder, or above one. */
  | { kind: 'sensitive'; holds: string }

/**
 * What keeps another computer from making a folder here a project: the data folder, which holds keys and every
 * profile's data, and the user's credentials and settings, which file tools in a thread there could read or change
 * without asking. `homes` are the Mousse data folders (the profile's and the installation's).
 */
export function remoteFolderProblem(
  folders: readonly string[],
  homes: readonly string[],
  rules: FolderRuleEnvironment = currentFolderEnvironment()
): RemoteFolderProblem | undefined {
  for (const home of homes) {
    let realHome = home
    try {
      realHome = realpathSync.native(home)
    } catch {
      // A home that cannot be resolved is still compared by its own path.
    }
    if ([home, realHome].some((root) => folders.some((folder) => isInsidePath(folder, root) || isInsidePath(root, folder))))
      return { kind: 'data' }
  }
  const holds = sensitiveFolderHolding(folders, rules)
  return holds ? { kind: 'sensitive', holds } : undefined
}
