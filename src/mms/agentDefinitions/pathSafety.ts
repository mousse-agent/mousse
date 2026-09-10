import { existsSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, resolve, relative, sep } from 'node:path'
import { AgentDefinitionError } from '../../shared/agents/errors'
import { assertSafeBundlePath } from '../../shared/agents/pathSafety'

export function resolveWithinProfileRoot(profileRoot: string, ...segments: string[]): string {
  const resolvedRoot = resolve(profileRoot)
  const resolved = resolve(resolvedRoot, ...segments)
  const rel = relative(resolvedRoot, resolved)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) || resolve(resolved) !== resolved) {
    throw new AgentDefinitionError('PATH_ESCAPE', 'Resolved path escaped the injected profile root.', {
      details: { profileRoot: resolvedRoot }
    })
  }
  if (existsSync(resolvedRoot)) {
    const canonicalRoot = realpathSync(resolvedRoot)
    let existingAncestor = resolved
    while (!existsSync(existingAncestor) && existingAncestor !== resolvedRoot) {
      existingAncestor = dirname(existingAncestor)
    }
    const canonicalAncestor = realpathSync(existingAncestor)
    const canonicalRel = relative(canonicalRoot, canonicalAncestor)
    if (canonicalRel === '..' || canonicalRel.startsWith(`..${sep}`) || isAbsolute(canonicalRel)) {
      throw new AgentDefinitionError('PATH_ESCAPE', 'Resolved path traverses a link outside the injected profile root.', {
        details: { profileRoot: canonicalRoot }
      })
    }
  }
  return resolved
}

export function toPosixRelative(path: string): string {
  return assertSafeBundlePath(path.replaceAll(sep, '/'))
}
