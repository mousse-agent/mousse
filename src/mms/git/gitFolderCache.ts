import { lstatSync, readFileSync, realpathSync, type BigIntStats } from 'node:fs'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { step, type Steps } from '../actions/steps'

/**
 * The Git folder of a checkout, as `git rev-parse --absolute-git-dir` answers it, remembered between Git checks.
 *
 * The central Git check asks for it for every command on one of Mousse's private index files, and each answer is a Git
 * process. This cache keeps a successful answer with what it rested on, and checks that again on every use with a few
 * `lstat`s:
 * - for each folder from `cwd` up to where `.git` was found, whether `<folder>/.git` is absent, a folder or a file;
 * - a `.git` folder by device, inode and type only: Mousse making an index in it changes its times;
 * - a `.git` file by its full signature, its text and the real path of the folder it names;
 * - the Git folder's own device, inode and type.
 *
 * Anything else, or any doubt, reads again: a `.git` that is a link, a `.git` file whose target goes through a link (a
 * link repointed later changes Git's answer while every `lstat` stays the same), a Git folder found without a `.git`
 * (a bare repository), a `GIT_DIR` with `..` in it or naming a file, and a state that changed while Git read it. Only
 * successful answers are kept.
 *
 * What a stale answer could do: accept one of Mousse's own index files in a Git folder the checkout no longer uses.
 * The checkout's own `index` is never accepted (see `isOwnedIndex`).
 */

/** What `git` printed, or null when it could not be run. */
export type GitFolderRead = { status: number | null; stdout: string } | null

const LIMIT = 256

interface Entry {
  answer: GitFolderRead
  /** {@link routeOf} when the answer was read. */
  route: string
  /** {@link folderOf} the answer. */
  folder: string
}

/** Every place Git's answer rests on, as text to compare, and the real path of the Git folder it leads to. */
interface Route { seen: string; leadsTo: string }

const cache = new Map<string, Entry>()

/** Forgets every answer. For tests. */
export function clearGitFolderCache(): void {
  cache.clear()
}

/**
 * `read` (one `rev-parse --absolute-git-dir` in `cwd`, `gitDir` named as `GIT_DIR` when set), answered from the cache
 * while what it rests on is unchanged. `routing` is every variable that could send Git elsewhere, as the caller set it.
 */
export function* cachedGitFolder(cwd: string, gitDir: string | undefined, routing: string, read: Steps<GitFolderRead>): Steps<GitFolderRead> {
  const real = yield* realpathOf(cwd)
  if (real === null) return yield* read
  const key = `${real}\0${gitDir ?? ''}\0${routing}`
  const before = yield* routeOf(real, gitDir)
  const kept = cache.get(key)
  if (kept) {
    cache.delete(key)
    if (before?.seen === kept.route && (yield* folderOf(kept.answer!.stdout.trim()))?.seen === kept.folder) {
      cache.set(key, kept)
      return kept.answer
    }
  }
  const answer = yield* read
  if (before === null || !answer || answer.status !== 0) return answer
  const found = answer.stdout.trim()
  const folder = yield* folderOf(found)
  const after = yield* routeOf(real, gitDir)
  // Kept only when nothing moved while Git read, and what the walk found is the folder Git named.
  if (folder === null || after === null || after.seen !== before.seen || after.leadsTo !== folder.leadsTo) return answer
  cache.set(key, { answer, route: after.seen, folder: folder.seen })
  if (cache.size > LIMIT) cache.delete(cache.keys().next().value!)
  return answer
}

/** Device, inode and type, which stay the same while files inside change. */
const identity = (stats: BigIntStats): string => `${stats.dev}:${stats.ino}:${stats.mode & 0o170000n}`
const signature = (stats: BigIntStats): string => `${identity(stats)}:${stats.mode}:${stats.size}:${stats.mtimeNs}:${stats.ctimeNs}`

/** The real path and identity of the Git folder Git named, or null when it is not a folder there. */
function* folderOf(path: string): Steps<Route | null> {
  if (!isAbsolute(path)) return null
  const real = yield* realpathOf(path)
  if (real === null) return null
  const stats = yield* lstatOf(real)
  return stats && stats !== 'absent' && stats.isDirectory() ? { seen: JSON.stringify([real, identity(stats)]), leadsTo: real } : null
}

/**
 * Everything Git's answer rests on, and the Git folder it leads to, or null when that cannot be told for sure. With
 * `gitDir`, Git looks nowhere else.
 */
function* routeOf(real: string, gitDir: string | undefined): Steps<Route | null> {
  if (gitDir !== undefined) {
    if (gitDir.split(/[\\/]/).includes('..')) return null
    const named = yield* realpathOf(resolve(real, gitDir))
    if (named === null) return null
    const stats = yield* lstatOf(named)
    return stats && stats !== 'absent' && stats.isDirectory() ? { seen: JSON.stringify(['dir', named, identity(stats)]), leadsTo: named } : null
  }
  const seen: string[][] = []
  for (let folder = real; ; folder = dirname(folder)) {
    const dotGit = join(folder, '.git')
    const stats = yield* lstatOf(dotGit)
    if (stats === null) return null
    if (stats === 'absent') {
      seen.push(['absent', dotGit])
      // No `.git` up to the top: a bare repository, or the folder is a Git folder itself. Read every time.
      if (dirname(folder) === folder) return null
      continue
    }
    if (stats.isDirectory()) return { seen: JSON.stringify([...seen, ['dir', dotGit, identity(stats)]]), leadsTo: dotGit }
    if (!stats.isFile()) return null
    const text = yield* readTextOf(dotGit)
    const match = text === null ? null : /^gitdir: (.+?)\r?\n?$/.exec(text)
    if (!match) return null
    const target = resolve(folder, match[1]!)
    const targetReal = yield* realpathOf(target)
    // A link anywhere in the target can be repointed with every `lstat` here unchanged.
    if (targetReal === null || !samePath(targetReal, target)) return null
    return { seen: JSON.stringify([...seen, ['file', dotGit, signature(stats), match[1]!, targetReal]]), leadsTo: targetReal }
  }
}

/** `a` and `b` spelled the same, trailing separator aside. */
function samePath(a: string, b: string): boolean {
  const trim = (path: string): string => (path.length > 1 && path.endsWith(sep) ? path.slice(0, -1) : path)
  return trim(a) === trim(b)
}

function* realpathOf(path: string): Steps<string | null> {
  return yield* step(() => { try { return realpathSync.native(path) } catch { return null } }, () => realpath(path).catch(() => null))
}

/** `lstat` with nanosecond times; `absent` when nothing is there, null when it cannot be read. */
function* lstatOf(path: string): Steps<BigIntStats | 'absent' | null> {
  const failed = (error: unknown): 'absent' | null => ((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : null)
  return yield* step(() => { try { return lstatSync(path, { bigint: true }) } catch (error) { return failed(error) } }, () => lstat(path, { bigint: true }).catch(failed))
}

function* readTextOf(path: string): Steps<string | null> {
  return yield* step(() => { try { return readFileSync(path, 'utf8') } catch { return null } }, () => readFile(path, 'utf8').catch(() => null))
}
