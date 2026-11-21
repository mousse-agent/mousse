import { lstatSync, readlinkSync, realpathSync } from 'node:fs'
import { lstat, readlink, realpath } from 'fs/promises'
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { ProfileIdentityError, ProfilePathError } from '../../shared/profiles/errors'
import { canonicalizeProfileId, isProfileId } from '../../shared/profiles/ids'

const MAX_LINK_HOPS = 40
// A backslash is an ordinary file name character off Windows.
const SEPARATORS = sep === '\\' ? /[\\/]+/ : /\/+/

function isSymbolicLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}

/**
 * The location the filesystem would use for `absolute`, including paths that do
 * not exist yet. The deepest existing prefix goes through realpath, which also
 * expands platform aliases (macOS /var -> /private/var, Windows 8.3 short names).
 * A dangling link is followed to its target, because writing through it creates
 * that target. Link targets are spliced in unnormalized, so `link/..` climbs from
 * where the link points, as the filesystem does, not from where the link sits.
 */
function realLocation(absolute: string, hops: number): string {
  const { root } = parse(absolute)
  const parts = absolute.slice(root.length).split(SEPARATORS).filter(Boolean)
  for (let depth = parts.length; depth >= 0; depth--) {
    let real: string
    try {
      real = realpathSync.native(root + parts.slice(0, depth).join(sep))
    } catch {
      continue
    }
    if (depth === parts.length) return real
    const next = join(real, parts[depth])
    if (!isSymbolicLink(next)) {
      const tail = parts.slice(depth)
      const joined = join(real, ...tail)
      // `..` after a missing folder cancels it and can expose existing entries,
      // links included, so resolve the shortened path again. It has no `..` left.
      return tail.includes('..') ? realLocation(joined, hops) : joined
    }
    if (hops >= MAX_LINK_HOPS) {
      throw new ProfilePathError('Path has too many levels of symbolic links', { path: absolute })
    }
    const target = readlinkSync(next)
    const base = isAbsolute(target) ? target : real + sep + target
    return realLocation([base, ...parts.slice(depth + 1)].join(sep), hops + 1)
  }
  return resolve(absolute)
}

/** The same prefix and dangling-link resolution as realLocation, without blocking the event loop. */
async function realLocationAsync(absolute: string, hops: number): Promise<string> {
  const { root } = parse(absolute)
  const parts = absolute.slice(root.length).split(SEPARATORS).filter(Boolean)
  for (let depth = parts.length; depth >= 0; depth--) {
    const real = await realpath(root + parts.slice(0, depth).join(sep)).catch(() => undefined)
    if (!real) continue
    if (depth === parts.length) return real
    const next = join(real, parts[depth])
    const info = await lstat(next).catch(() => undefined)
    if (!info?.isSymbolicLink()) {
      const tail = parts.slice(depth)
      const joined = join(real, ...tail)
      return tail.includes('..') ? realLocationAsync(joined, hops) : joined
    }
    if (hops >= MAX_LINK_HOPS) {
      throw new ProfilePathError('Path has too many levels of symbolic links', { path: absolute })
    }
    const target = await readlink(next)
    const base = isAbsolute(target) ? target : real + sep + target
    return realLocationAsync([base, ...parts.slice(depth + 1)].join(sep), hops + 1)
  }
  return resolve(absolute)
}

function absolutePath(input: string): string {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new ProfilePathError('Path must be a non-empty string')
  }
  if (input.includes('\0')) {
    throw new ProfilePathError('Path contains a NUL byte', { path: input })
  }
  const absolute = isAbsolute(input) ? input : resolve(input)
  if (!isAbsolute(absolute)) {
    throw new ProfilePathError('Path must resolve to an absolute location', { path: input })
  }
  return absolute
}

/**
 * Containment checks compare both sides in this form, so a path is judged by
 * where it lands rather than by how its ancestors are spelled.
 */
export function canonicalizeAbsolutePath(input: string): string {
  return realLocation(absolutePath(input), 0)
}

function isContained(rootPath: string, candidatePath: string): boolean {
  const rel = relative(rootPath, candidatePath)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
}

export function pathKey(path: string): string {
  return caseNormalizedPath(canonicalizeAbsolutePath(path))
}

export async function pathKeyAsync(path: string): Promise<string> {
  return caseNormalizedPath(await realLocationAsync(absolutePath(path), 0))
}

function caseNormalizedPath(canonical: string): string {
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical
}

export function pathsEqual(a: string, b: string): boolean {
  return pathKey(a) === pathKey(b)
}

export function isPathInsideRoot(root: string, candidate: string): boolean {
  return isContained(canonicalizeAbsolutePath(root), canonicalizeAbsolutePath(candidate))
}

function assertNoTraversalSegments(segments: string[]): void {
  for (const segment of segments) {
    if (segment === '') {
      throw new ProfilePathError('Path segment must not be empty')
    }
    if (segment.includes('\0') || segment.includes('/') || segment.includes('\\')) {
      throw new ProfilePathError('Path segment must not contain separators or NUL bytes', { segment })
    }
    if (segment === '.' || segment === '..') {
      throw new ProfilePathError('Path segment must not be relative', { segment })
    }
    if (isAbsolute(segment)) {
      throw new ProfilePathError('Path segment must not be absolute', { segment })
    }
  }
}

export function joinOwnedPath(root: string, ...segments: string[]): string {
  assertNoTraversalSegments(segments)
  const rootPath = canonicalizeAbsolutePath(root)
  const joined = join(rootPath, ...segments)
  const real = canonicalizeAbsolutePath(joined)
  if (!isContained(rootPath, real)) {
    throw new ProfilePathError('Resolved path escapes the owned root', { root: rootPath, path: joined, real })
  }
  return joined
}

export function assertOwnedPath(root: string, candidate: string, label = 'path'): string {
  assertNoNul(candidate, label)
  return assertCanonicalOwnership(canonicalizeAbsolutePath(root), canonicalizeAbsolutePath(candidate), candidate, label)
}

export async function assertOwnedPathAsync(root: string, candidate: string, label = 'path'): Promise<string> {
  assertNoNul(candidate, label)
  // Resolve in sequence so callers running under an I/O limit use one slot.
  const rootPath = await realLocationAsync(absolutePath(root), 0)
  const real = await realLocationAsync(absolutePath(candidate), 0)
  return assertCanonicalOwnership(rootPath, real, candidate, label)
}

function assertNoNul(candidate: string, label: string): void {
  if (candidate.includes('\0')) {
    throw new ProfilePathError(`${label} contains a NUL byte`, { path: candidate })
  }
}

function assertCanonicalOwnership(rootPath: string, real: string, candidate: string, label: string): string {
  if (!isContained(rootPath, real)) {
    throw new ProfilePathError(`${label} is outside the owned root`, { root: rootPath, path: candidate, real })
  }
  return real
}

export function assertProfileId(value: string): ReturnType<typeof canonicalizeProfileId> {
  if (!isProfileId(value)) {
    throw new ProfileIdentityError(`Invalid profile id: ${value}`, { value })
  }
  return canonicalizeProfileId(value)
}
