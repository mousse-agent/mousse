import { lstatSync, readlinkSync, realpathSync } from 'node:fs'
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { ProfileIdentityError, ProfilePathError } from '../../shared/profiles/errors'
import { canonicalizeProfileId, isProfileId } from '../../shared/profiles/ids'

const MAX_LINK_HOPS = 40

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
  const parts = absolute.slice(root.length).split(/[\\/]+/).filter(Boolean)
  for (let depth = parts.length; depth >= 0; depth--) {
    let real: string
    try {
      real = realpathSync.native(root + parts.slice(0, depth).join(sep))
    } catch {
      continue
    }
    if (depth === parts.length) return real
    const next = join(real, parts[depth])
    if (!isSymbolicLink(next)) return join(real, ...parts.slice(depth))
    if (hops >= MAX_LINK_HOPS) {
      throw new ProfilePathError('Path has too many levels of symbolic links', { path: absolute })
    }
    const target = readlinkSync(next)
    const base = isAbsolute(target) ? target : real + sep + target
    return realLocation([base, ...parts.slice(depth + 1)].join(sep), hops + 1)
  }
  return resolve(absolute)
}

/**
 * Containment checks compare both sides in this form, so a path is judged by
 * where it lands rather than by how its ancestors are spelled.
 */
export function canonicalizeAbsolutePath(input: string): string {
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
  return realLocation(absolute, 0)
}

function isContained(rootPath: string, candidatePath: string): boolean {
  const rel = relative(rootPath, candidatePath)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
}

export function pathKey(path: string): string {
  const canonical = canonicalizeAbsolutePath(path)
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
  if (candidate.includes('\0')) {
    throw new ProfilePathError(`${label} contains a NUL byte`, { path: candidate })
  }
  const rootPath = canonicalizeAbsolutePath(root)
  const real = canonicalizeAbsolutePath(candidate)
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
