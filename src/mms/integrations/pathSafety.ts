import { isAbsolute, normalize, sep, win32, posix } from 'path'

const WINDOWS_DEVICE_PATTERN =
  /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i

export interface UnsafePathReason {
  path: string
  reason: string
}

export function inspectRelativePath(entry: string): UnsafePathReason | undefined {
  const raw = entry.replace(/\0/g, '')
  if (raw !== entry) {
    return { path: entry, reason: 'Path contains a NUL byte.' }
  }
  if (!raw || raw === '.' || raw === './') {
    return { path: entry, reason: 'Empty archive path is not allowed.' }
  }
  if (isAbsolute(raw) || posix.isAbsolute(raw) || win32.isAbsolute(raw)) {
    return { path: entry, reason: 'Absolute paths are not allowed.' }
  }
  if (/^[a-zA-Z]:[\\/]/.test(raw) || raw.startsWith('\\\\') || raw.startsWith('//')) {
    return { path: entry, reason: 'Drive or UNC paths are not allowed.' }
  }
  if (raw.includes(':')) {
    return { path: entry, reason: 'Alternate data streams and drive prefixes are not allowed.' }
  }
  const normalized = normalize(raw).replace(/\\/g, '/')
  if (normalized.startsWith('..') || normalized.split('/').includes('..')) {
    return { path: entry, reason: 'Parent-directory traversal is not allowed.' }
  }
  const segments = normalized.split('/').filter(Boolean)
  for (const segment of segments) {
    if (segment === '.' || segment === '..') {
      return { path: entry, reason: 'Parent-directory traversal is not allowed.' }
    }
    if (WINDOWS_DEVICE_PATTERN.test(segment)) {
      return { path: entry, reason: `Windows device name "${segment}" is not allowed.` }
    }
  }
  return undefined
}

export function toPosixRelative(path: string): string {
  return path.split(sep).join('/').replace(/\\/g, '/')
}
