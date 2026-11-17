import { lstat, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, posix, relative, sep, win32 } from 'node:path'
import type { ReviewFileResult } from '../../shared/review'
import type { TurnFileResult } from '../../shared/turnFiles'
import { waitForFolderAccess } from '../files/folderAccess'
import { checkRepoPrograms, guardedSimpleGit } from './repoPrograms'
import { readFileVersions } from './reviewDiff'

/**
 * The absolute path of `path` as an agent wrote it: as given when absolute, else inside the thread's `folder`. Null
 * for a relative path of a thread with no folder.
 */
export function turnFilePath(path: string, folder: string | null, platform: NodeJS.Platform = process.platform): string | null {
  const paths = platform === 'win32' ? win32 : posix
  if (paths.isAbsolute(path)) return paths.resolve(path)
  return folder ? paths.resolve(folder, path) : null
}

/** Whether one of `written` (the thread's written paths, as `writtenFilePaths` gives them) is `target`. */
export function threadWroteFile(written: readonly string[], target: string, folder: string | null, platform: NodeJS.Platform = process.platform): boolean {
  const key = (path: string) => (platform === 'win32' ? path.toLowerCase() : path)
  const wanted = key(target)
  return written.some((path) => {
    const resolved = turnFilePath(path, folder, platform)
    return resolved !== null && key(resolved) === wanted
  })
}

/**
 * Where a file a thread's agent wrote stands, read without changing anything (`review.turnFile`). `path` is absolute;
 * the caller has already checked that the thread's Edit or Write calls name it.
 *
 * The file's own repository is found from its folder, so a file outside the thread's folder is compared with the
 * last commit of whatever repository holds it. Its Git commands run with the repository's programs turned off, as
 * every Git command Mousse runs does (`repoPrograms`). Anything Git cannot answer leaves the file `plain`.
 */
export async function locateTurnFile(path: string): Promise<TurnFileResult> {
  // A drive that stopped answering fails the call at once instead of hanging the daemon on the stat.
  await waitForFolderAccess([dirname(path)])
  try {
    const entry = await lstat(path)
    if (!entry.isFile() && !entry.isSymbolicLink()) return { kind: 'plain', path }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') return { kind: 'missing', path }
    throw error
  }
  try {
    const version = await changedVersion(path)
    return version ? { kind: 'diff', path, version } : { kind: 'plain', path }
  } catch {
    return { kind: 'plain', path }
  }
}

async function changedVersion(path: string): Promise<ReviewFileResult | null> {
  const folder = dirname(path)
  await checkRepoPrograms(folder)
  const top = (await guardedSimpleGit(folder).raw(['rev-parse', '--show-toplevel'])).trim()
  if (!top) return null
  // Both sides through their real paths: a link in either (macOS's /tmp, a Windows junction) must not move the file outside.
  const root = await realpath(top)
  const relativePath = relative(root, join(await realpath(folder), basename(path)))
  if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) return null
  const gitPath = relativePath.split(sep).join('/')
  if (root !== top) await checkRepoPrograms(root)
  const git = guardedSimpleGit(root)
  // `!!` is an ignored file, nothing at all is a file that matches the last commit: neither has a change to show.
  const status = await git.raw(['status', '--porcelain=v1', '-z', '--ignored=matching', '--untracked-files=all', '--ignore-submodules=all', '--', `:(literal)${gitPath}`])
  if (!status || status.startsWith('!!')) return null
  const head = (await git.raw(['rev-parse', '--verify', '--quiet', 'HEAD']).catch(() => '')).trim()
  return await readFileVersions(root, { from: head ? { kind: 'commit', sha: head } : null, to: { kind: 'worktree' } }, gitPath)
}
