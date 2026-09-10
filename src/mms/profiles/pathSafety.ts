import { existsSync, lstatSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { ProfileIdentityError, ProfilePathError } from '../../shared/profiles/errors'
import { canonicalizeProfileId, isProfileId } from '../../shared/profiles/ids'

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
  try {
    return realpathSync.native(resolved)
  } catch {
    return resolved
  }
}

export function pathKey(path: string): string {
  const canonical = canonicalizeAbsolutePath(path)
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical
}

export function pathsEqual(a: string, b: string): boolean {
  return pathKey(a) === pathKey(b)
}

export function isPathInsideRoot(root: string, candidate: string): boolean {
  const rootPath = canonicalizeAbsolutePath(root)
  let candidatePath = resolve(candidate)
  try {
    candidatePath = realpathSync.native(candidatePath)
  } catch {
    /* destination may not exist yet */
  }
  const rel = relative(rootPath, candidatePath)
  if (rel === '') return true
  if (isAbsolute(rel)) return false
  if (rel.startsWith('..')) return false
  return true
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

function assertSymlinkChainStaysInside(root: string, candidate: string): void {
  const rootPath = canonicalizeAbsolutePath(root)
  const resolvedCandidate = resolve(candidate)
  const rel = relative(rootPath, resolvedCandidate)
  if (rel === '') return
  if (isAbsolute(rel) || rel.startsWith('..')) {
    throw new ProfilePathError('Resolved path escapes the owned root', { root: rootPath, path: resolvedCandidate })
  }
  let current = rootPath
  for (const segment of rel.split(/[/\\]/)) {
    if (!segment || segment === '.') continue
    current = join(current, segment)
    if (!existsSync(current)) return
    const stat = lstatSync(current)
    if (stat.isSymbolicLink()) {
      const real = realpathSync.native(current)
      if (!isPathInsideRoot(rootPath, real)) {
        throw new ProfilePathError('Refusing symlink that escapes the owned root', {
          root: rootPath,
          path: current,
          real
        })
      }
      current = real
    }
  }
}

export function joinOwnedPath(root: string, ...segments: string[]): string {
  assertNoTraversalSegments(segments)
  const rootPath = canonicalizeAbsolutePath(root)
  const joined = join(rootPath, ...segments)
  if (!isPathInsideRoot(rootPath, joined)) {
    throw new ProfilePathError('Resolved path escapes the owned root', { root: rootPath, path: joined })
  }
  assertSymlinkChainStaysInside(rootPath, joined)
  return joined
}

export function assertOwnedPath(root: string, candidate: string, label = 'path'): string {
  if (candidate.includes('\0')) {
    throw new ProfilePathError(`${label} contains a NUL byte`, { path: candidate })
  }
  const rootPath = canonicalizeAbsolutePath(root)
  const resolved = resolve(candidate)
  if (!isPathInsideRoot(rootPath, resolved)) {
    throw new ProfilePathError(`${label} is outside the owned root`, { root: rootPath, path: resolved })
  }
  assertSymlinkChainStaysInside(rootPath, resolved)
  return existsSync(resolved) ? canonicalizeAbsolutePath(resolved) : resolved
}

export function assertProfileId(value: string): ReturnType<typeof canonicalizeProfileId> {
  if (!isProfileId(value)) {
    throw new ProfileIdentityError(`Invalid profile id: ${value}`, { value })
  }
  return canonicalizeProfileId(value)
}
