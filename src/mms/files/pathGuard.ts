import { isAbsolute, resolve, relative, normalize } from 'path'

export function resolveWithinRoot(root: string, targetPath = ''): string {
  const resolvedRoot = resolve(root)
  const resolved = resolve(resolvedRoot, normalize(targetPath || '.'))
  const rel = relative(resolvedRoot, resolved)
  // On Windows a path on another drive or share has no relative form, so
  // `relative` returns it absolute instead of starting with `..`.
  if (rel.startsWith('..') || isAbsolute(rel) || resolve(resolved) !== resolved) {
    throw new Error('Path is outside the project root')
  }
  return resolved
}

export const SKIP_DIR_NAMES = new Set([
  'node_modules',
  '.git',
  'dist',
  'out',
  '.mousse-worktrees'
])
