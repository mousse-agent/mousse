import { lstatSync, realpathSync } from 'node:fs'
import { isAbsolute, join, normalize, posix, sep, win32 } from 'node:path'
import {
  WORKFLOW_MAX_PATH_COMPONENT_LENGTH,
  WORKFLOW_MAX_PATH_DEPTH,
  WORKFLOW_MAX_RELATIVE_PATH_LENGTH
} from '../../shared/workflows'

const WINDOWS_DEVICE_NAMES = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  'COM1',
  'COM2',
  'COM3',
  'COM4',
  'COM5',
  'COM6',
  'COM7',
  'COM8',
  'COM9',
  'LPT1',
  'LPT2',
  'LPT3',
  'LPT4',
  'LPT5',
  'LPT6',
  'LPT7',
  'LPT8',
  'LPT9'
])

export interface SafeRelativePathResult {
  ok: true
  relativePath: string
  segments: string[]
}

export interface UnsafeRelativePathResult {
  ok: false
  reason: string
}

export type RelativePathCheck = SafeRelativePathResult | UnsafeRelativePathResult

/**
 * Normalize a bundle-relative asset path. Rejects absolute paths, traversal,
 * NUL, alternate data streams, device names, and UNC/device namespaces.
 */
export function checkBundleRelativePath(input: string): RelativePathCheck {
  if (typeof input !== 'string' || input.length === 0) {
    return { ok: false, reason: 'Path is empty' }
  }
  if (input.length > WORKFLOW_MAX_RELATIVE_PATH_LENGTH) {
    return { ok: false, reason: 'Path exceeds maximum length' }
  }
  if (input.includes('\0')) {
    return { ok: false, reason: 'Path contains a NUL byte' }
  }
  const unified = input.replace(/\\/g, '/')
  if (unified.startsWith('/') || unified.startsWith('//') || /^[a-zA-Z]:/.test(unified)) {
    return { ok: false, reason: 'Absolute paths are not allowed' }
  }
  if (unified.startsWith('\\\\') || unified.includes('//') || unified.includes('\\\\')) {
    return { ok: false, reason: 'UNC or empty path segments are not allowed' }
  }
  if (unified.includes(':')) {
    return { ok: false, reason: 'Alternate data streams and drive prefixes are not allowed' }
  }
  const rawSegments = unified.split('/').filter((segment, index, all) => {
    if (segment === '' && (index === 0 || index === all.length - 1)) return false
    return true
  })
  if (rawSegments.length === 0) return { ok: false, reason: 'Path is empty' }
  if (rawSegments.length > WORKFLOW_MAX_PATH_DEPTH) {
    return { ok: false, reason: 'Path exceeds maximum depth' }
  }
  const segments: string[] = []
  for (const segment of rawSegments) {
    if (segment === '' || segment === '.' || segment === '..') {
      return { ok: false, reason: 'Path traversal is not allowed' }
    }
    if (segment.length > WORKFLOW_MAX_PATH_COMPONENT_LENGTH) {
      return { ok: false, reason: 'Path component is too long' }
    }
    if (segment.endsWith(' ') || segment.endsWith('.')) {
      return { ok: false, reason: 'Path component has a trailing space or dot' }
    }
    const stem = segment.includes('.') ? segment.slice(0, segment.indexOf('.')) : segment
    if (WINDOWS_DEVICE_NAMES.has(stem.toUpperCase()) || WINDOWS_DEVICE_NAMES.has(segment.toUpperCase())) {
      return { ok: false, reason: `Device path "${segment}" is not allowed` }
    }
    segments.push(segment)
  }
  return { ok: true, relativePath: segments.join('/'), segments }
}

export function posixJoin(root: string, relativePath: string): string {
  return join(root, ...relativePath.split('/'))
}

export function toPosixRelative(from: string, target: string): string {
  const rel = posix.normalize(target.replace(/\\/g, '/'))
  const base = posix.normalize(from.replace(/\\/g, '/'))
  let out = posix.relative(base, rel)
  if (sep === win32.sep) {
    out = out.replace(/\\/g, '/')
  }
  return out
}

export interface ContainedPathResult {
  ok: true
  resolved: string
  real: string
}

export interface EscapingPathResult {
  ok: false
  reason: string
}

/**
 * Resolve `relativePath` under `root`, following no symlink that escapes root.
 * Each existing ancestor is lstat'd; symlink targets must remain inside root.
 */
export function resolveContainedPath(root: string, relativePath = '.'): ContainedPathResult | EscapingPathResult {
  const rootCheck = normalizeRoot(root)
  if (!rootCheck.ok) return rootCheck
  const relative =
    relativePath === '.' || relativePath === ''
      ? { ok: true as const, relativePath: '', segments: [] as string[] }
      : checkBundleRelativePath(relativePath)
  if (!relative.ok) return relative
  let current = rootCheck.resolved
  for (const segment of relative.segments) {
    const next = join(current, segment)
    try {
      const stat = lstatSync(next)
      if (stat.isSymbolicLink()) {
        let real: string
        try {
          real = realpathSync(next)
        } catch {
          return { ok: false, reason: 'Symlink target cannot be resolved' }
        }
        if (!isInsideRoot(rootCheck.real, real)) {
          return { ok: false, reason: 'Symlink escapes the allowed root' }
        }
        current = real
        continue
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT') {
        current = next
        continue
      }
      return { ok: false, reason: 'Path cannot be inspected' }
    }
    current = next
  }
  if (!isInsideRoot(rootCheck.real, current) && normalize(current) !== rootCheck.resolved) {
    const existing = tryRealpath(current)
    if (existing && !isInsideRoot(rootCheck.real, existing)) {
      return { ok: false, reason: 'Resolved path escapes the allowed root' }
    }
  }
  // Keep the checked lexical path available to callers that explicitly refuse
  // symlinks via lstat. Returning the target here erased that evidence.
  return { ok: true, resolved: join(rootCheck.resolved, ...relative.segments), real: tryRealpath(current) ?? current }
}

export function normalizeRoot(root: string): ContainedPathResult | EscapingPathResult {
  if (!root || typeof root !== 'string') return { ok: false, reason: 'Root path is empty' }
  const resolved = normalize(root)
  if (!isAbsolute(resolved)) return { ok: false, reason: 'Root path must be absolute' }
  const real = tryRealpath(resolved) ?? resolved
  return { ok: true, resolved, real }
}

export function isInsideRoot(rootReal: string, candidate: string): boolean {
  const fold = process.platform === 'win32' ? (value: string) => value.toLowerCase() : (value: string) => value
  const rootNorm = fold(normalize(rootReal))
  const candNorm = fold(normalize(candidate))
  if (candNorm === rootNorm) return true
  const prefix = rootNorm.endsWith(sep) ? rootNorm : rootNorm + sep
  return candNorm.startsWith(prefix)
}

function tryRealpath(path: string): string | undefined {
  try {
    return realpathSync(path)
  } catch {
    return undefined
  }
}

export function isUnsafeWorkspaceFileInput(value: string): boolean {
  if (!value || value.includes('\0')) return true
  const unified = value.replace(/\\/g, '/')
  if (unified.startsWith('/') || /^[a-zA-Z]:/.test(unified) || unified.startsWith('//')) return true
  if (unified.split('/').some((part) => part === '..')) return true
  if (unified.includes(':')) return true
  const check = checkBundleRelativePath(unified.replace(/^\.\//, ''))
  return !check.ok
}
