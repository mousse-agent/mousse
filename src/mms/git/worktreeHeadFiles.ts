import { readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { IN_PROGRESS_GIT_MARKERS } from './gitMarkers'

/**
 * Where a checkout's HEAD is, read from Git's own files instead of starting Git: a turn in a thread's own worktree
 * checks its worktree this way, so nothing waits for a Git process before the provider is called (each one costs
 * hundreds of milliseconds on Windows, and seconds on a hard disk that has to seek).
 *
 * Only the plain layout Git writes is read: a `.git` file (a linked worktree) or folder, its `HEAD`, the `commondir`
 * file, a loose ref or a `packed-refs` line. Anything else (the reftable format, a symbolic ref chain, a file that
 * cannot be read or does not look as Git writes it, configuration that can move the checkout elsewhere) answers
 * undefined, and the caller asks Git as before.
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
  const pointer = (await text(dotGit))?.trimEnd().match(/^gitdir: (.+)$/)?.[1]
  if (!pointer) return undefined
  return isAbsolute(pointer) ? pointer : resolve(top, pointer)
}

/** The value of `ref` as Git keeps it: its loose file, else its line in `packed-refs`; null when there is none. */
async function refValue(gitDir: string, common: string, ref: string): Promise<string | null | undefined> {
  if (!ref.startsWith('refs/') || ref.includes('..') || /[\\:\x00-\x20]/.test(ref)) return undefined
  try {
    const value = (await readFile(join(PER_WORKTREE.test(ref) ? gitDir : common, ...ref.split('/')), 'utf8')).trim()
    // A symbolic ref or anything unexpected is left to Git.
    return SHA.test(value) ? value : undefined
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return undefined
  }
  let packed: string
  try {
    packed = await readFile(join(common, 'packed-refs'), 'utf8')
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? null : undefined
  }
  for (const line of packed.split(/\r?\n/)) {
    if (!line || line.startsWith('#') || line.startsWith('^')) continue
    const space = line.indexOf(' ')
    if (line.slice(space + 1) !== ref) continue
    const value = line.slice(0, space)
    return SHA.test(value) ? value : undefined
  }
  return null
}

/**
 * Whether configuration Git would read can put the checkout somewhere other than the folder: `core.worktree` in the
 * worktree's own `config.worktree` (any such file at all is left to Git) or in the shared `config`, an `include` there
 * that could set it, or `GIT_DIR` / `GIT_WORK_TREE` in Mousse's own environment.
 */
async function mayRedirect(gitDir: string, common: string): Promise<boolean> {
  if (process.env.GIT_DIR || process.env.GIT_WORK_TREE || process.env.GIT_COMMON_DIR) return true
  for (let index = 0; index < Number(process.env.GIT_CONFIG_COUNT || 0); index++) {
    const key = process.env['GIT_CONFIG_KEY_' + index]?.toLowerCase()
    if (key === 'core.worktree' || key === 'core.bare' || key === 'extensions.refstorage' || key?.startsWith('include')) return true
  }
  if (await present(join(gitDir, 'config.worktree'))) return true
  const config = await text(join(common, 'config'))
  return config === undefined || /(?:^|\])[\t ]*worktree[\t ]*(?:=|[;#]|$)/im.test(config) || /^\s*\[\s*include/im.test(config)
}

/** Unreadable state is left to Git too. */
async function present(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ENOENT'
  }
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
  return (await readCheckout(top, options))?.head
}

/**
 * The real paths and file identities of the checkout and its Git directory. Recreating either folder can change which
 * checkout is at the same path.
 */
export interface CheckoutIdentity {
  realPath: string
  gitDir: string
  gitDirId: string
  worktreeId: string
}

/**
 * A linked worktree's HEAD, its physical identity (`CheckoutIdentity`), and the value of each of `refs` (null when there
 * is none), read from Git's files; undefined when Git must be asked (`readWorktreeHead`).
 */
export async function readLinkedCheckout(top: string, refs: readonly string[] = []): Promise<{ head: WorktreeHead; identity: CheckoutIdentity; refs: Map<string, string | null> } | undefined> {
  const read = await readCheckout(top, { linkedOnly: true })
  if (!read || (await Promise.all(IN_PROGRESS_GIT_MARKERS.map((marker) => present(join(read.gitDir, marker))))).some(Boolean)) return undefined
  const values = new Map<string, string | null>()
  for (const ref of refs) {
    const value = await refValue(read.gitDir, read.common, ref)
    if (value === undefined) return undefined
    values.set(ref, value)
  }
  try {
    const [worktree, gitDirectory, realPath, gitDir] = await Promise.all([
      stat(top, { bigint: true }), stat(read.gitDir, { bigint: true }), realpath(top), realpath(read.gitDir)
    ])
    if (!worktree.ino || !gitDirectory.ino) return undefined
    return {
      head: read.head, refs: values,
      identity: {
        realPath, gitDir,
        gitDirId: `${gitDirectory.dev}:${gitDirectory.ino}:${gitDirectory.birthtimeNs}`,
        worktreeId: `${worktree.dev}:${worktree.ino}:${worktree.birthtimeNs}`
      }
    }
  } catch {
    return undefined
  }
}

async function readCheckout(top: string, options: { linkedOnly?: boolean }): Promise<{ head: WorktreeHead; gitDir: string; common: string } | undefined> {
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
  if (await mayRedirect(gitDir, common)) return undefined
  const head = (await text(join(gitDir, 'HEAD')))?.trim()
  if (!head) return undefined
  if (SHA.test(head)) return { head: { head }, gitDir, common }
  const ref = head.match(/^ref: (refs\/\S+)$/)?.[1]
  if (!ref) return undefined
  const value = await refValue(gitDir, common, ref)
  if (value === undefined) return undefined
  return { head: value === null ? { headRef: ref } : { head: value, headRef: ref }, gitDir, common }
}
