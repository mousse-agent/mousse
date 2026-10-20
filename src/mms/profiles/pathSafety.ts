import { lstatSync, readlinkSync, realpathSync, type Stats } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { ProfileIdentityError, ProfilePathError } from '../../shared/profiles/errors'
import { canonicalizeProfileId, isProfileId } from '../../shared/profiles/ids'

const MAX_LINK_HOPS = 40

/**
 * Resolves links and platform aliases (macOS /var -> /private/var, Windows 8.3
 * short names) in the deepest existing ancestor, then re-appends the parts that
 * do not exist yet. Containment checks compare both sides in this form, so a
 * path that does not exist yet is not misjudged by how its ancestors are spelled.
 */
export function canonicalizeAbsolutePath(input: string): string {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new ProfilePathError('Path must be a non-empty string')
  }
  if (input.includes('\0')) {
    throw new ProfilePathError('Path contains a NUL byte', { path: input })
  }
  const resolved = resolve(input)
  if (!isAbsolute(resolved)) {
    throw new ProfilePathError('Path must resolve to an absolute location', { path: input })
  }
  const missing: string[] = []
  let existing = resolved
  for (;;) {
    try {
      return join(realpathSync.native(existing), ...missing)
    } catch {
      const parent = dirname(existing)
      if (parent === existing) return resolved
      missing.unshift(basename(existing))
      existing = parent
    }
  }
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

function lstatOrUndefined(path: string): Stats | undefined {
  try {
    return lstatSync(path)
  } catch {
    return undefined
  }
}

/**
 * Canonicalization resolves every link that exists, so the only link left in a
 * canonical path is a dangling one: its target does not exist yet, and writing
 * through it would create that target. Follow such links and require each
 * target to stay inside the root. A target can itself pass through another
 * dangling link, so the walk restarts from the root on the target's components.
 */
function assertSymlinkChainStaysInside(rootPath: string, candidatePath: string): void {
  if (!isContained(rootPath, candidatePath)) {
    throw new ProfilePathError('Resolved path escapes the owned root', { root: rootPath, path: candidatePath })
  }
  const segmentsUnderRoot = (path: string) => relative(rootPath, path).split(sep).filter(Boolean)
  const pending = segmentsUnderRoot(candidatePath)
  let current = rootPath
  let hops = 0
  while (pending.length > 0) {
    const next = join(current, pending.shift()!)
    if (!lstatOrUndefined(next)?.isSymbolicLink()) {
      current = next
      continue
    }
    if (++hops > MAX_LINK_HOPS) {
      throw new ProfilePathError('Too many symlinks under the owned root', { root: rootPath, path: next })
    }
    const target = canonicalizeAbsolutePath(resolve(dirname(next), readlinkSync(next)))
    if (!isContained(rootPath, target)) {
      throw new ProfilePathError('Refusing symlink that escapes the owned root', {
        root: rootPath,
        path: next,
        real: target
      })
    }
    pending.unshift(...segmentsUnderRoot(target))
    current = rootPath
  }
}

export function joinOwnedPath(root: string, ...segments: string[]): string {
  assertNoTraversalSegments(segments)
  const rootPath = canonicalizeAbsolutePath(root)
  const joined = join(rootPath, ...segments)
  assertSymlinkChainStaysInside(rootPath, canonicalizeAbsolutePath(joined))
  return joined
}

export function assertOwnedPath(root: string, candidate: string, label = 'path'): string {
  if (candidate.includes('\0')) {
    throw new ProfilePathError(`${label} contains a NUL byte`, { path: candidate })
  }
  const rootPath = canonicalizeAbsolutePath(root)
  const canonical = canonicalizeAbsolutePath(candidate)
  if (!isContained(rootPath, canonical)) {
    throw new ProfilePathError(`${label} is outside the owned root`, { root: rootPath, path: resolve(candidate) })
  }
  assertSymlinkChainStaysInside(rootPath, canonical)
  return canonical
}

export function assertProfileId(value: string): ReturnType<typeof canonicalizeProfileId> {
  if (!isProfileId(value)) {
    throw new ProfileIdentityError(`Invalid profile id: ${value}`, { value })
  }
  return canonicalizeProfileId(value)
}
