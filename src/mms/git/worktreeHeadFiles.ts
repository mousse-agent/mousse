import { readFile, stat } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'

/**
 * Where a checkout's HEAD is, read from Git's own files instead of starting Git: a turn in a thread's own worktree
 * checks its worktree this way, so nothing waits for a Git process before the provider is called (each one costs
 * hundreds of milliseconds on Windows, and seconds on a hard disk that has to seek).
 *
 * Only the plain layout Git writes is read: a `.git` file (a linked worktree) or folder, its `HEAD`, the `commondir`
 * file, a loose ref or a `packed-refs` line. Anything else (the reftable format, a symbolic ref chain, a file that
 * cannot be read or does not look as Git writes it) answers undefined, and the caller asks Git as before.
 */
export interface WorktreeHead {
  /** The commit HEAD is on; undefined while its branch has no commit yet. */
  head?: string
  /** The full ref HEAD is on (`refs/heads/main`); undefined when HEAD is detached. */
  headRef?: string
}

const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/
/** Refs each worktree keeps in its own Git folder; every other ref is in the shared one. */
const PER_WORKTREE = /^refs\/(?:bisect|worktree|rewritten)\//

async function text(path: string): Promise<string | undefined> {
  try { return await readFile(path, 'utf8') } catch { return undefined }
}

async function isDirectory(path: string): Promise<boolean> {
  try { return (await stat(path)).isDirectory() } catch { return false }
}

/** The checkout's Git folder: the `.git` folder, or the one a linked worktree's `.git` file names. */
async function gitDirOf(top: string): Promise<string | undefined> {
  const dotGit = join(top, '.git')
  if (await isDirectory(dotGit)) return dotGit
  const pointer = (await text(dotGit))?.match(/^gitdir: (.+?)\s*$/m)?.[1]
  if (!pointer) return undefined
  return isAbsolute(pointer) ? pointer : resolve(top, pointer)
}

/** The value of `ref` as Git keeps it: its loose file, else its line in `packed-refs`; null when there is none. */
async function refValue(gitDir: string, common: string, ref: string): Promise<string | null | undefined> {
  if (!ref.startsWith('refs/') || ref.includes('..')) return undefined
  const loose = await text(join(PER_WORKTREE.test(ref) ? gitDir : common, ...ref.split('/')))
  if (loose !== undefined) {
    const value = loose.trim()
    // A symbolic ref (`ref: …`) or anything unexpected is left to Git.
    return SHA.test(value) ? value : undefined
  }
  const packed = await text(join(common, 'packed-refs'))
  if (packed === undefined) return null
  for (const line of packed.split(/\r?\n/)) {
    if (!line || line.startsWith('#') || line.startsWith('^')) continue
    const space = line.indexOf(' ')
    if (line.slice(space + 1) !== ref) continue
    const value = line.slice(0, space)
    return SHA.test(value) ? value : undefined
  }
  return null
}

const samePath = (a: string, b: string): boolean => {
  const norm = (path: string) => resolve(path).replace(/[\\/]+$/, '')
  return process.platform === 'win32' ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b)
}

/**
 * HEAD of the checkout at `top` (its top folder), read from Git's files; undefined when Git must be asked. With
 * `linkedOnly`, only a linked worktree is read: its `.git` is a file, and the Git folder it names links back to it (Git's
 * own `gitdir` file there). A `.git` folder (someone ran `git init` in an emptied worktree) or a link elsewhere asks Git.
 */
export async function readWorktreeHead(top: string, options: { linkedOnly?: boolean } = {}): Promise<WorktreeHead | undefined> {
  if (options.linkedOnly && await isDirectory(join(top, '.git'))) return undefined
  const gitDir = await gitDirOf(top)
  if (!gitDir) return undefined
  if (options.linkedOnly) {
    const back = (await text(join(gitDir, 'gitdir')))?.trim()
    if (!back || !samePath(isAbsolute(back) ? back : resolve(gitDir, back), join(top, '.git'))) return undefined
  }
  const commonPointer = (await text(join(gitDir, 'commondir')))?.trim()
  const common = commonPointer ? (isAbsolute(commonPointer) ? commonPointer : resolve(gitDir, commonPointer)) : gitDir
  // The reftable format keeps refs in a binary table: only Git reads it.
  if (await isDirectory(join(common, 'reftable'))) return undefined
  const head = (await text(join(gitDir, 'HEAD')))?.trim()
  if (!head) return undefined
  if (SHA.test(head)) return { head }
  const ref = head.match(/^ref: (refs\/\S+)$/)?.[1]
  if (!ref) return undefined
  const value = await refValue(gitDir, common, ref)
  if (value === undefined) return undefined
  return value === null ? { headRef: ref } : { head: value, headRef: ref }
}
