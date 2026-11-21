import { lstat, readFile, realpath } from 'node:fs/promises'
import { basename, dirname, join, resolve, sep } from 'node:path'

/**
 * `folder`'s physical path, every link and junction on the way followed, as Git sees it. A folder that is not there
 * keeps its path: the walk up then finds what holds it, as Git would.
 */
export async function physicalPath(folder: string): Promise<string> {
  const path = resolve(folder)
  return realpath(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return path
    throw error
  })
}

/**
 * A folder's Git common directory worked out from its `.git` alone, reading only the folder's own volume: a `.git`
 * folder is the common directory; a linked worktree's `.git` file names `<common>/worktrees/<name>`. Null when no
 * `.git` is found up to the root (not a repository); undefined for anything else (a submodule's Git folder, a `.git`
 * that is a link, a folder inside a Git folder), which the caller asks Git about. Nothing on the common directory's
 * own volume is read, so a drive that stopped answering there holds nothing here. The walk starts from the folder's
 * physical path (`physicalPath`), as Git's does.
 */
export async function commonDirFromFiles(folder: string): Promise<string | null | undefined> {
  const start = await physicalPath(folder)
  if (start.split(sep).some((part) => part.toLowerCase() === '.git')) return undefined
  for (let dir = start; ; ) {
    const found = await lstat(join(dir, '.git')).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return undefined
      throw error
    })
    if (found?.isDirectory()) return join(dir, '.git')
    if (found?.isFile()) {
      const named = /^gitdir:\s*(.+?)\s*$/m.exec(await readFile(join(dir, '.git'), 'utf8'))?.[1]
      if (!named) return undefined
      const gitDir = resolve(dir, named)
      return basename(dirname(gitDir)) === 'worktrees' ? dirname(dirname(gitDir)) : undefined
    }
    if (found) return undefined
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}
