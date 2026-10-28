import { statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, win32 } from 'node:path'
import { leavesFolder, type PathGuard } from './pathGuard'
import { outside } from './realPath'

/**
 * The folder a terminal opened from another computer starts in. `cwd` names a folder inside the
 * thread's own: relative to it, or an absolute path that lies inside it. What it names on disk, once every
 * link, junction and short name is resolved, has to be inside the thread's folder as well (the guard decides,
 * as for a file), and has to be a folder. Anything else is refused as `path_outside_folder`.
 *
 * Only where the shell starts is held to the folder. A shell can change folder as soon as it runs, so this is
 * no sandbox: it keeps a device from starting a shell somewhere the thread has no business, and a terminal on
 * another computer is code execution there whatever its first folder was.
 */
export function terminalStartFolder(root: string, cwd: string, guard: PathGuard): string {
  if (cwd.includes('\0')) throw outside()
  let name = cwd
  if (isAbsolute(cwd) || win32.isAbsolute(cwd)) {
    // Spelled with the owner's own folder (what a caller read from the thread): it has to lead back into it.
    name = relative(resolve(root), resolve(cwd))
    if (leavesFolder(name) || win32.isAbsolute(name)) throw outside('That folder is outside the thread’s folder.')
  }
  const guarded = guard.resolve(root, name || '.', 'read')
  let folder: boolean
  try {
    folder = statSync(guarded.absolute).isDirectory()
  } catch {
    folder = false
  }
  if (!folder) throw outside('That is not a folder inside the thread’s folder.')
  // Started at the folder as the thread names it, below its own root, not at a spelling of the caller's.
  return guarded.relative ? join(resolve(root), guarded.relative) : resolve(root)
}
