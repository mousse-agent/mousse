import { isAbsolute, resolve, relative, normalize, sep } from 'path'

/** Whether a path that is relative to a folder leaves it. `..cache` is a name, not a step up. */
export function leavesFolder(rel: string): boolean {
  return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)
}

/**
 * Whether `child` is `parent` or lies below it. The names are compared as they are, so both sides
 * should already be real paths. Case is folded where file systems usually do, and `..cache` is a name.
 */
export function isInsidePath(
  child: string,
  parent: string,
  caseless = process.platform === 'win32' || process.platform === 'darwin'
): boolean {
  const from = caseless ? parent.toLowerCase() : parent
  const to = caseless ? child.toLowerCase() : child
  return !leavesFolder(relative(from, to))
}

export function resolveWithinRoot(root: string, targetPath = ''): string {
  const resolvedRoot = resolve(root)
  const resolved = resolve(resolvedRoot, normalize(targetPath || '.'))
  const rel = relative(resolvedRoot, resolved)
  // On Windows a path on another drive or share has no relative form, so
  // `relative` returns it absolute instead of starting with `..`.
  if (leavesFolder(rel) || resolve(resolved) !== resolved) {
    throw new Error('Path is outside the project root')
  }
  return resolved
}

/**
 * What the caller does with the path. `inspect` is for a tool that reads a link at the path as a link and
 * never follows it (Git, the review): only the folders above the path are resolved.
 */
export type PathIntent = 'read' | 'write' | 'inspect'

/** A path inside a root: where to open it, and its name relative to the root (`/`-separated, empty for the root). */
export interface GuardedPath {
  absolute: string
  relative: string
}

/** Decides which file a path inside a root names, and whether the caller may read or change it. */
export interface PathGuard {
  /** Whether the guard holds to what is on disk (links, the real folder) and not only to the spelling. */
  readonly contained: boolean
  resolve(root: string, path: string, intent: PathIntent): GuardedPath
}

/**
 * The guard for a Mousse window on this computer: the path must stay inside the root as it is
 * spelled. A link inside the folder that leads elsewhere is followed, as the user's own tools do.
 */
export const lexicalGuard: PathGuard = {
  contained: false,
  resolve(root, path) {
    const absolute = resolveWithinRoot(root, path)
    return { absolute, relative: relative(resolve(root), absolute).replace(/\\/g, '/') }
  }
}

export const SKIP_DIR_NAMES = new Set([
  'node_modules',
  '.git',
  'dist',
  'out',
  '.mousse-worktrees'
])
