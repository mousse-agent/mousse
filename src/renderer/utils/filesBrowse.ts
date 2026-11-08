/**
 * Folder paths as the Files panel's path bar walks them: segments, the parent, typed paths and the
 * folder a file outside the thread's folder is read from. Paths keep the spelling of the computer they
 * came from (`C:\Users\me`, `\\server\share\x`, `/home/me`); only text is compared, nothing is read here.
 */

export interface PathSegment {
  /** What the bar shows: `C:`, `/`, `\\server\share` or a folder name. */
  label: string
  /** The folder the segment goes to. */
  path: string
}

const DRIVE = /^([A-Za-z]:)(?:[\\/]|$)/
const UNC = /^[\\/]{2}([^\\/]+)[\\/]+([^\\/]+)/

export function isAbsolutePath(path: string): boolean {
  return DRIVE.test(path) || path.startsWith('/') || path.startsWith('\\\\')
}

function isWindowsStyle(path: string): boolean {
  return DRIVE.test(path) || path.startsWith('\\\\') || (path.includes('\\') && !path.startsWith('/'))
}

/** The segments of an absolute folder path, the root first; `.` and `..` are resolved. Empty for a relative path. */
export function pathSegments(path: string): PathSegment[] {
  const trimmed = path.trim()
  if (!isAbsolutePath(trimmed)) return []
  const windows = isWindowsStyle(trimmed)
  const sep = windows ? '\\' : '/'
  let root: PathSegment
  let rest: string
  const unc = UNC.exec(trimmed)
  const drive = DRIVE.exec(trimmed)
  if (unc) {
    const label = `\\\\${unc[1]}\\${unc[2]}`
    root = { label, path: `${label}\\` }
    rest = trimmed.slice(unc[0].length)
  } else if (drive) {
    const letter = drive[1]!.toUpperCase()
    root = { label: letter, path: `${letter}\\` }
    rest = trimmed.slice(drive[1]!.length)
  } else {
    root = { label: '/', path: '/' }
    rest = trimmed
  }
  const names: string[] = []
  for (const name of rest.split(/[\\/]+/)) {
    if (!name || name === '.') continue
    if (name === '..') names.pop()
    else names.push(name)
  }
  const segments = [root]
  let current = root.path.endsWith(sep) ? root.path.slice(0, -1) : root.path
  for (const name of names) {
    current = `${current}${sep}${name}`
    segments.push({ label: name, path: current })
  }
  return segments
}

/** The absolute folder path in its plain form: one separator style, no trailing separator except at a root. */
export function normalizeFolderPath(path: string): string {
  return pathSegments(path).at(-1)?.path ?? path.trim()
}

/** The folder above `path`, or null at a drive or root. */
export function parentFolder(path: string): string | null {
  const segments = pathSegments(path)
  return segments.length > 1 ? segments[segments.length - 2]!.path : null
}

function comparable(path: string): string {
  const normal = normalizeFolderPath(path).replace(/\\/g, '/')
  return isWindowsStyle(path) ? normal.toLowerCase() : normal
}

export function samePath(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false
  return comparable(a) === comparable(b)
}

/** `path` relative to `root` with `/` between names (`''` for the root itself), or null when it is not inside. */
export function pathInside(path: string, root: string): string | null {
  if (!root || !isAbsolutePath(path)) return null
  const child = comparable(path)
  const parent = comparable(root)
  if (child === parent) return ''
  const prefix = parent.endsWith('/') ? parent : `${parent}/`
  if (!child.startsWith(prefix)) return null
  return normalizeFolderPath(path).replace(/\\/g, '/').slice(prefix.length)
}

/** `relative` (`/`-separated, as the tree names entries) inside the folder `root`, spelled as `root` is. */
export function joinFolder(root: string, relative: string): string {
  if (!relative) return normalizeFolderPath(root)
  const sep = isWindowsStyle(root) ? '\\' : '/'
  return normalizeFolderPath(`${normalizeFolderPath(root)}${sep}${relative.replace(/[\\/]+/g, sep)}`)
}

/**
 * The folder a typed or pasted path names: absolute, `~` for the home folder, a bare drive (`D:`), or relative
 * to the folder shown. Quotes around a pasted path are dropped. Null when it names nothing.
 */
export function resolveTypedPath(input: string, current: string, home: string | null): string | null {
  let text = input.trim()
  if (/^(["']).*\1$/.test(text)) text = text.slice(1, -1).trim()
  if (!text) return null
  if (text === '~' || /^~[\\/]/.test(text)) {
    if (!home) return null
    return joinFolder(home, text.slice(2))
  }
  if (/^[A-Za-z]:$/.test(text)) return `${text.toUpperCase()}\\`
  if (isAbsolutePath(text)) return normalizeFolderPath(text)
  if (!current) return null
  return joinFolder(current, text)
}

/**
 * The folder the Files panel shows for a thread: where the person went in the panel for this thread, else
 * the thread's working folder (its worktree, else its project folder), else the folder the daemon gives the
 * thread (home for a thread without one). Empty while the thread's folder is still being looked up. A thread
 * of another computer always shows the daemon's folder: browsing elsewhere is for this computer's folders.
 */
export function filesBrowseRoot(input: {
  navigated: string | undefined
  threadFolder: string | null
  threadFolderLoading: boolean
  filesRoot: string
  remote: boolean
}): string {
  if (input.remote) return input.filesRoot
  if (input.navigated) return input.navigated
  if (input.threadFolderLoading) return ''
  return input.threadFolder || input.filesRoot
}

/**
 * How a file of the panel is read and saved. A path inside the thread's folder is relative and needs no
 * folder; an absolute one, opened while browsing elsewhere, is read from its own folder by name.
 */
export function fileLocation(path: string): { path: string; root?: string } {
  if (!isAbsolutePath(path)) return { path }
  const segments = pathSegments(path)
  if (segments.length < 2) return { path }
  return { path: segments[segments.length - 1]!.label, root: segments[segments.length - 2]!.path }
}

/**
 * A short line for a folder the path bar could not open, and the full reason for its tooltip. Error codes do not
 * cross from the main process (only the text does), so the daemon's own wording is matched.
 */
export function folderErrorText(error: string): { text: string; detail: string } {
  const detail = error.replace(/^Error invoking remote method '[^']*':\s*/, '').replace(/^\w*Error:\s*/, '')
  const text =
    /not answering|folder_not_answering/i.test(detail) ? 'Drive not answering'
    : /older than this app|Restart Mousse/i.test(detail) ? 'Restart Mousse to browse here'
    : /Network and device paths/i.test(detail) ? 'Map the share to a drive first'
    : /Enter the full path|not a folder path|must be an absolute path/i.test(detail) ? 'Type the full path'
    : /Only a Mousse window|forbidden/i.test(detail) ? 'Not allowed here'
    : /ENOTDIR|Not a directory/i.test(detail) ? 'Not a folder'
    : /EACCES|EPERM|permission denied|access is denied/i.test(detail) ? 'Access denied'
    : /ENOENT|no such file|not found|cannot find/i.test(detail) ? 'Folder not found'
    : 'Couldn’t open this folder'
  return { text, detail }
}
