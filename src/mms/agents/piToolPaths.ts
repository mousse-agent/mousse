import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * A path argument as Pi's file tools resolve it (`resolveToCwd` in the pinned 1.4.0,
 * `utils/paths.js`): Unicode spaces become spaces, a leading `@` is dropped, Git Bash, MSYS,
 * Cygwin and WSL drive forms become Windows paths on Windows, `~` is the home directory and
 * `file://` URLs are file paths. The gate checks this absolute path and hands it to Pi in place of
 * the raw argument, so the tool runs on exactly the path that was checked.
 */

const UNICODE_SPACES = /[  -   　]/g

export interface PiPathOptions {
  platform?: NodeJS.Platform
  home?: string
}

function windowsShellPath(path: string): string {
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\')) return path
  const match = path.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i)
  if (!match) return path
  return `${match[1].toUpperCase()}:\\${match[2]?.replaceAll('/', '\\') ?? ''}`
}

/** Pi's normalization of a path argument, before it is made absolute. */
export function piNormalizePath(input: string, options: PiPathOptions = {}): string {
  const platform = options.platform ?? process.platform
  let path = input.replace(UNICODE_SPACES, ' ')
  if (path.startsWith('@')) path = path.slice(1)
  if (platform === 'win32') path = windowsShellPath(path)
  const home = options.home ?? homedir()
  if (path === '~') return home
  if (path.startsWith('~/') || (platform === 'win32' && path.startsWith('~\\'))) return join(home, path.slice(2))
  if (/^file:\/\//.test(path)) return fileURLToPath(path)
  return path
}

/** The absolute path Pi's tool would open for `input` in `cwd` (Pi does not normalize its cwd). */
export function piResolvePath(input: string, cwd: string, options: PiPathOptions = {}): string {
  const path = piNormalizePath(input, options)
  return isAbsolute(path) ? resolve(path) : resolve(cwd, path)
}

/** Pi's file tools and the argument that names their path (`.` when omitted). */
export const PI_PATH_ARGUMENTS: Readonly<Record<string, { key: string; fallback?: string }>> = Object.freeze({
  read: { key: 'path' },
  ls: { key: 'path', fallback: '.' },
  grep: { key: 'path', fallback: '.' },
  find: { key: 'path', fallback: '.' },
  edit: { key: 'path' },
  write: { key: 'path' }
})

/**
 * The file Pi's `read` opens for `input` (`resolveReadPathAsync`): the resolved path when it
 * exists, else the first existing variant in Pi's order (narrow no-break space before AM/PM, NFD,
 * curly apostrophe, NFD with curly apostrophe), else the resolved path. The gate checks this one.
 */
export function piResolveReadPath(input: string, cwd: string, options: PiPathOptions & { exists?: (path: string) => boolean } = {}): string {
  const exists = options.exists ?? existsSync
  const resolved = piResolvePath(input, cwd, options)
  if (exists(resolved)) return resolved
  const amPm = resolved.replace(/ (AM|PM)\./gi, ' $1.')
  const nfd = resolved.normalize('NFD')
  const curly = resolved.replace(/'/g, '’')
  const nfdCurly = nfd.replace(/'/g, '’')
  return [amPm, nfd, curly, nfdCurly].find((variant) => variant !== resolved && exists(variant)) ?? resolved
}
