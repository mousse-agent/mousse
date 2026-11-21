import { lstat, readFile, stat } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { physicalPath } from './gitDirFiles'
import { IN_PROGRESS_GIT_MARKERS } from './gitMarkers'
import { runGitProcess } from './runGitProcess'
import { repoProgramEnv, withoutRepoProgramsAsync } from './repoPrograms'

/**
 * A folder's repository and the branch its HEAD is on, read from Git's own files instead of by running Git. On Windows
 * every Git process costs a third of a second to a second, and starting one holds the daemon's event loop, so a list of
 * a hundred threads that each asked Git for their branch froze the daemon. Reading `.git` and `HEAD` costs a few file
 * system calls.
 *
 * Git finds a repository by walking up from the folder to the first `.git`: a folder (a main checkout) or a file
 * naming the Git folder (`gitdir: ...`, a linked worktree or a submodule). Its `HEAD` names the branch
 * (`ref: refs/heads/<name>`) or a commit (detached). Layouts the reader does not know are left to Git: a `.git` that is
 * a link or names a missing folder, a `HEAD` naming anything else (a reftable repository's placeholder, for one), or a
 * folder inside a Git folder. Those answer `undefined`, and the caller asks Git.
 *
 * The walk starts from the folder's physical path: a link or junction into a repository's subfolder is in that
 * repository, as Git finds it.
 */
export type FolderHead =
  | { repo: false }
  | {
      repo: true
      /** The folder holding `.git`: the top of the checkout. */
      top: string
      /** This checkout's Git folder: a linked worktree's own, under the common one. */
      gitDir: string
      /** The Git folder shared by every worktree of the repository: config, refs, objects. */
      commonDir: string
      /** The branch HEAD is on, or null when HEAD names a commit (detached). */
      branch: string | null
      /** The commit a detached HEAD names. */
      commit?: string
    }

/** What a cached read depends on: each file's identity and size, and when it last changed. */
async function signature(path: string): Promise<string> {
  const found = await stat(path, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return undefined
    throw error
  })
  return found ? `${found.ino}:${found.size}:${found.mtimeNs}:${found.ctimeNs}` : '-'
}

/** The `.git` a folder holds: a folder, a file, something else (left to Git), or none. Other failures throw. */
async function dotGitKind(dir: string): Promise<'dir' | 'file' | 'other' | 'none'> {
  const found = await lstat(join(dir, '.git')).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return undefined
    throw error
  })
  if (!found) return 'none'
  return found.isDirectory() ? 'dir' : found.isFile() ? 'file' : 'other'
}

interface Layout { top: string; gitDir: string; commonDir: string }

/** Where `folder`'s repository is, without Git; `false` when there is none, undefined for a layout left to Git. */
async function findLayout(folder: string): Promise<Layout | false | undefined> {
  // Inside a Git folder Git answers differently (no work tree); leave it to Git.
  if (folder.split(sep).some((part) => part.toLowerCase() === '.git')) return undefined
  for (let dir = folder; ; ) {
    const kind = await dotGitKind(dir)
    if (kind === 'other') return undefined
    if (kind !== 'none') {
      let gitDir = join(dir, '.git')
      if (kind === 'file') {
        const named = /^gitdir:\s*(.+?)\s*$/m.exec(await readFile(gitDir, 'utf8'))
        if (!named) return undefined
        gitDir = resolve(dir, named[1]!)
      }
      const common = await readFile(join(gitDir, 'commondir'), 'utf8').then((text) => text.trim(), (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return ''
        throw error
      })
      return { top: dir, gitDir, commonDir: common ? resolve(gitDir, common) : gitDir }
    }
    const parent = dirname(dir)
    if (parent === dir) return false
    dir = parent
  }
}

/** The branch a `HEAD` file names, null for a commit, undefined for anything the reader leaves to Git. */
export function branchOfHeadFile(text: string): string | null | undefined {
  const line = text.trim()
  if (/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(line)) return null
  const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(line)?.[1]
  // A reftable repository keeps `refs/heads/.invalid` in HEAD and its refs elsewhere.
  if (!ref || ref === '.invalid') return undefined
  return ref
}

/** The last read of each folder, kept while the `.git` and `HEAD` it read have not changed. */
const cache = new Map<string, { layout: Layout; dotGit: string; head: string; branch: string | null; commit?: string }>()
/** At most this many folders are remembered; the oldest is dropped first. */
const CACHE_MAX = 2_000

/** How many `HEAD` files were read rather than answered from the cache; for tests. */
export let headFileReads = 0

/**
 * `folder`'s repository and branch from Git's files, or undefined for a layout left to Git (see {@link FolderHead}).
 * A `HEAD` read before is read again only when its signature changed. A folder that cannot be read throws.
 */
export async function readFolderHead(folder: string): Promise<FolderHead | undefined> {
  const key = await physicalPath(folder)
  const layout = await findLayout(key)
  if (layout === false) return { repo: false }
  if (!layout) return undefined
  const headPath = join(layout.gitDir, 'HEAD')
  const [dotGit, head] = await Promise.all([signature(join(layout.top, '.git')), signature(headPath)])
  const known = cache.get(key)
  if (known && known.dotGit === dotGit && known.head === head && known.layout.gitDir === layout.gitDir) {
    return { repo: true, ...layout, branch: known.branch, ...(known.commit ? { commit: known.commit } : {}) }
  }
  if (head === '-') return undefined
  headFileReads++
  const text = await readFile(headPath, 'utf8')
  const branch = branchOfHeadFile(text)
  if (branch === undefined) return undefined
  const commit = branch === null ? text.trim() : undefined
  // Read again after: a `HEAD` rewritten while it was read is not kept under the older signature.
  if (await signature(headPath) !== head) return readFolderHead(folder)
  cache.delete(key)
  cache.set(key, { layout, dotGit, head, branch, ...(commit ? { commit } : {}) })
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!)
  return { repo: true, ...layout, branch, ...(commit ? { commit } : {}) }
}

/** For tests: forget every folder read. */
export function clearFolderHeadCache(): void {
  cache.clear()
  headFileReads = 0
}

/**
 * Whether `folder` is in a repository and the branch it is on: from Git's files, or for a layout they cannot tell, from
 * one `git symbolic-ref`. A folder Git says is not in a repository answers `repo: false`; any other failure throws.
 */
export async function folderBranch(folder: string, options: { requireRoot?: boolean } = {}): Promise<{ repo: boolean; branch: string | null; detachedAt?: string }> {
  const head = await readFolderHead(folder)
  if (head) {
    if (!head.repo || (options.requireRoot && relative(head.top, await physicalPath(folder)) !== '')) return { repo: false, branch: null }
    return head.commit ? { repo: true, branch: null, detachedAt: head.commit.slice(0, 7) } : { repo: true, branch: head.branch }
  }
  if (options.requireRoot) {
    const argv = await withoutRepoProgramsAsync(folder, ['rev-parse', '--show-toplevel'])
    const top = await runGitProcess(argv, { cwd: folder, env: repoProgramEnv() })
    if (top.error) throw top.error
    if (top.status !== 0 || relative(await physicalPath(top.stdout.trim()), await physicalPath(folder)) !== '') return { repo: false, branch: null }
  }
  const argv = await withoutRepoProgramsAsync(folder, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
  const ran = await runGitProcess(argv, { cwd: folder, env: repoProgramEnv() })
  if (ran.error) throw ran.error
  if (ran.status === 0) return { repo: true, branch: ran.stdout.trim() || null }
  // Status 1: HEAD names a commit; which one is not asked (a second process).
  if (ran.status === 1) return { repo: true, branch: null, detachedAt: '' }
  if (/not a git repository/i.test(ran.stderr)) return { repo: false, branch: null }
  throw new Error(ran.stderr.trim() || `git symbolic-ref failed with exit code ${ran.status}`)
}

/** The merge, rebase, cherry-pick or revert a checkout's Git folder shows is stopped, read from its marker files. */
export async function inProgressMarkers(gitDir: string): Promise<Set<(typeof IN_PROGRESS_GIT_MARKERS)[number]>> {
  const found = await Promise.all(IN_PROGRESS_GIT_MARKERS.map((marker) => lstat(join(gitDir, marker)).then(() => marker, () => null)))
  return new Set(found.filter((marker) => marker !== null))
}
