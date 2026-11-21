import { realpathSync } from 'node:fs'
import { posix, win32 } from 'node:path'
import { isInsidePath } from './pathGuard'
import { realPathOrAncestor } from './realPath'
import { isGitName } from './routedGuard'
import { sensitiveFolderContaining, type FolderRuleEnvironment } from './sensitiveFolders'

/**
 * A folder the Files panel of this computer's window browses instead of the thread's folder (`root` of
 * `files.list`, `files.read`, `files.readAsset` and `files.writeDirect`).
 *
 * The protocol handler accepts one from a Mousse window on this computer only. Here are the rules for the
 * path itself, and for a save into it:
 * - it is a full path on a drive of this computer (Windows: `C:\…`; elsewhere `/…`). A network share
 *   (`\\server\share`) is refused, because opening one signs in to that computer with the user's Windows
 *   account; so are Windows device paths (`\\?\…`, `\\.\…`). A share mapped to a drive letter works;
 * - every path of the call stays inside it, as for a thread's folder (`lexicalGuard`);
 * - a save never lands in Git's own folder (`.git`, where hooks and config start programs), in the Mousse
 *   data folders (this computer's keys and every profile), or in the folders that hold the user's sign-ins
 *   and keys (`sensitiveFolders`). These are checked on the real path, so a link or junction inside the
 *   folder that leads there is refused too.
 */

/** Why `root` cannot be browsed, or undefined when it can. */
export function browsedRootRefusal(root: string, platform: NodeJS.Platform = process.platform): string | undefined {
  if (root.includes('\0')) return 'That is not a folder path.'
  if (platform === 'win32') {
    if (/^[\\/]{2}/.test(root)) return 'Network and device paths cannot be browsed. Map the share to a drive letter first.'
    if (!/^[a-zA-Z]:[\\/]/.test(root)) return 'Enter the full path of a folder, starting with its drive.'
    return undefined
  }
  if (!root.startsWith('/')) return 'Enter the full path of a folder, starting from /.'
  return undefined
}

/** `root` with `.` and `..` resolved, once `browsedRootRefusal` accepted it. */
export function normalizedBrowsedRoot(root: string, platform: NodeJS.Platform = process.platform): string {
  return (platform === 'win32' ? win32 : posix).resolve(root)
}

function realOrSelf(path: string): string {
  try {
    return realpathSync.native(path)
  } catch {
    return path
  }
}

/**
 * Why a save to `target` (an absolute path inside a browsed folder) is refused, or undefined when it may be
 * written. `dataFolders` are the Mousse data folders of this computer.
 */
export function browsedSaveRefusal(
  target: string,
  dataFolders: readonly string[],
  environment?: FolderRuleEnvironment
): string | undefined {
  let real: string
  try {
    real = realPathOrAncestor(target)
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  const spellings = [target, real]
  if (spellings.some((spelling) => spelling.split(/[\\/]+/).some((segment) => isGitName(segment))))
    return 'Files in Git’s own folder (.git) are changed with Git, not saved from the Files panel.'
  for (const folder of dataFolders) {
    const folders = [folder, realOrSelf(folder)]
    if (spellings.some((spelling) => folders.some((data) => isInsidePath(spelling, data))))
      return 'That file is in the Mousse data folder, which the Files panel does not save into.'
  }
  for (const spelling of spellings) {
    const holds = sensitiveFolderContaining(spelling, environment)
    if (holds) return `That folder holds ${holds}, so the Files panel does not save there.`
  }
  return undefined
}
