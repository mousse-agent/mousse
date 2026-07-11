import { resolve, relative, normalize } from 'path'

export function resolveWithinRoot(root: string, targetPath = ''): string {
  const resolvedRoot = resolve(root)
  const resolved = resolve(resolvedRoot, normalize(targetPath || '.'))
  const rel = relative(resolvedRoot, resolved)
  if (rel.startsWith('..') || resolve(resolved) !== resolved) {
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
