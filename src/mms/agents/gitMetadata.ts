import { realpathSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'

/**
 * Git metadata is never an agent file tool's to change (PR 4 §6, #309): a definition's or a bot's
 * write, edit, create, rename or delete of a path inside a `.git` folder, or of a `.git` file, is
 * refused wherever it is. With scripts off this keeps the repository's own settings, hooks, object
 * store and worktree records out of the agent's reach, so what the git tools read is the user's.
 * (With scripts on the agent runs commands itself; nothing here is a sandbox for that.)
 */

/** A path component that names Git metadata: `.git`, any case, as Windows also opens `.git.`, `.git ` and `.git::$DATA`. */
function isGitComponent(component: string): boolean {
  const name = process.platform === 'win32' ? component.replace(/:.*$/, '').replace(/[. ]+$/, '') : component
  return name.toLowerCase() === '.git'
}

/** The real path of `path`: its nearest existing parent's real path (links, 8.3 names), and the rest. */
function realPath(path: string): string {
  const missing: string[] = []
  let current = path
  for (;;) {
    try {
      return join(realpathSync.native(current), ...missing.reverse())
    } catch {
      const parent = dirname(current)
      if (parent === current) return path
      missing.push(basename(current))
      current = parent
    }
  }
}

const components = (path: string): string[] => path.split(/[\\/]+/).filter(Boolean)

/**
 * Whether `target` (resolved against `base`) is, or is inside, Git metadata: any component of its
 * path, as written or as its real path through links, is `.git`.
 */
export function touchesGitMetadata(target: string, base: string): boolean {
  const absolute = resolve(base, target)
  return components(absolute).some(isGitComponent) || components(realPath(absolute)).some(isGitComponent)
}

/** The refusal an agent's file tool gets for Git metadata. */
export function gitMetadataRefusal(path: string): string {
  return `An agent's file tools cannot change Git metadata (a .git folder or file): ${path.split(sep).join('/')}`
}
