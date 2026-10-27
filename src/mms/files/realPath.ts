import { lstatSync, realpathSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

export type PathRefusal = 'path_outside_folder' | 'path_protected' | 'path_needs_full_access'

/** A path another computer may not read or change. `code` says which kind of refusal it is. */
export class PathContainmentError extends Error {
  constructor(
    readonly code: PathRefusal,
    message: string
  ) {
    super(message)
    this.name = 'PathContainmentError'
  }
}

export const OUTSIDE = 'Path is outside the project root'
export const outside = (message = OUTSIDE): PathContainmentError =>
  new PathContainmentError('path_outside_folder', message)
export const protectedPath = (message: string): PathContainmentError =>
  new PathContainmentError('path_protected', message)

/**
 * The real path of `path`, or of its deepest existing folder with the part that does not exist yet
 * after it. A link that leads nowhere is refused: writing through it would create what it points at.
 */
export function realPathOrAncestor(path: string): string {
  const missing: string[] = []
  let current = resolve(path)
  for (;;) {
    try {
      const real = realpathSync.native(current)
      return missing.length ? join(real, ...missing) : real
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR')
        throw outside(`That path cannot be checked (${code ?? 'unknown error'}).`)
    }
    try {
      lstatSync(current)
      // It exists but does not resolve: a link whose target is missing.
      throw outside('That path is a link that leads nowhere.')
    } catch (error) {
      if (error instanceof PathContainmentError) throw error
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR')
        throw outside(`That path cannot be checked (${code ?? 'unknown error'}).`)
    }
    const parent = dirname(current)
    if (parent === current) throw outside('That path cannot be checked.')
    missing.unshift(basename(current))
    current = parent
  }
}
