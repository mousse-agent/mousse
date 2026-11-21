import { lstat, readFile, realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
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

async function readPathPointer(path: string, prefix = ''): Promise<string | undefined> {
  const line = (await text(path))?.replace(/[\r\n]+$/, '')
  if (!line?.startsWith(prefix)) return undefined
  const pointer = line.slice(prefix.length)
  return pointer && pointer === pointer.trim() && !/[\r\n\0]/.test(pointer) ? pointer : undefined
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

/** Read only ordinary files-based repositories. Git validates more formats and extensions than this reader handles. */
async function supportedConfig(gitDir: string, common: string): Promise<boolean> {
  const overrides = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CONFIG', 'GIT_CONFIG_PARAMETERS']
  if (overrides.some((key) => process.env[key]) || Number(process.env.GIT_CONFIG_COUNT || 0) !== 0) return false
  if (await present(join(gitDir, 'config.worktree'))) return false
  const config = await text(join(common, 'config'))
  if (config === undefined || /\0|\\\r?\n/.test(config)) return false
  let section: string | undefined
  for (const raw of config.split(/\r?\n/)) {
    let line = raw.replace(/^[\t ]+|[\t ]+$/g, '')
    if (line.startsWith('[')) {
      const header = /^\[([a-z][a-z0-9-]*)(?:\.[a-z0-9.-]+|[\t ]+"(?:[^"\\]|\\["\\])*")?[\t ]*\]/i.exec(line)
      if (!header) return false
      section = header[1]!.toLowerCase()
      if (['extensions', 'include', 'includeif'].includes(section)) return false
      line = line.slice(header[0].length).replace(/^[\t ]+/, '')
    }
    if (!line || /^[#;]/.test(line)) continue
    const entry = /^([a-z][a-z0-9-]*)[\t ]*(?:=((?:"(?:[^"\\]|\\[ntb"\\])*"|\\[ntb"\\]|[^"\\#;])*))?(?:[#;].*)?$/i.exec(line)
    if (!section || !entry) return false
    if (section !== 'core') continue
    const key = entry[1]!.toLowerCase()
    const value = entry[2]?.replace(/^[\t ]+|[\t ]+$/g, '')
    if (key === 'worktree' || (key === 'bare' && value !== 'false')) return false
    if (key === 'repositoryformatversion' && value !== '0' && value !== '1') return false
  }
  return true
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
 * The real paths and file identities of the checkout and both Git directories. Recreating any of the directories can
 * change which checkout is at the same path.
 */
export interface CheckoutIdentity {
  realPath: string
  gitDir: string
  gitDirId: string
  worktreeId: string
  commonDir: string
  commonDirId: string
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
    const [worktree, gitDirectory, commonDirectory, realPath] = await Promise.all([
      stat(top, { bigint: true }), stat(read.gitDir, { bigint: true }), stat(read.common, { bigint: true }), realpath(top)
    ])
    if (!worktree.ino || !gitDirectory.ino || !commonDirectory.ino) return undefined
    return {
      head: read.head, refs: values,
      identity: {
        realPath, gitDir: read.gitDir, commonDir: read.common,
        gitDirId: `${gitDirectory.dev}:${gitDirectory.ino}:${gitDirectory.birthtimeNs}`,
        worktreeId: `${worktree.dev}:${worktree.ino}:${worktree.birthtimeNs}`,
        commonDirId: `${commonDirectory.dev}:${commonDirectory.ino}:${commonDirectory.birthtimeNs}`
      }
    }
  } catch {
    return undefined
  }
}

async function readCheckout(top: string, options: { linkedOnly?: boolean }): Promise<{ head: WorktreeHead; gitDir: string; common: string } | undefined> {
  let gitDir: string, common: string
  try {
    const dotGit = join(top, '.git')
    const entry = await lstat(dotGit)
    if (entry.isDirectory() && !options.linkedOnly) {
      gitDir = common = await realpath(dotGit)
      if (await present(join(gitDir, 'commondir'))) return undefined
    } else if (entry.isFile()) {
      const pointer = await readPathPointer(dotGit, 'gitdir: ')
      if (!pointer) return undefined
      gitDir = await realpath(isAbsolute(pointer) ? pointer : resolve(top, pointer))
      const commonFile = join(gitDir, 'commondir')
      const backFile = join(gitDir, 'gitdir')
      if (!(await lstat(commonFile)).isFile() || !(await lstat(backFile)).isFile()) return undefined
      const commonPointer = await readPathPointer(commonFile)
      const back = await readPathPointer(backFile)
      if (!commonPointer || !back) return undefined
      common = await realpath(isAbsolute(commonPointer) ? commonPointer : resolve(gitDir, commonPointer))
      if (!samePath(dirname(gitDir), join(common, 'worktrees'))) return undefined
      const backlink = await realpath(isAbsolute(back) ? back : resolve(gitDir, back))
      if (!samePath(backlink, await realpath(dotGit))) return undefined
    } else {
      return undefined
    }
  } catch {
    return undefined
  }
  // The reftable format keeps refs in a binary table: only Git reads it.
  const [objects, refs, reftable, supported] = await Promise.all([
    isDirectory(join(common, 'objects')), isDirectory(join(common, 'refs')), present(join(common, 'reftable')), supportedConfig(gitDir, common)
  ])
  if (!objects || !refs || reftable || !supported) return undefined
  const head = (await text(join(gitDir, 'HEAD')))?.trim()
  if (!head) return undefined
  if (SHA.test(head)) return { head: { head }, gitDir, common }
  const ref = head.match(/^ref: (refs\/\S+)$/)?.[1]
  if (!ref) return undefined
  const value = await refValue(gitDir, common, ref)
  if (value === undefined) return undefined
  return { head: value === null ? { headRef: ref } : { head: value, headRef: ref }, gitDir, common }
}
