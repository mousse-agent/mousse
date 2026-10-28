/**
 * The folder a thread works in, as the computer that runs the thread tells another computer so that an
 * editor there can open it over SSH (`editor.folder`).
 *
 * The owner resolves the folder from the thread id and never takes a path from the caller. What it sends
 * back carries the folder twice: as the owner's own system writes it (`path`, for display), and as the path
 * of a Remote-SSH address (`uriPath`), so the computer that asks does not have to guess the owner's path rules.
 */

/** How the owner's system writes a path: `/home/me/app` or `C:\Users\me\app`. */
export type EditorFolderStyle = 'posix' | 'windows'

/** Where the folder comes from: the thread's own worktree, or the project's folder. */
export type EditorFolderKind = 'worktree' | 'project'

export interface EditorFolder {
  /** The folder as the owner's system writes it. For display only; an editor is opened with `uriPath`. */
  path: string
  /**
   * The path of a Remote-SSH address: slashes only, from the root. On a Windows owner `C:\Users\me\app` is
   * `/C:/Users/me/app` (the drive letter keeps the case it has). It is NOT percent-encoded: a name may hold
   * `#`, `%`, `?`, spaces or non-ASCII letters. Whoever builds an address from it (`vscode-remote://…`,
   * `ssh://…`) must
   * - work it out again with `remoteEditorPath(path, style)` and refuse the answer when that is undefined or
   *   differs from `uriPath`, instead of trusting the field, and
   * - encode each segment with `encodeURIComponent` and join them with `/`, keeping the `:` after a drive
   *   letter: `encodeURI` leaves `#` and `?` alone.
   */
  uriPath: string
  style: EditorFolderStyle
  /** The owner's system (`process.platform`): `linux`, `darwin` or `win32`. */
  platform: string
  kind: EditorFolderKind
  /**
   * The owner's login name, when the system tells it and it is safe to write into an SSH config's `User` line
   * (see `isSafeLoginName`); left out otherwise.
   */
  user?: string
}

/**
 * Whether `name` can be written as it is into an SSH config's `User` line: letters, digits, `_`, `.` and `-`
 * (any script's letters), starting with a letter, digit or `_`, at most 64 characters. A name with a space,
 * a quote, a `#` or a control character is not, and is left out of the reply. Whoever writes the config
 * checks it again.
 */
export const isSafeLoginName = (name: unknown): name is string =>
  typeof name === 'string' && /^[\p{L}\p{N}_][\p{L}\p{N}_.-]{0,63}$/u.test(name)

/** The longest folder path an owner sends (the usual limit of Linux paths). */
export const EDITOR_FOLDER_PATH_MAX = 4096

export const editorFolderStyleOf = (platform: string): EditorFolderStyle =>
  platform === 'win32' ? 'windows' : 'posix'

/** Characters Windows does not allow in a name; `:` is only allowed in the drive. */
const WINDOWS_FORBIDDEN = /[<>:"|?*]/

/**
 * The path of a Remote-SSH address for an absolute folder `path` of an owner that writes paths in `style`,
 * or undefined when it cannot be one: not absolute, a Windows network share or `\\?\` path, a `..` segment,
 * a control character, or too long. Repeated and trailing separators and `.` segments are dropped.
 */
export function remoteEditorPath(path: unknown, style: EditorFolderStyle): string | undefined {
  if (typeof path !== 'string' || !path || path.length > EDITOR_FOLDER_PATH_MAX) return undefined
  if (/[\u0000-\u001f\u007f]/.test(path)) return undefined
  if (style === 'windows') {
    // Only `C:\…` or `C:/…`: not `C:name` (relative to a drive's own folder), a network share or a `\\?\` path.
    const drive = /^([A-Za-z]):[\\/]/.exec(path)
    if (!drive) return undefined
    const rest = path.slice(drive[0].length)
    if (WINDOWS_FORBIDDEN.test(rest)) return undefined
    const segments = rest.split(/[\\/]+/).filter((segment) => segment && segment !== '.')
    if (segments.includes('..')) return undefined
    return `/${drive[1]}:/${segments.join('/')}`
  }
  if (!path.startsWith('/')) return undefined
  const segments = path.split('/').filter((segment) => segment && segment !== '.')
  if (segments.includes('..')) return undefined
  return `/${segments.join('/')}`
}
