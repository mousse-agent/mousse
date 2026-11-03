import { realpath as realpathCallback } from 'node:fs'
import { lstat, readFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'

/** `realpathSync` without blocking, spelled as `RepositoryIdentity` spells common directories, so keys made from it agree. */
const realpathLike = promisify(realpathCallback)

/**
 * The real path of `path`: links and aliases resolved (`/tmp` is `/private/tmp` on macOS), through the nearest folder
 * that exists, with the rest of the path kept as written. Reads without blocking.
 */
export async function canonicalPathAsync(path: string): Promise<string> {
  const rest: string[] = []
  for (let current = resolve(path); ;) {
    try { return join(await realpathLike(current), ...rest) }
    catch {
      const parent = dirname(current)
      if (parent === current) return resolve(path)
      rest.unshift(basename(current)); current = parent
    }
  }
}

/**
 * A real path in the form two of them are compared in. macOS and Windows volumes ignore case (and macOS Unicode
 * normalization) by default, so there it is folded; on a case-sensitive volume there that only makes more paths overlap.
 */
export function comparablePath(path: string): string {
  return process.platform === 'darwin' || process.platform === 'win32' ? path.normalize('NFC').toLowerCase() : path
}

/** Whether two real paths ({@link canonicalPathAsync}) are the same, or one is inside the other. */
export function pathsOverlap(left: string, right: string): boolean {
  const a = comparablePath(left), b = comparablePath(right)
  const inside = (root: string, path: string) => { const rel = relative(root, path); return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`) }
  return inside(a, b) || inside(b, a)
}

/**
 * The real path of the Git common directory a checkout points at now, from its own `.git` alone: a folder is a primary
 * checkout's; a file names the worktree's Git folder, whose `commondir` (or, when that folder is gone, its place under
 * `<common>/worktrees/`) gives the repository it belongs to, even one that was moved or deleted. Git is not run, so
 * nothing walks up into a parent repository. Undefined when the checkout has no `.git` or it can't be read.
 */
export async function gitCommonDirAsync(checkout: string): Promise<string | undefined> {
  try {
    const dotGit = join(checkout, '.git')
    const info = await lstat(dotGit)
    if (info.isDirectory()) return await canonicalPathAsync(dotGit)
    if (!info.isFile() || info.size > 4096) return undefined
    const line = (await readFile(dotGit, 'utf8')).split(/\r?\n/).find((entry) => entry.startsWith('gitdir:'))
    if (!line) return undefined
    const gitDir = resolve(checkout, line.slice('gitdir:'.length).trim())
    let common: string
    try { common = resolve(gitDir, (await readFile(join(gitDir, 'commondir'), 'utf8')).trim()) }
    // No `commondir`: a linked worktree whose Git folder is gone, or a checkout whose Git folder is kept elsewhere.
    catch { common = basename(dirname(gitDir)) === 'worktrees' ? dirname(dirname(gitDir)) : gitDir }
    return await canonicalPathAsync(common)
  } catch { return undefined }
}
