import { existsSync, readlinkSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import type { PermissionAction } from '../../shared/permissionMode'
import { gitControlCache, type GitControlCache } from './gitControl'
import { isInsidePath } from './pathGuard'
import { realPathOrAncestor } from './realPath'
import { isGitName } from './routedGuard'

/** What an agent's file write is, for the permission mode. */
export type WriteClass =
  | { action: 'edit' }
  /** `gitFile`: the Git file it changes, as the approval names it. */
  | { action: 'command'; gitFile: string }

/** Where a write to `path` lands: the real path, following a link at the end even when its target is missing yet. */
function writeTarget(path: string): string | undefined {
  let current = path
  for (let hops = 0; hops < 40; hops++) {
    try {
      return realPathOrAncestor(current)
    } catch {
      // A link whose target does not exist yet: a write creates the target.
      try {
        current = resolve(dirname(current), readlinkSync(current))
      } catch {
        return undefined
      }
    }
  }
  return undefined
}

/** The folder itself, or its nearest ancestor that exists: Git reports nothing for a missing one. */
function nearestFolder(folder: string): string {
  let current = folder
  while (!existsSync(current) && dirname(current) !== current) current = dirname(current)
  return current
}

const namesGit = (path: string): boolean =>
  // Windows spellings (`GIT~1`, `.git.`) are matched on every system: asking about an odd name costs one question.
  path.split(/[\\/]+/).some((segment) => isGitName(segment, true))

/**
 * Whether an agent's write to `path` (absolute, or relative to `root`) changes Git's own files, judged on the path it
 * really lands on once links and aliases are resolved. Such a write is a `command` for the permission mode: Git runs
 * hooks and reads configuration from these files, and a write to `HEAD` or a ref moves a branch, so it is what a shell
 * command could do. It is:
 * - a path with a `.git` segment, as asked or as resolved (a worktree's `.git` file, a nested repository's folder);
 * - inside the Git folder or common folder of the repository around the root or around the target, whatever they are
 *   called;
 * - inside a folder `core.hooksPath` names, or a file Git includes as configuration.
 * Everything else is an `edit`, `.gitignore` and `.github/` included. Without a root a relative path is judged by its
 * name alone.
 */
export async function permissionActionForWrite(
  root: string | undefined,
  path: string,
  git: GitControlCache = gitControlCache
): Promise<WriteClass> {
  const base = root ? resolve(root) : undefined
  if (!base && !isAbsolute(path)) return namesGit(path) ? { action: 'command', gitFile: path } : { action: 'edit' }
  const asked = base ? resolve(base, path) : resolve(path)
  let realRoot: string | undefined
  try {
    realRoot = base && realPathOrAncestor(base)
  } catch {
    realRoot = undefined
  }
  const within = (target: string, folder: string | undefined): string => (folder && isInsidePath(target, folder) ? relative(folder, target) : target)
  const askedName = within(asked, base)
  const real = writeTarget(asked)
  // A path that cannot be resolved is asked about: where it lands is not known.
  if (!real) return { action: 'command', gitFile: askedName }
  const realName = within(real, realRoot)
  const command: WriteClass = { action: 'command', gitFile: realName === askedName ? realName : `${realName}, written as ${askedName}` }
  if (namesGit(askedName) || namesGit(realName)) return command
  const repositories = new Set([nearestFolder(dirname(real))])
  if (realRoot) repositories.add(realRoot)
  for (const repository of repositories) {
    await git.prepare(repository)
    const control = git.get(repository)
    // Unreadable settings: only the names above decide.
    if (!control || control instanceof Error) continue
    const places = [...control.gitFolders, ...control.hookFolders, ...control.configFiles]
    if (places.some((place) => isInsidePath(real, place))) return command
  }
  return { action: 'edit' }
}
