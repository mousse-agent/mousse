import { resolve, relative, sep } from 'node:path'
import { AgentDefinitionError } from '../../shared/agents/errors'
import { assertSafeBundlePath } from '../../shared/agents/pathSafety'

export function resolveWithinProfileRoot(profileRoot: string, ...segments: string[]): string {
  const resolvedRoot = resolve(profileRoot)
  const resolved = resolve(resolvedRoot, ...segments)
  const rel = relative(resolvedRoot, resolved)
  if (rel.startsWith('..') || resolve(resolved) !== resolved) {
    throw new AgentDefinitionError('PATH_ESCAPE', 'Resolved path escaped the injected profile root.', {
      details: { profileRoot: resolvedRoot }
    })
  }
  return resolved
}

export function toPosixRelative(path: string): string {
  return assertSafeBundlePath(path.replaceAll(sep, '/'))
}
